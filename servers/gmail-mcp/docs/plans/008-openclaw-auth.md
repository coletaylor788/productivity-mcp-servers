# Plan 008: Add Environment Variable Auth Backend + Linux Support

**Status:** Complete (2026-03-16)  
**Created:** 2026-03-15

## Problem

The Gmail MCP server currently stores Google OAuth refresh tokens in macOS Keychain via the `keyring` library. This doesn't work in the target production environment: a Linux Azure Container App where secrets are injected as environment variables by Azure Key Vault.

**Current state:**
- Token storage: macOS Keychain only (`keyring` library)
- Platform: macOS only

**Target state:**
- Token storage: **Keychain (macOS) or env var (Linux/Azure)** — selected automatically
- Platform: macOS + Linux Azure Container App
- Architecture: trusted box (OpenClaw + gmail-mcp + secrets) separate from sandboxed agent exec

## Approach

Add an environment variable backend alongside the existing macOS Keychain. Backend is selected automatically:

- **Env var** — when `GOOGLE_MCP_TOKEN` is set (Azure Key Vault injects it)
- **Keychain** — when env var is not set (macOS local development, existing behavior)

No new runtime dependencies. No Azure SDK. Just read an env var.

### Architecture (Azure — trusted box)

```
┌─────────────────────────────────────────────────────┐
│ Trusted Box (OpenClaw + MCP tools + secrets)        │
│                                                     │
│  Key Vault ──env var──▶ gmail-mcp ──▶ Gmail API     │
│                         (reads GOOGLE_MCP_TOKEN)
│  OpenClaw ──stdio──▶ gmail-mcp                      │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ Sandbox (agent execution — no secrets)              │
└─────────────────────────────────────────────────────┘
```

### Architecture (macOS — unchanged)

```
Claude ──stdio──▶ gmail-mcp ──keyring──▶ Keychain ──▶ Gmail API
```

### What changes and what doesn't

| Component | Changes? | Details |
|-----------|----------|---------|
| `server.py` (tool logic) | No | All tool handlers unchanged |
| `auth.py` (token storage) | Yes | Add env var backend + backend selection |
| `config.py` | Yes | Add env var constant |
| `__main__.py` | No | Entry point unchanged |
| `pyproject.toml` | No | No new runtime dependencies |
| Tests | Yes | Add env var backend tests; existing Keychain tests unchanged |

## Implementation Details

### 1. Dependencies

**No changes to runtime dependencies.** The env var backend uses only stdlib (`os`, `json`).

`google-auth-oauthlib` is already a dependency (needed by the seed script for the OAuth flow).

### 2. Config changes (`config.py`)

Add one constant:

```python
# Existing (unchanged)
KEYCHAIN_SERVICE = "gmail-mcp"

# New — env var for token injection
GOOGLE_TOKEN_ENV = "GOOGLE_MCP_TOKEN"
```

### 3. Auth module changes (`auth.py`)

Add env var backend. Existing Keychain code renamed to `_keychain_*` but otherwise untouched.

**Backend selection:**

```python
def _use_env_backend() -> bool:
    return os.environ.get(GOOGLE_TOKEN_ENV) is not None
```

**Env var backend functions:**

```python
_cached_creds: Credentials | None = None

def _env_load_credentials() -> None:
    """Parse credentials from env var into memory. Called once on first access."""
    global _cached_creds
    token_json = os.environ.get(GOOGLE_TOKEN_ENV)
    if not token_json:
        return
    token_info = json.loads(token_json)
    _cached_creds = Credentials.from_authorized_user_info(token_info, SCOPES)

def _env_is_authenticated() -> bool:
    if _cached_creds is None:
        try:
            _env_load_credentials()
        except Exception:
            return False
    return _cached_creds is not None

def _env_get_token() -> Credentials | None:
    if _cached_creds is None:
        _env_load_credentials()
    if _cached_creds and _cached_creds.expired and _cached_creds.refresh_token:
        _cached_creds.refresh(Request())
    return _cached_creds
```

**Public API delegates:**

```python
def is_authenticated() -> bool:
    if _use_env_backend():
        return _env_is_authenticated()
    return _keychain_is_authenticated()

def get_token() -> Credentials | None:
    if _use_env_backend():
        return _env_get_token()
    return _keychain_get_token()

def store_token(creds: Credentials) -> None:
    if _use_env_backend():
        return  # env var is read-only; token was seeded externally
    _keychain_store_token(creds)
```

**Env var value format** — same JSON that `Credentials.to_json()` produces:

```json
{
  "token": "<access_token>",
  "refresh_token": "<refresh_token>",
  "token_uri": "https://oauth2.googleapis.com/token",
  "client_id": "<client_id>",
  "client_secret": "<client_secret>",
  "scopes": ["https://www.googleapis.com/auth/gmail.modify", "..."]
}
```

This includes the Google OAuth app identity (client_id/client_secret), so no separate `credentials.json` file is needed at runtime.

### 4. Seed script (`scripts/seed_keyvault.py`)

One command to run the Google OAuth flow and push the token to Key Vault via `az` CLI:

```bash
python -m gmail_mcp.scripts.seed_keyvault \
  --vault-name my-vault \
  --credentials ~/path/to/credentials.json
```

The script:
1. Runs `InstalledAppFlow.from_client_secrets_file()` (opens browser for Google consent)
2. Gets the refresh token + client identity from Google
3. Calls `az keyvault secret set` to store the token JSON in Key Vault
4. Prints confirmation

