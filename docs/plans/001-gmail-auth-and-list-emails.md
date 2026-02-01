# Plan: Gmail Authentication & List Emails

**Status:** ✅ Complete (2026-02-01)

## Summary

Set up proper Gmail authentication with macOS-appropriate local storage, then implement a single `gmail_list_emails` tool. This is our MVP to validate the MCP server works end-to-end with Gmail.

**Scope:**
- Config/auth stored in `~/.config/gmail-mcp/` + macOS Keychain
- Auth via MCP tool (Claude can trigger setup)
- Two MCP tools: `authenticate`, `list_emails`
- Unit tests + integration test

**Out of scope:** Search, send, drafts, labels (future features)

---

## Security Strategy

### OAuth 2.0 Flow
We use Google's OAuth 2.0 "Desktop App" flow (also called "installed app" flow):

1. **No secrets in code** - The `credentials.json` from Google contains a client ID and client secret, but for desktop apps this secret is not truly secret (Google acknowledges this). Security comes from the user consent flow, not the secret.

2. **User-granted scopes** - User explicitly authorizes what the app can access in their browser. We request only `gmail.readonly` for this feature.

3. **Tokens in Keychain** - Refresh token stored in macOS Keychain, encrypted at rest. Never written to disk as plaintext.

4. **Token refresh** - Access tokens expire after 1 hour. The SDK automatically uses the refresh token to get new access tokens. User doesn't need to re-authenticate.

### Storage Strategy
| Data | Location | Why |
|------|----------|-----|
| OAuth client credentials | `~/.config/gmail-mcp/credentials.json` | App identity, not truly secret (see below) |
| Refresh token | macOS Keychain | Sensitive - encrypted at rest |
| Account email | macOS Keychain (as account name) | Stored alongside token |
| Access token | Memory only | Short-lived, never persisted |

### Why Client Credentials Aren't Secret (Desktop Apps)

Google has two OAuth client types:

1. **Web apps** - Secret stored on server, never exposed to users
2. **Desktop apps** - Secret embedded in app binary, extractable by anyone

For desktop apps, Google doesn't rely on the secret. Security comes from:
- **Localhost redirect** - Auth code sent to `http://localhost`, can't be intercepted remotely
- **User consent screen** - User sees exactly what app/scopes are requested
- **PKCE** - Cryptographic proof that the app starting auth is the same one finishing it

The `credentials.json` is really just "app identity" - your Google Cloud project ID. If stolen, an attacker could:
- Build a fake app using your project name
- BUT they still can't access YOUR data - users would have to authorize THEIR app
- AND Google can revoke the client ID if abused

**Bottom line:** Protect it to avoid impersonation, but it's not a catastrophic leak like a refresh token would be.

### Keychain Details
- Service name: `gmail-mcp`
- Account name: user's Gmail address
- Stores: refresh token (JSON string with token + expiry)
- Python library: `keyring` (uses macOS Keychain automatically)
- User can inspect/delete in Keychain Access app

### File Permissions
- Config directory created with `700` permissions (owner read/write/execute only)
- Even though tokens aren't in files, we protect config.json and credentials.json

### What's NOT in the repo
- `credentials.json` - User downloads their own from Google Cloud Console
- Any tokens - stored in Keychain, not filesystem
- Both patterns listed in `.gitignore`

### Threat Model
| Threat | Mitigation |
|--------|------------|
| Token stolen from disk | Token not on disk - stored in encrypted Keychain |
| Token intercepted in transit | All Google API calls use HTTPS |
| Malicious app impersonation | User verifies app in Google consent screen |
| Malicious app reads Keychain | macOS prompts user for permission |
| Scope creep | Request minimal scopes; user can revoke in Google Account settings |

---

## Config & Auth Design

### Storage Location
```
~/.config/gmail-mcp/
└── credentials.json    # OAuth client ID (user downloads from Google Cloud Console)

macOS Keychain:
└── gmail-mcp/<email>   # Refresh token (encrypted)
```

### Setup Flow
1. User downloads OAuth credentials from Google Cloud Console
2. User saves credentials to `~/.config/gmail-mcp/credentials.json` (manual or drag-drop)
3. User starts MCP server (via Claude/Claude Code)
4. Claude calls `authenticate` tool → opens browser for OAuth
5. After auth, refresh token saved to Keychain (with email as account name)
6. Server ready - `list_emails` now works

### Auth at Runtime
- On tool call, server checks for refresh token in Keychain
- If no token: `list_emails` returns error prompting to call `authenticate` first
- If token exists: auto-refreshes access token as needed (stays in memory)
- No CLI needed - everything happens through MCP tools

---

## MCP Tools

### Tool: authenticate

Initiates OAuth flow. Opens browser for user to grant access.

```json
{
  "name": "authenticate",
  "description": "Authenticate with Gmail. Opens browser for OAuth login. Required before using other Gmail tools.",
  "inputSchema": {
    "type": "object",
    "properties": {}
  }
}
```

