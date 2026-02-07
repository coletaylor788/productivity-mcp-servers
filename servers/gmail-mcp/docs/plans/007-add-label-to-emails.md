# Plan 007: Add Label to Emails

**Status:** Complete  
**Created:** 2026-02-06  
**Completed:** 2026-02-06

## Summary

Add a new `add_label` tool that applies a Gmail label to one or more emails. This follows the same batch pattern as `archive_email`.

## Tool Design

### add_label

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `email_ids` | array of strings | yes | Email IDs to label |
| `label` | string | yes | Label name to apply (e.g., "STARRED", "IMPORTANT", or custom label) |

**Output:** Summary of successes and failures.

**Gmail API:**
```python
service.users().messages().modify(
    userId="me",
    id=email_id,
    body={"addLabelIds": [label_id]}
).execute()
```

**Note:** Gmail uses label IDs, not names. We need to look up the label ID from the name. System labels (STARRED, IMPORTANT, etc.) have known IDs matching their names. Custom labels must already exist - we return an error if the label is not found (we don't auto-create).

## Implementation Steps

1. Add tool definition to `list_tools()`
2. Add handler case in `call_tool()`
3. Implement `_add_label()` helper:
   - Look up label ID from name (handle system vs custom labels)
   - Apply label to each email
   - Return summary of successes/failures
4. Add unit tests
5. Update documentation

---

## Checklist

### Implementation
- [x] Add tool schema to `list_tools()`
- [x] Add handler in `call_tool()`
- [x] Implement `_add_label()` with label ID lookup
- [x] Handle both system and custom labels

### Testing
- [x] Add unit test for adding system label
- [x] Add unit test for batch add label
- [x] Add unit test for partial failures
- [x] All unit tests passing
- [x] Add integration test for add_label
- [x] Integration tests passing

### Cleanup
- [x] Code linting passes (`ruff check src/ tests/`)
- [x] No unused imports or dead code

### Documentation
- [x] Update `docs/tools.md`
- [x] Update `README.md`
- [x] Mark plan as complete with date
