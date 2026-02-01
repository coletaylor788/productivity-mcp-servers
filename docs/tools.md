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

## Future Tools

These tools are planned but not yet implemented:

### read_email
Read the full content of a specific email by ID.

### search_emails  
Advanced search with full Gmail query support.

### send_email
Compose and send emails (requires `gmail.send` scope).

### manage_labels
Add/remove labels from emails (requires `gmail.modify` scope).

### manage_drafts
Create, edit, and send draft emails (requires `gmail.compose` scope).
