# Gmail MCP Server

A Model Context Protocol (MCP) server for Gmail integration with AI assistants like Claude.

## Features

- **Secure authentication** - OAuth tokens stored in macOS Keychain (never on disk)
- **List emails** - View recent emails from your inbox

## Prerequisites

- Python 3.10+
- macOS (uses Keychain for secure token storage)
- A Google Cloud project with the Gmail API enabled

## Setup

### 1. Google Cloud Setup

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the Gmail API:
   - Navigate to "APIs & Services" > "Library"
   - Search for "Gmail API" and enable it
4. Create OAuth 2.0 credentials:
   - Navigate to "APIs & Services" > "Credentials"
   - Click "Create Credentials" > "OAuth client ID"
   - Select **"Desktop application"** as the application type
   - Download the credentials JSON file

### 2. Save Credentials

Save the downloaded `credentials.json` to:

```
~/.config/gmail-mcp/credentials.json
```

Create the directory if needed:

```bash
mkdir -p ~/.config/gmail-mcp
mv ~/Downloads/credentials.json ~/.config/gmail-mcp/
```

### 3. Install

```bash
# Clone the repo
git clone https://github.com/yourusername/gmail-mcp.git
cd gmail-mcp

# Create and activate a virtual environment
python -m venv .venv
source .venv/bin/activate

# Install the package
pip install -e .
```

### 4. Configure Claude

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "gmail": {
      "command": "/path/to/gmail-mcp/.venv/bin/python",
      "args": ["-m", "gmail_mcp.server"]
    }
  }
}
```

Or for Claude Code, add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "gmail": {
      "command": "/path/to/gmail-mcp/.venv/bin/python",
      "args": ["-m", "gmail_mcp.server"]
    }
  }
}
```

### 5. Authenticate

In Claude, ask it to authenticate with Gmail. It will call the `authenticate` tool, which opens your browser for OAuth login. After you grant access, the refresh token is securely stored in your macOS Keychain.

## Available Tools

### authenticate

Authenticate with Gmail. Opens browser for OAuth login.

```
No parameters required.
```

**Example:** "Authenticate with Gmail"

### list_emails

List recent emails from your inbox.

**Parameters:**
- `max_results` (optional): Maximum emails to return (default: 10, max: 50)

**Example:** "Show me my last 5 emails"

## Security

- **Refresh tokens** are stored in macOS Keychain, encrypted at rest
- **Access tokens** are kept in memory only (never persisted)
- **Client credentials** (`credentials.json`) stay local in `~/.config/gmail-mcp/`
- The server requests **read-only** Gmail access (`gmail.readonly` scope)

You can inspect or delete stored credentials in Keychain Access.app (search for "gmail-mcp").

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run linter
ruff check src/

# Run tests
pytest
```

## License

MIT
