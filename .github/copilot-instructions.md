# Gmail MCP Server - Copilot Instructions

Python-based MCP server for Gmail integration with AI assistants.

**Target clients:** Claude, Claude Code  
**Runtime:** Local only

## Principles

1. **No bloat** - Only write code needed for the feature. Remove unused code, imports, and files.
2. **Keep it simple** - Don't over-engineer or add speculative features. Build what's asked for.
3. **Auth stays local** - All credentials and tokens stay on the user's machine. Never commit secrets to the repo.

## Workflow

### 1. Understand First
Before making changes, read the `docs/` directory to understand the current state:
- `docs/` - All project documentation (architecture, patterns, decisions)
- `docs/plans/` - Implementation plans for features in progress
- `README.md` - User-facing documentation

Read any other docs that exist - this is the source of truth for the project.

### 2. Plan Before Implementing
For new features or significant changes:
1. Create a plan document in `docs/plans/` (e.g., `docs/plans/002-feature-name.md`)
2. Include: summary, API details, implementation steps, testing approach
3. **Include a checklist section** (see template below)
4. **Wait for user approval before proceeding to implementation**

#### Plan Checklist Template
Every plan must end with a checklist like this:

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
- [ ] docs/SURVEY.md updated (if architecture changed)
- [ ] Plan marked as complete with date
```

### 3. Implement
- Follow the coding guidelines below
- Make incremental, testable changes
- **Update the plan checklist as you complete each step**
- Check off implementation items as they're done

### 4. Test
- Run unit tests: `pytest tests/`
- Run linter: `ruff check src/ tests/`
- **Check off testing items in the plan as tests pass**
- If tests fail and you need to change code, **uncheck the relevant implementation items** and fix them

### 5. Clean Up
- Remove any unused code, imports, or files
- Simplify overly complex logic
- Re-run tests to confirm nothing broke
- **Check off cleanup items in the plan**

### 6. Update Docs
After implementation is complete:
- Update relevant docs in `docs/` if architecture changed
- Update `README.md` with new user-facing features
- Mark plan as complete with date in the status line
- **Check off documentation items in the plan**

### 7. Verify Complete
**You are not done until every checkbox in the plan is checked.**
Review the checklist one final time before declaring the task complete.

### ⚠️ IMPORTANT
- **You are NOT done until the entire plan checklist is complete.**
- **You may NOT skip any checklist item without explicit user approval.**
- If you cannot complete an item, stop and ask the user before proceeding.

---

## Project Structure

```
gmail-mcp/
├── src/gmail_mcp/       # Source code
│   ├── server.py        # MCP server implementation
│   └── __init__.py      # Package init
├── docs/                # Documentation
│   ├── SURVEY.md        # Repo overview & architecture
│   └── plans/           # Implementation plans
├── tests/               # Test files
├── pyproject.toml       # Dependencies & config
└── README.md            # User docs
```

## Key Technologies

- **MCP SDK**: `mcp` package for Model Context Protocol
- **Google APIs**: `google-api-python-client` for Gmail API
- **OAuth**: `google-auth-oauthlib` for authentication

## Coding Guidelines

1. **Async First**: All tool handlers must be async functions
2. **Error Handling**: Wrap Gmail API calls in try/except with helpful messages
3. **Type Hints**: Use Python type hints throughout
4. **Scopes**: Request only the Gmail API scopes needed

## Adding New Tools

1. Add tool definition in `list_tools()` with JSON schema
2. Add handler case in `call_tool()`
3. Implement helper function (e.g., `_new_tool()`)
4. Add tests
5. Update README.md with tool documentation

## Testing

Run tests with `pytest`. Mock Gmail API calls to avoid requiring credentials.
