# Gmail MCP Server

A Model Context Protocol (MCP) server for Gmail integration with AI assistants like Claude.

## Features

- **Secure authentication** - OAuth tokens stored in macOS Keychain (never on disk)
- **List emails** - View recent emails with filters
- **Read emails** - Get full email content and attachments
- **Download attachments** - Save attachments to disk
- **Archive emails** - Remove from inbox, keep in All Mail

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

See the [root README](../../README.md#configuring-claude) for Claude Desktop and Claude Code configuration instructions.

### 5. Authenticate

In Claude, ask it to authenticate with Gmail:

> "Authenticate with Gmail" or "Connect to my Gmail account"

This calls the `authenticate` tool, which:
1. Opens your browser for Google OAuth consent
2. You grant access to your Gmail
3. The refresh token is securely stored in your macOS Keychain

You only need to do this once. The token persists across sessions.

**Note:** If you see a "scope" error, just run authenticate again - the server will automatically request the updated permissions.

## Available Tools

### authenticate

Authenticate with Gmail. Opens browser for OAuth login.

```
No parameters required.
```

**Example:** "Authenticate with Gmail"

### list_emails

List emails from Gmail with optional filters.

**Parameters:**
- `max_results` (optional): Maximum emails to return (default: 10, max: 50)
- `label` (optional): Filter by Gmail label (INBOX, SENT, DRAFTS, SPAM, TRASH, STARRED, IMPORTANT, or custom)
- `category` (optional): Filter by Gmail category (primary, social, promotions, updates, forums)
- `unread_only` (optional): Only return unread emails (default: false)
- `query` (optional): Raw Gmail search query for advanced filtering

**Examples:**
- "Show me my last 5 emails"
- "Show me unread emails in my primary inbox"
- "List emails from boss@company.com in the last week"

**Query Examples:**
The `query` parameter accepts Gmail search syntax:
- `from:sender@example.com` - From specific sender
- `subject:meeting` - Subject contains "meeting"
- `has:attachment` - Has attachments
- `newer_than:7d` - Last 7 days
- `older_than:1m` - Older than 1 month
- Combine: `from:boss@company.com newer_than:7d has:attachment`

### get_email

Get the full contents of an email by ID.

**Parameters:**
- `email_id` (required): The email ID (from list_emails)
- `format` (optional): Response format - "full" (default), "text_only", or "html_only"

**Examples:**
- "Read email ID abc123"
- "Show me the full content of that email"
- "Get the text-only version of that email"

### get_attachments

Download attachments from an email.

**Parameters:**
- `email_id` (required): The email ID (from list_emails)
- `filename` (optional): Specific attachment filename to download (downloads all if omitted)
- `save_to` (optional): Directory to save files (default: ~/Downloads)

**Examples:**
- "Download attachments from email abc123"
- "Save the PDF attachment to my Documents folder"
- "Download report.pdf from that email"

### archive_email

Archive one or more emails (remove from inbox, keep in All Mail).

**Parameters:**
- `email_ids` (required): Array of email IDs to archive

**Examples:**
- "Archive email abc123"
- "Archive these 5 emails"
- "Move those emails out of my inbox"

## Security

- **Refresh tokens** are stored in macOS Keychain, encrypted at rest
- **Access tokens** are kept in memory only (never persisted)
- **Client credentials** (`credentials.json`) stay local in `~/.config/gmail-mcp/`
- The server requests **modify** Gmail access (`gmail.modify` scope) to support archiving
- Attachment filenames are sanitized to prevent path traversal attacks

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
