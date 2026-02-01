# Plan: List Emails Filters

**Status:** ✅ Complete (2026-02-01)

## Summary

Enhance the `list_emails` tool with filtering capabilities to help LLMs effectively manage an inbox. Add simple, commonly-used filters plus a `query` parameter for advanced Gmail search syntax.

**Scope:**
- Add `label`, `category`, `unread_only` filters
- Add `query` parameter for raw Gmail search
- Keep existing `max_results` parameter
- Update tests and docs

**Out of scope:** Read email content, send, drafts (future features)

---

## Filter Design

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `max_results` | integer | 10 | Maximum emails to return (max: 50) |
| `label` | string | null | Gmail label: INBOX, SENT, DRAFTS, SPAM, TRASH, STARRED, IMPORTANT, or custom |
| `category` | string | null | Gmail category: primary, social, promotions, updates, forums |
| `unread_only` | boolean | false | Only return unread emails |
| `query` | string | null | Raw Gmail search query (e.g., "from:boss@company.com newer_than:7d") |

### Gmail Search Query Examples (for `query` parameter)

LLMs can use these patterns:
- `from:sender@example.com` - From specific sender
- `to:recipient@example.com` - To specific recipient
- `subject:meeting` - Subject contains "meeting"
- `has:attachment` - Has attachments
- `is:starred` - Starred emails
- `is:important` - Important emails
- `newer_than:7d` - Last 7 days
- `older_than:1m` - Older than 1 month
- `after:2026/01/01` - After specific date
- `before:2026/02/01` - Before specific date
- Combine with spaces: `from:boss@company.com is:unread newer_than:3d`

### How Filters Combine

Filters are combined with AND logic:
- `label=INBOX` + `unread_only=true` → Unread emails in inbox
- `category=primary` + `query="from:boss"` → Primary emails from boss
- All filters add to the Gmail API `q` parameter

### Implementation Notes

Gmail API uses:
- `labelIds` parameter for labels (we'll map label names to IDs)
- `q` parameter for search queries
- Categories are labels: `category:primary` in query

We'll build the query string by combining:
1. Label filter → add to `labelIds` or query
2. Category filter → add `category:{name}` to query  
3. Unread filter → add `is:unread` to query
4. Raw query → append to query string

---

## Updated Tool Definition

```json
{
  "name": "list_emails",
  "description": "List emails from Gmail with optional filters. Use 'query' for advanced Gmail search syntax.",
  "inputSchema": {
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
        "description": "Raw Gmail search query. Examples: 'from:sender@example.com', 'subject:meeting', 'has:attachment', 'newer_than:7d'"
      }
    }
  }
}
```

---

## Example Usage

### Primary inbox only (no promotions)
```json
{"category": "primary"}
```

### Unread emails in inbox
```json
{"label": "INBOX", "unread_only": true}
```

### Recent emails from specific sender
```json
{"query": "from:boss@company.com newer_than:7d"}
```

### Emails with attachments in last month
```json
{"query": "has:attachment newer_than:30d", "max_results": 20}
```

### Combine filters
```json
{"label": "INBOX", "category": "primary", "unread_only": true, "max_results": 5}
```

---

## Implementation Steps

### 1. Update `_list_emails` in server.py
- Parse new parameters: `label`, `category`, `unread_only`, `query`
- Build Gmail API query string from filters
- Handle label mapping (INBOX, SENT, etc. are special)
- Pass query to Gmail API

### 2. Update tool definition in `list_tools()`
- Add new parameters to inputSchema
- Update description

### 3. Add unit tests
- Test query building with various filter combinations
- Test each filter individually
- Test filter combination logic

### 4. Add integration tests
- Test filtering by label
- Test filtering by category
- Test unread filter
- Test raw query

### 5. Update README
- Document new filter parameters
- Add usage examples

---

## Files Changed

| File | Action |
|------|--------|
| `src/gmail_mcp/server.py` | Add filter parameters and query building |
| `tests/test_server.py` | Add unit tests for filter logic |
| `tests/integration/test_gmail.py` | Add integration tests for filters |
| `README.md` | Document filter parameters |

---

## Checklist

### Implementation
- [x] Add filter parameters to `list_tools()` schema
- [x] Implement query building logic in `_list_emails()`
- [x] Handle label parameter (map to labelIds or query)
- [x] Handle category parameter (add to query)
- [x] Handle unread_only parameter (add to query)
- [x] Handle raw query parameter (append to query)

### Testing
- [x] Unit tests for query building with each filter (9 tests)
- [x] Unit tests for filter combinations
- [x] Integration test: filter by label
- [x] Integration test: filter by category  
- [x] Integration test: unread_only filter
- [x] Integration test: raw query
- [x] All tests passing (44 total: 42 passed, 2 skipped)

### Cleanup
- [x] Code linting passes
- [x] No unused code
- [x] Code is readable

### Documentation
- [x] README.md updated with filter docs
- [x] Plan marked as complete with date
