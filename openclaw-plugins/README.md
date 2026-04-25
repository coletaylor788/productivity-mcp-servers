# OpenClaw Plugins

OpenClaw plugins live here. Each subfolder is a self-contained plugin that
[OpenClaw](https://openclaw.dev) loads via `plugins.load.paths` configuration.

These plugins consume [`packages/mcp-hooks`](../packages/mcp-hooks/) to wrap
MCP tools and OpenClaw providers with security checks (egress leak detection,
ingress prompt-injection detection, secret redaction, send approval flows).

## Layout

```
openclaw-plugins/
├── README.md                  # this file
└── <plugin>/
    ├── openclaw.plugin.json   # OpenClaw manifest (id, name, version, configSchema)
    ├── plugin.ts              # default export with register(api) function
    ├── package.json           # depends on "mcp-hooks": "workspace:*"
    └── tsconfig.json          # extends ../../tsconfig.base.json
```

The folder is currently empty — concrete plugins are added by:

| Plugin | Plan | Purpose |
|---|---|---|
| `secure-gmail` | [010](../docs/plans/010-secure-gmail-plugin.md) | Wraps Gmail MCP tools with egress + ingress hooks |
| `secure-web` | [012](../docs/plans/012-secure-web-providers.md) | Replaces OpenClaw's built-in `web_fetch` / `web_search` providers with hook-wrapped versions |

Plans 011 (async injection-guard) and 014 (egress approval) will add further
plugins to this folder.

## Prerequisites

- [OpenClaw](https://openclaw.dev) installed
- GitHub Copilot subscription (mcp-hooks classifies via the Copilot API)
- GitHub PAT stored in macOS Keychain — see
  [`packages/mcp-hooks/README.md`](../packages/mcp-hooks/README.md#credential-setup)

## Installing dependencies

This monorepo uses **pnpm workspaces**. From the repo root:

```bash
pnpm install
```

This links `mcp-hooks` into each plugin via `workspace:*`, so changes to the
hooks library are picked up immediately without republishing.

## Registering a plugin with OpenClaw

Add the plugin's absolute path to your OpenClaw config:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/Users/<you>/git/puddles/openclaw-plugins/secure-gmail",
        "/Users/<you>/git/puddles/openclaw-plugins/secure-web"
      ]
    }
  }
}
```

Per-plugin configuration (trusted domains, model overrides, etc.) goes under
the plugin's id in OpenClaw's `plugins.config` section — see each plugin's
README for its schema.

## Conventions

Every plugin in this folder must:

1. Ship an `openclaw.plugin.json` manifest with `id`, `name`, `version`, and a
   JSON Schema for any plugin-specific configuration.
2. Export a default `register(api)` function from `plugin.ts` that wires the
   appropriate `mcp-hooks` hooks into OpenClaw's tool / provider pipeline.
3. Depend on `mcp-hooks` via `"workspace:*"` (never publish to npm).
4. Extend the root `tsconfig.base.json` instead of redefining compiler
   options.
5. Fail open on hook errors (the hooks library does this internally; plugins
   should not re-block on caught exceptions).
6. Surface `HookResult.reason` and any `SendApprovalResult.approval` payload
   through OpenClaw's user-facing approval UX rather than logging silently.

See [`packages/mcp-hooks/docs/architecture.md`](../packages/mcp-hooks/docs/architecture.md)
for the underlying hook contracts.
