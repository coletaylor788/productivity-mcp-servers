# Productivity MCP Servers

A collection of [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) servers for productivity tools. These servers enable AI assistants like Claude to interact with your productivity apps.

## Servers

| Server | Description | Status |
|--------|-------------|--------|
| [gmail-mcp](./servers/gmail-mcp/) | Gmail integration - read, search, and manage emails | ✅ Ready |

## Quick Start

Each server is self-contained with its own dependencies and setup instructions. See the individual server READMEs for details.

### Gmail MCP

```bash
cd servers/gmail-mcp
python -m venv .venv
source .venv/bin/activate
pip install -e .
```

See [servers/gmail-mcp/README.md](./servers/gmail-mcp/README.md) for full setup instructions including Google OAuth configuration.

## Architecture

```
productivity-mcp-servers/
├── servers/
│   └── gmail-mcp/          # Gmail server (self-contained)
│       ├── .venv/          # Server-specific virtual environment
│       ├── pyproject.toml  # Server dependencies
│       ├── src/            # Server source code
│       ├── tests/          # Server tests
│       └── docs/           # Server documentation
├── docs/
│   └── plans/              # Cross-cutting implementation plans
└── .github/
    └── copilot-instructions.md  # Development guidelines
```

Each server:
- Has its own `pyproject.toml` and virtual environment
- Is fully self-contained and independently installable
- Has its own README with setup and usage instructions

## Adding a New Server

1. Create a new directory under `servers/`
2. Add `pyproject.toml`, `src/`, `tests/`, and `README.md`
3. Create a virtual environment: `python -m venv .venv`
4. Add the server to the table above

## Development

See [.github/copilot-instructions.md](./.github/copilot-instructions.md) for development guidelines.

## License

MIT