**Output (success):**
```
Successfully authenticated as user@gmail.com
Gmail MCP is ready to use.
```

**Output (missing credentials.json):**
```
Error: credentials.json not found at ~/.config/gmail-mcp/credentials.json
Please download OAuth credentials from Google Cloud Console and save them there.
```

### Tool: list_emails

List recent emails from inbox.

```json
{
  "name": "list_emails",
  "description": "List recent emails from Gmail inbox",
  "inputSchema": {
    "type": "object",
    "properties": {
      "max_results": {
        "type": "integer",
        "description": "Maximum number of emails to return (default: 10, max: 50)",
        "default": 10
      }
    }
  }
}
```

**Output (success):**
```
Found 3 emails:

1. ID: 18d5a2b3c4d5e6f7
   From: sender@example.com
   Subject: Meeting tomorrow
   Date: 2026-02-01 10:30 AM
   Snippet: Hey, just wanted to confirm our meeting...

2. ID: 18d5a2b3c4d5e6f8
   ...
```

**Output (not authenticated):**
```
Error: Not authenticated. Please call the 'authenticate' tool first.
```

---

## Implementation Steps

### 1. Config module (`src/gmail_mcp/config.py`)
- `CONFIG_DIR` = `~/.config/gmail-mcp/`
- `get_config_dir()` - returns path, creates with 700 permissions if needed
- `get_credentials_path()` - returns `CONFIG_DIR/credentials.json`

### 2. Auth module (`src/gmail_mcp/auth.py`)
- `get_gmail_service()` - builds authenticated Gmail client (returns None if no token)
- `run_oauth_flow()` - runs OAuth, saves token to Keychain, returns email
- `is_authenticated()` - checks if token exists in Keychain
- `store_token(email, token)` - save refresh token to Keychain (email as account name)
- `get_token()` - retrieve refresh token from Keychain
- Uses `keyring` library for Keychain access

### 3. Simplify server.py
- Remove `gmail_search`, `gmail_read`, `gmail_send`, `gmail_list_labels` (not in scope yet)
- Add `authenticate` tool - calls `run_oauth_flow()`
- Add `list_emails` tool - checks auth first, then lists emails
- Import auth from new module

### 4. Update pyproject.toml
- Add `keyring` dependency
- No CLI entry point needed

---

## Testing

### Unit Tests (`tests/test_config.py`)
- `test_get_config_dir_creates_directory`
- `test_get_credentials_path`

### Unit Tests (`tests/test_auth.py`)
- `test_is_authenticated_false_when_no_token`
- `test_is_authenticated_true_when_token_exists`
- `test_run_oauth_flow_saves_token`
- `test_get_gmail_service_returns_none_when_not_authenticated`
- `test_store_token_saves_to_keyring`
- `test_get_token_retrieves_from_keyring`
- Mock the Google API calls and keyring

### Integration Test (`tests/integration/test_gmail.py`)
- Requires real credentials (skip in CI)
- `test_authenticate_tool_opens_browser` (manual verification)
- `test_list_emails_returns_results`
- `test_list_emails_without_auth_returns_error`

---

## Files Changed

| File | Action |
|------|--------|
| `src/gmail_mcp/config.py` | Create |
| `src/gmail_mcp/auth.py` | Create |
| `src/gmail_mcp/server.py` | Simplify - replace with authenticate + list_emails tools |
| `pyproject.toml` | Add `keyring` dependency |
| `tests/test_config.py` | Create |
| `tests/test_auth.py` | Create |
| `tests/integration/test_gmail.py` | Create |
| `README.md` | Update setup instructions |

---

## Checklist

### Implementation
- [x] Create `src/gmail_mcp/config.py` with config dir and credentials path
- [x] Create `src/gmail_mcp/auth.py` with OAuth flow and Keychain storage
- [x] Update `src/gmail_mcp/server.py` with `authenticate` and `list_emails` tools
- [x] Add `keyring` dependency to `pyproject.toml`
- [x] Fix: `run_oauth_flow()` should skip browser if already authenticated

### Testing
- [x] Unit tests written for config module (4 tests)
- [x] Unit tests written for auth module (14 tests)
- [x] Unit tests written for server module (8 tests)
- [x] All 26 unit tests passing
- [x] Integration tests written (6 tests)
- [x] Integration tests passing (4 passed, 2 skipped as expected)
- [x] Re-run all tests after fix (32 total: 30 passed, 2 skipped)

### Cleanup
- [x] Code linting passes (`ruff check src/ tests/`)
- [x] No unused imports or dead code
- [x] Code is readable and well-commented where needed
- [x] Re-run linting after fix

### Documentation
- [x] README.md updated with new setup and usage instructions
- [x] docs/SURVEY.md updated with current architecture
- [x] Plan marked as complete with date
