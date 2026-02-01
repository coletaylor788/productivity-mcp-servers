# Repository Survey: gmail-mcp

## Summary

**Purpose:** MCP server for Gmail integration with AI assistants  
**Status:** MVP with 4 basic tools, no tests, minimal error handling  
**Next Steps:** Error handling → Thread support → Draft management → Tests

| Aspect | Current State |
|--------|---------------|
| **Tools** | 4 tools: `gmail_search`, `gmail_read`, `gmail_send`, `gmail_list_labels` |
| **Auth** | OAuth 2.0 via local browser flow, stores token.json |
| **Scopes** | `readonly`, `send`, `modify` |
| **Tests** | None implemented (pytest configured but no test files) |
| **Error handling** | Minimal - no try/except around API calls |

---

## Current Architecture

```
server.py (239 lines, single file)
├── Auth: get_gmail_service() - handles OAuth flow
├── MCP: list_tools() - defines 4 tools
├── MCP: call_tool() - routes to handlers
└── Handlers: _search_emails, _read_email, _send_email, _list_labels
```

### File Structure
```
gmail-mcp/
├── src/gmail_mcp/
│   ├── __init__.py      # Package init, version
│   └── server.py        # All MCP logic (239 lines)
├── .github/
│   └── copilot-instructions.md
├── .vscode/
│   └── mcp.json         # MCP server config for VS Code
├── pyproject.toml       # Dependencies, build config
├── README.md            # User-facing docs
└── .gitignore
```

### Dependencies
- `mcp>=1.0.0` - MCP SDK
- `google-api-python-client>=2.100.0` - Gmail API
- `google-auth-httplib2>=0.1.0` - Auth transport
- `google-auth-oauthlib>=1.0.0` - OAuth flow

---

## Gaps & Opportunities

### Tools - Missing Functionality

| Gap | Description | Priority |
|-----|-------------|----------|
| No thread support | Can't view email conversations as threads | High |
| No draft management | Can't save, edit, or send drafts | High |
| No attachment handling | Can't read or send attachments | Medium |
| No label management | Can't add/remove labels from emails | Medium |
| No reply/forward | Can't reply to or forward emails | Medium |
| No trash/archive | Can't move emails to trash or archive | Low |

### Robustness - Technical Debt

| Gap | Description | Priority |
|-----|-------------|----------|
| No error handling | API failures crash the server | Critical |
| No pagination | Limited to max_results per call | Medium |
| No rate limiting | Could hit Gmail API quotas | Low |
| No retry logic | Transient failures not handled | Low |

### Quality - Testing & Maintenance

| Gap | Description | Priority |
|-----|-------------|----------|
| Zero test coverage | No confidence in changes | High |
| Single file architecture | Hard to maintain as it grows | Medium |
| No type checking | Type hints present but not enforced | Low |

---

## Gmail API Reference

### Current Scopes
```python
SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",   # Read emails
    "https://www.googleapis.com/auth/gmail.send",       # Send emails
    "https://www.googleapis.com/auth/gmail.modify",     # Modify labels, drafts
]
```

### Key API Endpoints Used
- `users.messages.list` - Search/list emails
- `users.messages.get` - Read email content
- `users.messages.send` - Send email
- `users.labels.list` - List labels

### Endpoints Needed for New Features
- `users.threads.list` / `users.threads.get` - Thread support
- `users.drafts.*` - Draft management
- `users.messages.modify` - Label management
- `users.messages.attachments.get` - Attachments
