# Plan 006: Monorepo Reorganization

**Status:** Complete  
**Created:** 2026-02-01  
**Completed:** 2026-02-01

## Summary

Reorganize the repo from a single Gmail MCP server to a monorepo supporting multiple productivity MCP servers. Rename local folder to match GitHub repo name `productivity-mcp-servers`.

## New Structure

```
productivity-mcp-servers/
├── .github/
│   └── copilot-instructions.md  # Global instructions
├── README.md                    # Overview of all servers
├── docs/
│   └── plans/                   # Global plans (cross-cutting)
├── servers/
│   └── gmail-mcp/
│       ├── README.md            # Gmail-specific docs
│       ├── pyproject.toml       # Gmail dependencies
│       ├── src/gmail_mcp/
│       ├── tests/
│       └── docs/
│           └── plans/           # Gmail-specific plans
```

## Changes

### 1. Create servers/ directory and move Gmail code
- Move `src/`, `tests/`, `pyproject.toml` into `servers/gmail-mcp/`
- Move Gmail-specific docs into `servers/gmail-mcp/docs/`

### 2. Update root README
- Make it an overview of all MCP servers
- Link to each server's README

### 3. Update imports and paths
- Update any hardcoded paths
- Test that Gmail server still works

### 4. Rename local directory
- Rename `/Users/cole/git/gmail-mcp` to `/Users/cole/git/productivity-mcp-servers`

### 5. Update git remote
- Point to new GitHub URL

### 6. Update Claude MCP config
- Update path in Claude's config to point to new location

---

## Checklist

### Implementation
- [x] Create `servers/gmail-mcp/` directory structure
- [x] Move Gmail source code to `servers/gmail-mcp/src/`
- [x] Move Gmail tests to `servers/gmail-mcp/tests/`
- [x] Move `pyproject.toml` to `servers/gmail-mcp/`
- [x] Move Gmail docs to `servers/gmail-mcp/docs/`
- [x] Move Gmail-specific plans to `servers/gmail-mcp/docs/plans/`
- [x] Keep this plan (006) in root `docs/plans/` (it's cross-cutting)
- [x] Create new root README.md
- [x] Create Gmail-specific README.md
- [x] Update copilot-instructions.md for new structure

### Testing
- [x] All unit tests passing from new location
- [x] Code linting passes
- [x] Verify Claude MCP config path and update if needed

### Cleanup
- [x] Remove old empty directories
- [x] No broken imports or paths

### Documentation
- [x] Root README lists all servers
- [x] Gmail README has full setup instructions
- [x] Mark plan as complete with date
