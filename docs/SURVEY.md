# Repository Survey: gmail-mcp

## Summary

**Purpose:** MCP server for Gmail integration with AI assistants (Claude, Claude Code)  
**Status:** MVP with secure auth and list_emails tool, well-tested  
**Next Steps:** Add search, read, send tools → Thread support → Draft management

| Aspect | Current State |
|--------|---------------|
| **Tools** | 2 tools: `authenticate`, `list_emails` |
| **Auth** | OAuth 2.0 via browser, refresh token in macOS Keychain |
| **Scopes** | `gmail.readonly` only |
| **Tests** | 24 unit tests covering config, auth, server |
| **Error handling** | Good - user-friendly messages for common failures |

---

## Current Architecture

```
src/gmail_mcp/
├── config.py    # Config dir and credentials path management
├── auth.py      # OAuth flow, Keychain token storage
└── server.py    # MCP tools: authenticate, list_emails
```

### File Structure
```
gmail-mcp/
├── src/gmail_mcp/
│   ├── __init__.py      # Package init
│   ├── config.py        # Config management
│   ├── auth.py          # Authentication & Keychain
│   └── server.py        # MCP server & tools
├── tests/
│   ├── test_config.py   # Config unit tests
│   ├── test_auth.py     # Auth unit tests
│   └── test_server.py   # Server unit tests
├── docs/
│   ├── SURVEY.md        # This file
│   └── plans/           # Feature plans
├── .github/
│   └── copilot-instructions.md
├── pyproject.toml       # Dependencies, build config
├── README.md            # User-facing docs
└── .gitignore
```

### Dependencies
- `mcp>=1.0.0` - MCP SDK
- `google-api-python-client>=2.100.0` - Gmail API
- `google-auth-httplib2>=0.1.0` - Auth transport
- `google-auth-oauthlib>=1.0.0` - OAuth flow
- `keyring>=24.0.0` - macOS Keychain access

### Security Model
- OAuth client credentials in `~/.config/gmail-mcp/credentials.json`
- Refresh token stored in macOS Keychain (encrypted at rest)
- Access tokens kept in memory only
- Config dir created with 700 permissions

---

## Gaps & Opportunities

### Tools - Missing Functionality

| Gap | Description | Priority |
|-----|-------------|----------|
| No search | Can't search emails by query | High |
| No read | Can't view full email content | High |
| No send | Can't compose/send emails | High |
| No thread support | Can't view email conversations as threads | Medium |
| No draft management | Can't save, edit, or send drafts | Medium |
| No attachment handling | Can't read or send attachments | Medium |
| No label management | Can't add/remove labels from emails | Low |

### Robustness - Technical Debt

| Gap | Description | Priority |
|-----|-------------|----------|
| No pagination | Limited to 50 emails per call | Medium |
| No rate limiting | Could hit Gmail API quotas | Low |
| No retry logic | Transient failures not handled | Low |

### Quality - Testing & Maintenance

| Gap | Description | Priority |
|-----|-------------|----------|
| No integration tests | Manual testing only for real Gmail | Medium |
| No CI/CD | Tests not run automatically | Low |

---

## Gmail API Reference

### Current Scopes
```python
SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]  # Read-only
```

### Key API Endpoints Used
- `users.messages.list` - List emails
- `users.messages.get` - Read email metadata/snippet
- `users.getProfile` - Get authenticated user's email

### Endpoints Needed for New Features
- `users.messages.get (format=full)` - Read full email content
- `users.messages.list (q=...)` - Search emails
- `users.messages.send` - Send email (requires `gmail.send` scope)
- `users.threads.list` / `users.threads.get` - Thread support
- `users.drafts.*` - Draft management
- `users.messages.modify` - Label management (requires `gmail.modify` scope)
- `users.messages.attachments.get` - Attachments
