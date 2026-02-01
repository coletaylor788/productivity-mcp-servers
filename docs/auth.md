# Authentication

Gmail MCP uses OAuth 2.0 with macOS Keychain for secure token storage.

---

## Overview

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

---

## Storage Strategy

| Data | Location | Why |
|------|----------|-----|
| OAuth client credentials | `~/.config/gmail-mcp/credentials.json` | App identity (not truly secret for desktop apps) |
| Refresh token | macOS Keychain | Sensitive - encrypted at rest |
| Account email | Keychain (as account name) | Stored alongside token |
| Access token | Memory only | Short-lived, never persisted |

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
SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
```

Currently read-only. Future features may request additional scopes:
- `gmail.send` - Send emails
- `gmail.compose` - Create drafts
- `gmail.modify` - Manage labels

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
| Token stolen from disk | Token not on disk - stored in encrypted Keychain |
| Token intercepted in transit | All Google API calls use HTTPS |
| Malicious app impersonation | User verifies app in Google consent screen |
| Malicious app reads Keychain | macOS prompts user for permission |
| Scope creep | Request minimal scopes; user can revoke in Google Account |

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
# Internal - tokens stored via keyring
import keyring

# Store
keyring.set_password("gmail-mcp", email, token_json)

# Retrieve
token_json = keyring.get_password("gmail-mcp", account)

# Delete
keyring.delete_password("gmail-mcp", account)
```