```python
"""One-time script to seed Google OAuth token into Azure Key Vault."""

import argparse
import subprocess
import sys

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
]
SECRET_NAME = "google-mcp-token"


def main():
    parser = argparse.ArgumentParser(description="Seed Google OAuth token into Azure Key Vault")
    parser.add_argument("--vault-name", required=True, help="Azure Key Vault name")
    parser.add_argument("--credentials", required=True, help="Path to Google OAuth credentials.json")
    parser.add_argument("--secret-name", default=SECRET_NAME, help="Key Vault secret name")
    args = parser.parse_args()

    # Run Google OAuth flow (opens browser)
    flow = InstalledAppFlow.from_client_secrets_file(args.credentials, SCOPES)
    creds = flow.run_local_server(port=0)
    token_json = creds.to_json()

    # Store in Key Vault via az CLI
    result = subprocess.run(
        ["az", "keyvault", "secret", "set",
         "--vault-name", args.vault_name,
         "--name", args.secret_name,
         "--value", token_json],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"Error storing secret: {result.stderr}", file=sys.stderr)
        sys.exit(1)

    print(f"✓ Token stored in Key Vault '{args.vault_name}' as '{args.secret_name}'")


if __name__ == "__main__":
    main()
```

**When to re-run:** Google password change, app access revoked, scopes changed, or token unused for 6+ months.

### 5. Azure Container App configuration

The secret flows through three layers with explicit naming at each:

```
Key Vault secret         →  Container App secret  →  Env var
"google-mcp-token"          "google-mcp-token"        GOOGLE_MCP_TOKEN
(seed script creates)       (secretref to KV URL)     (your app reads)
```

**Container App secrets definition (Bicep/ARM):**

```json
"secrets": [
  {
    "name": "google-mcp-token",
    "keyVaultUrl": "https://<your-vault>.vault.azure.net/secrets/google-mcp-token",
    "identity": "system"
  }
]
```

**Container env var mapping:**

```json
"env": [
  {
    "name": "GOOGLE_MCP_TOKEN",
    "secretRef": "google-mcp-token"
  }
]
```

The seed script defaults to `google-mcp-token` as the Key Vault secret name so all three layers align without extra config.

### 6. OpenClaw configuration

```json
{
  "plugins": {
    "entries": {
      "mcp-integration": {
        "config": {
          "servers": {
            "gmail-mcp": {
              "enabled": true,
              "transport": "stdio",
              "command": "python",
              "args": ["-m", "gmail_mcp"]
            }
          }
        }
      }
    }
  }
}
```

`GOOGLE_MCP_TOKEN` is already present on the trusted box (injected by Key Vault). No need to pass it in the OpenClaw config.

### 7. Security considerations

- **Secrets stay on trusted box** — agent exec runs in a separate sandbox with no access to secrets
- **Env var injected by Key Vault** — not hardcoded, rotatable via Azure
- **In-memory only at runtime** — parsed once from env var, cached in process memory
- **Read-only** — env backend doesn't write back; token seeded externally via seed script
- **Keychain unchanged on macOS** — encrypted at rest, existing security model preserved

## File Structure (new/modified)

```
servers/gmail-mcp/
├── src/gmail_mcp/
│   ├── __init__.py          (unchanged)
│   ├── __main__.py          (unchanged)
│   ├── config.py            (MODIFIED — add GOOGLE_TOKEN_ENV constant)
│   ├── auth.py              (MODIFIED — add env var backend + backend selection)
│   ├── server.py            (unchanged)
│   └── scripts/
│       ├── __init__.py      (NEW)
│       └── seed_keyvault.py (NEW — one-time OAuth + Key Vault seeding)
├── tests/
│   ├── test_config.py       (unchanged)
│   ├── test_auth.py         (MODIFIED — add env var backend tests)
│   └── test_server.py       (unchanged)
└── docs/
    └── plans/
        └── 008-openclaw-auth.md (this plan)
```

## Todos

1. **config-env** — Add `GOOGLE_TOKEN_ENV` constant to config.py
2. **auth-env-backend** — Add env var backend to auth.py: `_use_env_backend()`, `_env_*` functions, rename existing to `_keychain_*`, wire public API to delegate
3. **seed-script** — Create `scripts/seed_keyvault.py` using `az` CLI for Key Vault storage
4. **add-tests** — Add env var backend tests to test_auth.py; verify existing Keychain tests still pass
5. **docs-update** — Update README.md and auth.md with env var backend and Azure/OpenClaw setup
6. **plan-complete** — Mark plan as complete with date

### Dependencies

- **auth-env-backend** depends on **config-env**
- **seed-script** depends on **config-env** (uses same constant for secret name)
- **add-tests** depends on **auth-env-backend**
- **docs-update** depends on **add-tests** and **seed-script**
- **plan-complete** depends on **docs-update**

## Testing approach

- **Keychain tests (existing):** Unchanged — verify macOS Keychain backend still works
- **Env var tests (new):** Set `GOOGLE_MCP_TOKEN` in test env, verify credentials parsed correctly
- **Backend selection:** Test `_use_env_backend()` returns True/False based on env var
- **Token refresh:** Verify expired access tokens are refreshed using the refresh token from env
- **Read-only:** Verify `store_token()` is a no-op when env backend is active
- **Malformed input:** Verify graceful failure on invalid JSON in env var

---

## Checklist

### Implementation
- [x] Add `GOOGLE_TOKEN_ENV` to config.py
- [x] Add env var backend to auth.py with backend selection
- [x] Create seed_keyvault.py script
- [x] Verify existing Keychain tests still pass

### Testing
- [x] Env var backend tests written
- [x] All unit tests passing (new + existing)

### Cleanup
- [x] Code linting passes (`ruff check src/ tests/`)
- [x] No unused imports or dead code
- [x] Code is readable

### Documentation
- [x] README.md updated with env var setup and Azure/OpenClaw instructions
- [x] docs/auth.md updated with dual-backend strategy
- [x] Plan marked as complete with date
