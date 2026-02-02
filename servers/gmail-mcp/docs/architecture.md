# Architecture

## Overview

Gmail MCP Server is a [Model Context Protocol](https://modelcontextprotocol.io/) server that enables AI assistants (Claude, Claude Code) to interact with Gmail.

**Runtime:** Local only (all credentials stay on user's machine)

```
┌─────────────────┐     MCP Protocol      ┌─────────────────┐
│  Claude/Claude  │◄────────────────────► │   Gmail MCP     │
│      Code       │                       │     Server      │
└─────────────────┘                       └────────┬────────┘
                                                   │
                                          OAuth 2.0│Gmail API
                                                   │
                                          ┌────────▼────────┐
                                          │   Gmail API     │
                                          │   (Google)      │
                                          └─────────────────┘
```

---

## Project Structure

```
gmail-mcp/
├── src/gmail_mcp/
│   ├── __init__.py      # Package init
│   ├── config.py        # Config directory management
│   ├── auth.py          # OAuth flow & Keychain storage
│   └── server.py        # MCP server & tool handlers
├── tests/
│   ├── test_config.py   # Config unit tests
│   ├── test_auth.py     # Auth unit tests
│   ├── test_server.py   # Server unit tests
│   └── integration/     # Integration tests (real Gmail)
├── docs/
│   ├── architecture.md  # This file
│   ├── auth.md          # Authentication details
│   ├── tools.md         # MCP tools reference
│   └── plans/           # Feature implementation plans
├── .github/
│   ├── copilot-instructions.md
│   └── dependabot.yml
├── pyproject.toml       # Dependencies & build config
└── README.md            # User-facing setup guide
```

---

## Core Modules

### `config.py`
Manages configuration directory and file paths.

- `CONFIG_DIR` = `~/.config/gmail-mcp/`
- `get_config_dir()` - Creates config dir with 700 permissions
- `get_credentials_path()` - Returns path to `credentials.json`

### `auth.py`
Handles OAuth 2.0 authentication and token storage.

See [auth.md](./auth.md) for details.

- `run_oauth_flow()` - Runs browser-based OAuth, saves token
- `get_gmail_service()` - Returns authenticated Gmail API client
- `is_authenticated()` - Checks if valid token exists
- Token storage via macOS Keychain

### `server.py`
MCP server implementation with tool handlers.

See [tools.md](./tools.md) for details.

- `list_tools()` - Exposes available MCP tools
- `call_tool()` - Routes tool calls to handlers
- `_authenticate()` - Handles authenticate tool
- `_list_emails()` - Handles list_emails tool

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `mcp>=1.0.0` | MCP SDK for server implementation |
| `google-api-python-client>=2.100.0` | Gmail API client |
| `google-auth-httplib2>=0.1.0` | HTTP transport for auth |
| `google-auth-oauthlib>=1.0.0` | OAuth 2.0 flow |
| `keyring>=24.0.0` | macOS Keychain access |

---

## Security Model

See [auth.md](./auth.md) for full security details.

**Key principles:**
- Refresh tokens stored in macOS Keychain (encrypted at rest)
- Access tokens kept in memory only (never persisted)
- Client credentials stay local in `~/.config/gmail-mcp/`
- Minimal scopes requested (`gmail.readonly`)

---

## Gaps & Roadmap

### Missing Tools (High Priority)
- **read_email** - View full email content
- **search_emails** - Search by query
- **send_email** - Compose and send (requires `gmail.send` scope)

### Missing Tools (Medium Priority)
- Thread support (view conversations)
- Draft management
- Attachment handling

### Technical Improvements
- Pagination for large result sets
- Rate limiting
- CI/CD pipeline

---

## Gmail API Reference

### Current Scopes
```python
SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
```

### Endpoints Used
| Endpoint | Purpose |
|----------|---------|
| `users.messages.list` | List emails with filters |
| `users.messages.get` | Get email metadata/snippet |
| `users.getProfile` | Get authenticated user's email |

### Future Endpoints
| Endpoint | Purpose | Scope Required |
|----------|---------|----------------|
| `users.messages.get (format=full)` | Read full content | `gmail.readonly` |
| `users.messages.send` | Send email | `gmail.send` |
| `users.threads.*` | Thread support | `gmail.readonly` |
| `users.drafts.*` | Draft management | `gmail.compose` |
| `users.messages.modify` | Label management | `gmail.modify` |
