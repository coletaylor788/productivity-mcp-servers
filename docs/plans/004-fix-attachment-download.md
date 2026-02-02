# Plan 004: Fix Attachment Download

**Status:** Complete  
**Created:** 2026-02-01  
**Completed:** 2026-02-01

## Summary

The `get_attachments` tool fails when Claude tries to use the attachment ID from `get_email` output. This is because Gmail API attachment IDs are **not stable** - they change on every API request.

## Problem

1. User calls `get_email` → shows attachment with `ID: ANGjdJ-y1BXR...`
2. User calls `get_attachments` with that ID
3. `get_attachments` fetches the email again → gets a **different** attachment ID
4. ID doesn't match → "Attachment not found"

**Root cause:** Gmail API generates new attachment IDs on each message fetch.

## Solution

Change `get_attachments` to filter by **filename** instead of attachment ID:
- More intuitive for users (filenames are human-readable)
- Stable across API calls
- Simpler to communicate in `get_email` output

## Changes

### 1. Update tool schema
- Replace `attachment_id` parameter with `filename` parameter

### 2. Update `_get_attachments` implementation
- Filter by filename instead of attachment ID

### 3. Update `get_email` output
- Remove attachment ID from output (it's useless to users)
- Keep filename, type, and size

### 4. Update tests
- Fix unit tests to use filename instead of attachment_id (if any use it)
- Add test for filename filtering
- Verify integration test still passes

### 5. Update documentation
- Update `docs/tools.md` with new parameter
- Update `README.md` examples

---

## Checklist

### Implementation
- [x] Update tool schema (attachment_id → filename)
- [x] Update `_get_attachments` to filter by filename
- [x] Update `get_email` output to remove attachment ID
- [x] Add unit test for filename filtering
- [x] Add integration test for filename filtering

### Testing
- [x] All unit tests passing
- [x] Integration tests passing

### Cleanup
- [x] Code linting passes (`ruff check src/ tests/`)
- [x] No unused imports or dead code

### Documentation
- [x] Update `docs/tools.md`
- [x] Update `README.md`
- [x] Mark plan as complete with date
