# Plan: Email Tools (Get, Attachments, Archive)

**Status:** ✅ Complete (2026-02-01)

## Summary

Add three new tools for email management:
1. `get_email` - Get full contents of an email by ID
2. `get_attachments` - Download attachments from an email
3. `archive_email` - Archive an email (remove from INBOX)

**Scope:**
- Get full email body (plain text and/or HTML)
- Download attachments to local filesystem
- Archive emails (move out of INBOX)

**Out of scope:** Send, drafts, delete, labels management (future features)

---

## Tool Designs

### 1. get_email

Get full contents of a specific email.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `email_id` | string | yes | Email ID from list_emails |
| `format` | string | no | Response format: "full" (default), "text_only", "html_only" |

**Output:** Full email content including:
- From, To, Subject, Date headers
- Body (plain text and/or HTML depending on format)
- List of attachments (filename, size, mimeType)

### 2. get_attachments

Download attachments from an email.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `email_id` | string | yes | Email ID from list_emails |
| `attachment_id` | string | no | Specific attachment ID (downloads all if omitted) |
| `save_to` | string | no | Directory to save files (default: ~/Downloads) |

**Output:** List of downloaded files with paths.

**Security notes:**
- Only save to user-specified or default Downloads directory
- Sanitize filenames to prevent path traversal
- Report file sizes before download

### 3. archive_email

Archive an email (remove INBOX label, keep in All Mail).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `email_id` | string | yes | Email ID to archive |

**Output:** Confirmation message.

**Note:** This requires `gmail.modify` scope. We may need to update our OAuth scopes.

---

## Implementation Details

### Gmail API Methods

**get_email:**
```python
service.users().messages().get(userId="me", id=email_id, format="full").execute()
```
- Returns full message with body parts
- Need to decode base64url encoded body
- Handle multipart messages (text + HTML + attachments)

**get_attachments:**
```python
service.users().messages().attachments().get(
    userId="me", messageId=email_id, id=attachment_id
).execute()
```
- Returns base64url encoded attachment data
- Need to decode and write to file

**archive_email:**
```python
service.users().messages().modify(
    userId="me", id=email_id,
    body={"removeLabelIds": ["INBOX"]}
).execute()
```
- Requires `gmail.modify` scope

### OAuth Scope Update

Current scope: `gmail.readonly`

For archive, we need: `gmail.modify`
For integration tests (send test email), we need: `gmail.send`

**Decision:** Add both `gmail.modify` and `gmail.send` scopes. The send scope is needed for integration tests to create test emails safely. We won't expose a `send_email` tool yet - that's a future feature. Users will need to re-authenticate once.

---

## Tool Definitions

### get_email

```json
{
  "name": "get_email",
  "description": "Get the full contents of an email by ID.",
  "inputSchema": {
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
}
```

### get_attachments

```json
{
  "name": "get_attachments",
  "description": "Download attachments from an email.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "email_id": {
        "type": "string",
        "description": "The email ID (from list_emails)"
      },
      "attachment_id": {
        "type": "string",
        "description": "Specific attachment ID (downloads all if omitted)"
      },
      "save_to": {
        "type": "string",
        "description": "Directory to save files (default: ~/Downloads)"
      }
    },
    "required": ["email_id"]
  }
}
```

### archive_email

```json
{
  "name": "archive_email",
  "description": "Archive an email (remove from inbox, keep in All Mail).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "email_id": {
        "type": "string",
        "description": "The email ID to archive"
      }
    },
    "required": ["email_id"]
  }
}
```

---

## Implementation Steps

### 1. Update OAuth scope in auth.py
- Add `gmail.modify` scope (for archive)
- Add `gmail.send` scope (for integration tests only, no tool exposed)
- These scopes include read permissions

### 2. Add get_email tool
- Add tool definition to `list_tools()`
- Implement `_get_email()` handler
- Parse multipart messages for text/HTML body
- Decode base64url content
- List attachments metadata

### 3. Add get_attachments tool
- Add tool definition to `list_tools()`
- Implement `_get_attachments()` handler
- Sanitize filenames for security
- Save to specified or default directory
- Return list of saved file paths

### 4. Add archive_email tool
- Add tool definition to `list_tools()`
- Implement `_archive_email()` handler
- Remove INBOX label from email

### 5. Add tests
- Unit tests for each tool (mocked Gmail API)
- Integration tests with real Gmail
  - **Important:** Tests that modify emails must NOT touch real inbox emails
  - Create a test helper that sends a test email to self first
  - Use Gmail API directly in test setup to send test email with known subject
  - Only modify/archive the test email we just created
  - Clean up test emails after tests complete

### 6. Update docs
- Update README with new tools
- Update docs/tools.md

---

## Files Changed

| File | Action |
|------|--------|
| `src/gmail_mcp/auth.py` | Update OAuth scope to gmail.modify |
| `src/gmail_mcp/server.py` | Add 3 new tool handlers |
| `tests/test_server.py` | Add unit tests |
| `tests/integration/test_gmail.py` | Add integration tests |
| `README.md` | Document new tools |
| `docs/tools.md` | Add tool reference |

---

## Checklist

### Implementation
- [x] Update OAuth scopes to `gmail.modify` + `gmail.send` in auth.py
- [x] Add `get_email` tool definition
- [x] Implement `_get_email()` with body parsing
- [x] Add `get_attachments` tool definition
- [x] Implement `_get_attachments()` with file saving
- [x] Add `archive_email` tool definition
- [x] Implement `_archive_email()`

### Testing
- [x] Unit tests for `get_email`
- [x] Unit tests for `get_attachments`
- [x] Unit tests for `archive_email`
- [x] Integration test helper: send test email to self (auto-archived)
- [x] Integration test: `get_email` on test email
- [x] Integration test: `get_attachments` on test email (with attachment)
- [x] Integration test: `archive_email` on test email
- [x] Integration test cleanup: delete test emails
- [x] All tests passing (57 unit, 15 integration)

### Cleanup
- [x] Code linting passes (`ruff check src/ tests/`)
- [x] No unused imports or dead code
- [x] Code is readable and well-commented

### Documentation
- [x] README.md updated with new tools
- [x] docs/tools.md updated
- [x] Plan marked as complete with date
