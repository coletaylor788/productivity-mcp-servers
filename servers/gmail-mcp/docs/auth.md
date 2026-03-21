# Authentication

Gmail MCP uses OAuth 2.0 with two storage backends:

- **macOS Keychain** (default) — for local development with Claude Desktop/Code
- **Environment variable** (`GOOGLE_MCP_TOKEN`) — for Azure/Linux deployments where Key Vault injects secrets

The backend is selected automatically: if `GOOGLE_MCP_TOKEN` is set, the env var backend is used. Otherwise, Keychain.

---

## Overview

### macOS (Keychain backend)

```
┌──────────────┐    1. OAuth flow     ┌──────────────┐
│    User      │◄────────────────────►│   Google     │
│  (Browser)   │                      │   OAuth      │
└──────────────┘                      └──────────────┘
                                             │
                                             │ 2. Auth code
                                             ▼
┌──────────────┐    3. Refresh token  ┌──────────────┐
│   macOS      │◄─────────────────────│  Gmail MCP   │
│  Keychain    │                      │   Server     │
└──────────────┘                      └──────────────┘
```

### Azure / Linux (env var backend)

```
┌──────────────┐    Key Vault injects   ┌──────────────┐
│  Azure       │───env var──────────────│  Gmail MCP   │──▶ Gmail API
│  Key Vault   │  GOOGLE_MCP_TOKEN      │   Server     │
└──────────────┘                        └──────────────┘
```

---

## Storage Strategy

### macOS (Keychain)

| Data | Location | Why |
|------|----------|-----|
| OAuth client credentials | `~/.config/gmail-mcp/credentials.json` | App identity (not truly secret for desktop apps) |
| Refresh token | macOS Keychain | Sensitive - encrypted at rest |
| Access token | Memory only | Short-lived, never persisted |

### Azure / Linux (env var)

| Data | Location | Why |
|------|----------|-----|
| Refresh token + client identity | `GOOGLE_MCP_TOKEN` env var | Injected by Key Vault, read once into memory |
| Access token | Memory only | Short-lived, auto-refreshed |

---

## OAuth 2.0 Flow

We use Google's "Desktop App" OAuth flow:

1. **User calls `authenticate` tool** - Claude triggers the MCP tool
2. **Browser opens** - User sees Google consent screen
3. **User grants access** - Authorizes the requested scopes
4. **Localhost callback** - Auth code sent to `http://localhost`
5. **Token exchange** - Code exchanged for refresh + access tokens
6. **Token stored** - Refresh token saved to Keychain
7. **Ready** - Server can now make Gmail API calls

### Scopes Requested

```python
SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
]
```

- `gmail.modify` - Read, write, and modify emails (includes archive, labels)
- `gmail.send` - Send emails (used for integration tests)

---

## Keychain Storage

Tokens are stored in macOS Keychain using the `keyring` library.

**Service name:** `gmail-mcp`  
**Account name:** User's Gmail address (e.g., `user@gmail.com`)  
**Password:** JSON containing refresh token

### Viewing in Keychain Access

1. Open **Keychain Access.app**
2. Search for `gmail-mcp`
3. Double-click to view details
4. Click "Show password" to see token (requires macOS password)

### Deleting Credentials

To sign out or switch accounts:
1. Open **Keychain Access.app**
2. Search for `gmail-mcp`
3. Delete the entry
4. Re-authenticate via Claude

Or via command line:
```bash
security delete-generic-password -s "gmail-mcp"
```

---

## Why Client Credentials Aren't Secret

Google has two OAuth client types:

| Type | Secret Protection | Use Case |
|------|------------------|----------|
| **Web app** | Secret on server, never exposed | Server-side apps |
| **Desktop app** | Secret in binary, extractable | Desktop/mobile apps |

For desktop apps, Google doesn't rely on the secret. Security comes from:

- **Localhost redirect** - Auth code sent to `http://localhost`, can't be intercepted remotely
- **User consent screen** - User sees exactly what app/scopes are requested
- **PKCE** - Cryptographic proof that the app starting auth is the same one finishing it

The `credentials.json` is really just "app identity" - your Google Cloud project ID.

---

## Token Refresh

- **Access tokens** expire after 1 hour
- **Refresh tokens** don't expire (unless revoked)
- The Google SDK automatically refreshes access tokens using the stored refresh token
- Users don't need to re-authenticate unless they revoke access

---

## Threat Model

| Threat | Mitigation |
|--------|------------|
| Token stolen from disk | Keychain: encrypted at rest. Env var: not on disk, in memory only |
| Token intercepted in transit | All Google API calls use HTTPS |
| Malicious app impersonation | User verifies app in Google consent screen |
| Malicious app reads Keychain | macOS prompts user for permission |
| Env var leaked via subprocess | Use Azure sandbox isolation; secrets only on trusted box |
| Scope creep | Request minimal scopes; user can revoke in Google Account |

---

## Azure Key Vault Setup

### One-time seed (from a machine with a browser)

```bash
python -m gmail_mcp.scripts.seed_keyvault \
  --vault-name my-vault \
  --credentials ~/path/to/credentials.json
```

### Container App configuration

```json
"secrets": [
  {
    "name": "google-mcp-token",
    "keyVaultUrl": "https://<vault>.vault.azure.net/secrets/google-mcp-token",
    "identity": "system"
  }
],
"env": [
  {
    "name": "GOOGLE_MCP_TOKEN",
    "secretRef": "google-mcp-token"
  }
]
```

**When to re-seed:** Google password change, app access revoked, scopes changed, or token unused for 6+ months.

---

## Code Reference

### Key Functions

```python
# Check if authenticated
from gmail_mcp.auth import is_authenticated
if is_authenticated():
    # Token exists in Keychain
    pass

# Run OAuth flow (opens browser)
from gmail_mcp.auth import run_oauth_flow
email = run_oauth_flow()  # Returns authenticated email address

# Get authenticated Gmail service
from gmail_mcp.auth import get_gmail_service
service = get_gmail_service()
if service:
    # Make Gmail API calls
    results = service.users().messages().list(userId="me").execute()
```

### Token Storage

```python
# Keychain backend (macOS) - internal
import keyring
keyring.set_password("gmail-mcp", "token", token_json)
token_json = keyring.get_password("gmail-mcp", "token")

# Env var backend (Azure/Linux) - read-only, set externally
# GOOGLE_MCP_TOKEN env var contains the same JSON
```
