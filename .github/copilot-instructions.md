# Productivity MCP Servers - Copilot Instructions

A monorepo of MCP servers for productivity tools (Gmail, and more to come).

**Target clients:** Claude, Claude Code  
**Runtime:** Local only

## Principles

1. **No bloat** - Only write code needed for the feature. Remove unused code, imports, and files.
2. **Keep it simple** - Don't over-engineer or add speculative features. Build what's asked for.
3. **Auth stays local** - All credentials and tokens stay on the user's machine. Never commit secrets to the repo.

## Workflow

### 1. Understand First
Before making changes, read the relevant docs:
- Root `docs/plans/` - Cross-cutting implementation plans
- `servers/<name>/docs/` - Server-specific documentation
- `servers/<name>/README.md` - Server setup and usage

Read any other docs that exist - this is the source of truth for the project.

### 2. Plan Before Implementing
For new features or significant changes:
1. Create a plan document:
   - Server-specific: `servers/<name>/docs/plans/NNN-feature-name.md`
   - Cross-cutting: `docs/plans/NNN-feature-name.md`
2. Include: summary, API details, implementation steps, testing approach
3. **Include a checklist section** (see template below)
4. **Wait for user approval before proceeding to implementation**

#### Plan Checklist Template
Every plan must end with a checklist. **The checklist is a live status document** - check off items immediately as you complete them, not at the end.

```markdown
---

## Checklist

### Implementation
- [ ] Step 1 description
- [ ] Step 2 description
- [ ] ...

### Testing
- [ ] All unit tests written
- [ ] All unit tests passing
- [ ] Integration tests written (if applicable)
- [ ] Integration tests passing (if applicable)

### Cleanup
- [ ] Code linting passes (`ruff check src/ tests/`)
- [ ] No unused imports or dead code
- [ ] Code is readable and well-commented where needed

### Documentation
- [ ] README.md updated (if user-facing changes)
- [ ] docs/architecture.md updated (if architecture changed)
- [ ] Plan marked as complete with date
```

**⚠️ After all checklist items are complete, commit and push your changes.**

### 3. Implement
- Follow the coding guidelines below
- Make incremental, testable changes
- **Check off each checklist item immediately after completing it** - the plan is a live status document
- If you need to undo something, uncheck the relevant items

### 4. Test
- Run unit tests: `pytest tests/`
- Run linter: `ruff check src/ tests/`
- **Check off testing items immediately as each test passes**
- If tests fail, fix the code, then check off when passing

### 5. Clean Up
- Remove any unused code, imports, or files
- Simplify overly complex logic
- Re-run tests to confirm nothing broke
- **Check off cleanup items as you complete them**

### 6. Update Docs
After implementation is complete:
- Update relevant docs in `docs/` if architecture changed
- Update `README.md` with new user-facing features
- Mark plan as complete with date in the status line
- **Check off documentation items in the plan**

### 7. Commit & Push
After all checklist items are complete:
- Commit all changes with a descriptive message
- Push to remote

### 8. Verify Complete
**You are not done until every checkbox in the plan is checked and changes are pushed.**

### ⚠️ IMPORTANT
- **You are NOT done until the entire plan checklist is complete and changes are pushed.**
- **You may NOT skip any checklist item without explicit user approval.**
- If you cannot complete an item, stop and ask the user before proceeding.

---

## Project Structure

```
productivity-mcp-servers/
├── .github/
│   └── copilot-instructions.md  # These instructions
├── README.md                    # Monorepo overview
├── docs/
│   └── plans/                   # Cross-cutting plans
└── servers/
    └── gmail-mcp/               # Gmail MCP server
        ├── .venv/               # Server's virtual environment
        ├── pyproject.toml       # Server dependencies
        ├── README.md            # Server setup & usage
        ├── src/gmail_mcp/       # Source code
        ├── tests/               # Tests
        └── docs/
            ├── architecture.md
            ├── auth.md
            ├── tools.md
            └── plans/           # Gmail-specific plans
```

## Server-Specific Guidelines

### Gmail MCP (`servers/gmail-mcp/`)

**Key Technologies:**
- **MCP SDK**: `mcp` package for Model Context Protocol
- **Google APIs**: `google-api-python-client` for Gmail API
- **OAuth**: `google-auth-oauthlib` for authentication

**Coding Guidelines:**
1. **Async First**: All tool handlers must be async functions
2. **Error Handling**: Wrap Gmail API calls in try/except with helpful messages
3. **Type Hints**: Use Python type hints throughout
4. **Scopes**: Request only the Gmail API scopes needed

**Adding New Tools:**
1. Add tool definition in `list_tools()` with JSON schema
2. Add handler case in `call_tool()`
3. Implement helper function (e.g., `_new_tool()`)
4. Add tests
5. Update server README.md with tool documentation

**Testing:**
```bash
cd servers/gmail-mcp
source .venv/bin/activate
pytest tests/
ruff check src/ tests/
```
