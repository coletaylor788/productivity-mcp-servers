# MCP Tools

Reference for all Gmail MCP tools.

---

## authenticate

Authenticate with Gmail via OAuth. Opens browser for user consent.

### Input Schema

```json
{
  "type": "object",
  "properties": {}
}
```

No parameters required.

### Output

**Success:**
```
Successfully authenticated as user@gmail.com
Gmail MCP is ready to use.
```

**Error - Missing credentials:**
```
Error: credentials.json not found at ~/.config/gmail-mcp/credentials.json
Please download OAuth credentials from Google Cloud Console and save them there.
```

### Usage Examples

- "Authenticate with Gmail"
- "Connect to my Gmail account"
- "Sign in to Gmail"

### Notes

- Opens browser for Google OAuth consent
- Only needs to be called once (token stored in Keychain)
- If already authenticated, returns current account info
- See [auth.md](./auth.md) for security details

---

## list_emails

List emails from Gmail with optional filters.

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "max_results": {
      "type": "integer",
      "description": "Maximum number of emails to return (default: 10, max: 50)",
      "default": 10
    },
    "label": {
      "type": "string",
      "description": "Filter by Gmail label: INBOX, SENT, DRAFTS, SPAM, TRASH, STARRED, IMPORTANT, or custom label name"
    },
    "category": {
      "type": "string",
      "enum": ["primary", "social", "promotions", "updates", "forums"],
      "description": "Filter by Gmail category tab"
    },
    "unread_only": {
      "type": "boolean",
      "description": "Only return unread emails",
      "default": false
    },
    "query": {
      "type": "string",
      "description": "Raw Gmail search query"
    }
  }
}
```

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `max_results` | integer | 10 | Maximum emails to return (max: 50) |
| `label` | string | - | Gmail label filter |
| `category` | string | - | Gmail category tab filter |
| `unread_only` | boolean | false | Only unread emails |
| `query` | string | - | Raw Gmail search query |

### Output

**Success:**
```
Found 3 emails:

1. ID: 18d5a2b3c4d5e6f7
   From: sender@example.com
   Subject: Meeting tomorrow
   Date: 2026-02-01 10:30 AM
   Snippet: Hey, just wanted to confirm our meeting...

2. ID: 18d5a2b3c4d5e6f8
   From: newsletter@company.com
   Subject: Weekly Update
   Date: 2026-02-01 09:00 AM
   Snippet: This week's highlights...
```

**No emails:**
```
No emails found.
```

**Error - Not authenticated:**
```
Error: Not authenticated. Please call the 'authenticate' tool first.
```

### Filter Examples

**Primary inbox only (no promotions):**
```json
{"category": "primary"}
```

**Unread emails in inbox:**
```json
{"label": "INBOX", "unread_only": true}
```

**Recent emails from specific sender:**
```json
{"query": "from:boss@company.com newer_than:7d"}
```

**Emails with attachments:**
```json
{"query": "has:attachment", "max_results": 20}
```

**Combined filters:**
```json
{"label": "INBOX", "category": "primary", "unread_only": true, "max_results": 5}
```

### Gmail Search Query Syntax

The `query` parameter accepts Gmail's search syntax:

| Query | Description |
|-------|-------------|
| `from:sender@example.com` | From specific sender |
| `to:recipient@example.com` | To specific recipient |
| `subject:meeting` | Subject contains word |
| `has:attachment` | Has attachments |
| `is:starred` | Starred emails |
| `is:important` | Important emails |
| `newer_than:7d` | Last 7 days |
| `older_than:1m` | Older than 1 month |
| `after:2026/01/01` | After specific date |
| `before:2026/02/01` | Before specific date |
| `filename:pdf` | Has PDF attachment |
| `larger:5M` | Larger than 5MB |

**Combining queries:**
```
from:boss@company.com newer_than:7d has:attachment
```

### How Filters Combine

Filters are combined with AND logic:
- `label=INBOX` + `unread_only=true` → Unread emails in inbox
- `category=primary` + `query="from:boss"` → Primary emails from boss

### Usage Examples

- "Show me my last 10 emails"
- "List unread emails in my primary inbox"
- "Find emails from boss@company.com in the last week"
- "Show me emails with attachments"
- "List my starred emails"

---

## get_email

Get the full contents of an email by ID.

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "email_id": {
      "type": "string",
      "description": "The email ID (from list_emails)"
    },
    "format": {
      "type": "string",
      "enum": ["full", "text_only", "html_only"],
      "description": "Response format (default: full)",
      "default": "full"
    }
  },
  "required": ["email_id"]
}
```

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `email_id` | string | (required) | Email ID from list_emails |
| `format` | string | "full" | Response format |

### Output

**Success:**
```
From: sender@example.com
To: you@gmail.com
Subject: Meeting tomorrow
Date: 2026-02-01

--- Body (Text) ---
Hi, let's meet tomorrow at 2pm.

--- Attachments (1) ---
- agenda.pdf (application/pdf, 45.2 KB, ID: att123)
```

### Usage Examples

- "Read email ID abc123"
- "Show me the full content of that email"
- "Get the text-only version of that email"

---

## get_attachments

Download attachments from an email.

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "email_id": {
      "type": "string",
      "description": "The email ID (from list_emails)"
    },
    "filename": {
      "type": "string",
      "description": "Specific attachment filename to download (downloads all if omitted)"
    },
    "save_to": {
      "type": "string",
      "description": "Directory to save files (default: ~/Downloads)"
    }
  },
  "required": ["email_id"]
}
```

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `email_id` | string | (required) | Email ID from list_emails |
| `filename` | string | - | Specific attachment filename to download |
| `save_to` | string | ~/Downloads | Directory to save files |

### Output

**Success:**
```
Downloaded 2 attachment(s):
  - /Users/you/Downloads/document.pdf
  - /Users/you/Downloads/image.png
```

**No attachments:**
```
No attachments found in this email.
```

### Security Notes

- Filenames are sanitized to prevent path traversal attacks
- Duplicate filenames are handled with `_1`, `_2` suffixes
- Only saves to user-specified or default Downloads directory

### Usage Examples

- "Download attachments from email abc123"
- "Save the PDF attachment to my Documents folder"
- "Get all attachments from that email"

---

## archive_email

Archive one or more emails (remove from inbox, keep in All Mail).

### Input Schema

```json
{
  "type": "object",
  "properties": {
    "email_ids": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Array of email IDs to archive"
    }
  },
  "required": ["email_ids"]
}
```

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `email_ids` | array | (required) | Array of email IDs to archive |

### Output

**Success (single):**
```
Archived 1 email(s).
```

**Success (batch):**
```
Archived 5 email(s).
```

**Partial failure:**
```
Archived 3 email(s).
Failed to archive 2 email(s):
  - abc123: Not found
  - def456: Permission denied
```

### Usage Examples

- "Archive email abc123"
- "Archive these 5 emails"
- "Move those emails out of my inbox"

---

## Future Tools

These tools are planned but not yet implemented:

### send_email
Compose and send emails (requires `gmail.send` scope - already authorized).

### manage_labels
Add/remove labels from emails.

### manage_drafts
Create, edit, and send draft emails.
