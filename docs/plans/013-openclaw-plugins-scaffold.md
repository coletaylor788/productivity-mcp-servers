# Plan 013: OpenClaw Plugins Scaffold

**Status:** Draft  
**Created:** 2026-04-12  
**Depends on:** Plan 009 (MCP Security Hooks Library)

## Summary

Set up the `openclaw-plugins/` folder structure in this repo as the home for OpenClaw plugins that consume `packages/mcp-hooks/`. This plan establishes shared infrastructure, conventions, and the base pattern that individual plugins (Plans 010, 012) build on.

## Why a Separate Folder

OpenClaw's `extensions/` folder lives in the OpenClaw repo. Our plugins live here in `productivity-mcp-servers` and are loaded by OpenClaw via `plugins.load.paths` config. Keeping them in a dedicated `openclaw-plugins/` folder (separate from `servers/` and `packages/`) makes the boundary clear.

## Folder Structure

```
productivity-mcp-servers/
├── packages/
│   └── mcp-hooks/              ← Plan 009: hook logic library
├── openclaw-plugins/
│   ├── README.md               ← Overview, how to register with OpenClaw
│   ├── secure-gmail/           ← Plan 010: Gmail MCP tool plugin
│   │   ├── openclaw.plugin.json
│   │   ├── plugin.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── secure-web/             ← Plan 012: web_fetch + web_search providers
│       ├── openclaw.plugin.json
│       ├── plugin.ts
│       ├── package.json
│       └── tsconfig.json
└── servers/
    └── gmail-mcp/              ← Existing MCP server (Python, unchanged)
```

## OpenClaw Plugin Conventions

Every plugin in this folder follows:

1. **`openclaw.plugin.json`** — Required manifest with id, name, version, configSchema
2. **`plugin.ts`** — Default export with `register(api)` function
3. **`package.json`** — Depends on `mcp-hooks` (local workspace reference)
4. **`tsconfig.json`** — Extends a shared base config if needed

## Shared Dependencies

All plugins depend on `packages/mcp-hooks/`. Use a workspace setup so plugins reference it locally:

```json
{
  "dependencies": {
    "mcp-hooks": "workspace:*"
  }
}
```

This requires a root-level workspace config (pnpm-workspace.yaml, or npm/yarn workspaces in root package.json).

## Workspace Config

**pnpm workspaces** (matches OpenClaw's ecosystem):

```yaml
# pnpm-workspace.yaml (at repo root)
packages:
  - packages/*
  - openclaw-plugins/*
```

## OpenClaw Registration

Users add plugins to their OpenClaw config:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "~/git/productivity-mcp-servers/openclaw-plugins/secure-gmail",
        "~/git/productivity-mcp-servers/openclaw-plugins/secure-web"
      ]
    }
  }
}
```

## README Content

The `openclaw-plugins/README.md` should cover:
- What these plugins do (security hooks for OpenClaw tools)
- Prerequisites (OpenClaw installed, GitHub Copilot subscription, PAT in keychain)
- How to register plugins with OpenClaw
- Per-plugin config examples
- Link to Plan 009 / `packages/mcp-hooks/` for the underlying hook logic

---

## Checklist

### Implementation
- [ ] Create `openclaw-plugins/` directory
- [ ] Create root workspace config (pnpm-workspace.yaml or package.json workspaces)
- [ ] Create root `tsconfig.base.json` for shared TypeScript config
- [ ] Verify workspace linking works (`mcp-hooks` importable from plugins)

### Documentation
- [ ] Write `openclaw-plugins/README.md`
- [ ] Update root `README.md` with new folder in architecture diagram
- [ ] Plan marked as complete with date
