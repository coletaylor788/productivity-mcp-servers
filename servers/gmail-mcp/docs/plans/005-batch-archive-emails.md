# Plan 005: Batch Archive Emails

**Status:** Complete  
**Created:** 2026-02-01  
**Completed:** 2026-02-01

## Summary

Update `archive_email` to accept a list of email IDs so multiple emails can be archived in a single tool call. This is more efficient when archiving several emails at once.

## Changes

### 1. Update tool schema
- Change `email_id` (string) to `email_ids` (array of strings)
- Always require an array (can have one or many items)

### 2. Update `_archive_email` implementation
- Expect `email_ids` as array of strings
- Archive each email and collect results
- Return a summary of successes and failures

### 3. Update documentation
- Update `docs/tools.md` with new parameter
- Update `README.md` examples

---

## Checklist

### Implementation
- [x] Update tool schema (email_id → email_ids array)
- [x] Update `_archive_email` to handle list of emails
- [x] Return summary with successes/failures

### Testing
- [x] Add unit test for single email archive
- [x] Add unit test for batch archive
- [x] Add unit test for partial failures
- [x] All unit tests passing

### Cleanup
- [x] Code linting passes (`ruff check src/ tests/`)
- [x] No unused imports or dead code

### Documentation
- [x] Update `docs/tools.md`
- [x] Update `README.md`
- [x] Mark plan as complete with date
