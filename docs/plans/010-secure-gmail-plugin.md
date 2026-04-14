# Plan 010: Secure MCP Tool Plugins

**Status:** Draft  
**Created:** 2026-04-12  
**Depends on:** Plan 009 (MCP Security Hooks Library), Plan 013 (OpenClaw Plugins Scaffold)

## Summary

Build an OpenClaw plugin that wraps Gmail MCP server tools with security hooks from `packages/mcp-hooks/` (Plan 009). The plugin connects to an MCP server via stdio, discovers its tools, registers them with `api.registerTool()`, and wraps each tool's `execute()` with egress + ingress hooks.

Gmail (`openclaw-plugins/secure-gmail/`) is the first instance. The pattern is reusable for any future MCP server.

See also:
- Plan 012 — Secure web provider plugins (`web_fetch`, `web_search`)
- Plan 011 — Container network intercept for sandboxed tool traffic

## Context: How OpenClaw Plugins Work

OpenClaw plugins live in a directory with:
- `openclaw.plugin.json` — required manifest (id, name, config schema)
- `plugin.ts` — `register(api)` function that calls `api.registerTool()`, `api.registerWebFetchProvider()`, `api.on()`, etc.

Plugins are loaded by pointing OpenClaw config at plugin directories:
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

## Plugin Structure

```
openclaw-plugins/
├── secure-gmail/                   # MCP tool wrapper plugin (Surface 1)
│   ├── openclaw.plugin.json
│   ├── plugin.ts                   # register(): MCP client + api.registerTool()
│   ├── package.json
│   ├── tsconfig.json
│   └── tests/
│       └── plugin.test.ts
├── secure-web/                     # Web provider replacement plugin (Surfaces 2 + 3)
│   ├── openclaw.plugin.json
│   ├── plugin.ts                   # register(): registerWebFetchProvider + registerWebSearchProvider
│   ├── package.json
│   ├── tsconfig.json
│   └── tests/
│       └── plugin.test.ts
└── shared/                         # Shared utilities (if needed)
    ├── hooks.ts                    # Common hook initialization helpers
    └── package.json
```

All plugins depend on `packages/mcp-hooks/` from Plan 009 for the security hook implementations (ContentGuard, InjectionGuard, SecretRedactor, CopilotLLMClient, runEgressHooks, runIngressHooks).

---

## Surface 1: MCP Tool Plugins (secure-gmail)

### Overview

An OpenClaw plugin that connects to an MCP server (e.g., gmail-mcp) via stdio, discovers its tools, and registers each one with `api.registerTool()`. Each tool's `execute()` is wrapped: egress hooks run before the MCP call, ingress hooks run after.

Gmail is the first instance, but the pattern is generic for any MCP server. Future MCP tool plugins (e.g., secure-calendar, secure-slack) would follow the same structure.

### Architecture

```
OpenClaw
  │
  ├── loads secure-gmail plugin
  │     │
  │     ├── connects to gmail-mcp via MCP client (stdio)
  │     ├── discovers gmail tools (list_emails, get_email, send_email, etc.)
  │     ├── registers each tool with api.registerTool()
  │     │
  │     └── each tool.execute() wraps the MCP call:
  │           1. ContentGuard (egress) — check outgoing params
  │           2. mcpClient.callTool() — actual gmail-mcp call
  │           3. InjectionGuard + SecretRedactor (ingress, parallel) — check result
  │
  └── agent uses tools normally (security is transparent)
```

### Plugin Manifest (`openclaw.plugin.json`)

```json
{
  "id": "secure-gmail",
  "name": "Secure Gmail",
  "version": "0.1.0",
  "description": "Gmail MCP tools with egress/ingress security hooks",
  "configSchema": {
    "type": "object",
    "properties": {
      "gmailMcpCommand": {
        "type": "string",
        "description": "Path to gmail-mcp Python executable"
      },
      "trusted": {
        "type": "boolean",
        "description": "Whether Gmail is a trusted destination (allows PII in egress)",
        "default": true
      },
      "model": {
        "type": "string",
        "description": "LLM model for hook analysis",
        "default": "claude-haiku-4.5"
      }
    }
  }
}
```

### Tool Wrapping Pattern

```typescript
// plugin.ts
import { LeakGuard, SendApproval, InjectionGuard, SecretRedactor, CopilotLLMClient, TrustStore } from "mcp-hooks";

export default {
  id: "secure-gmail",

  async register(api) {
    const config = api.pluginConfig;
    
    const llm = new CopilotLLMClient({ model: config.model });
    const trustStore = new TrustStore({
      pluginId: "secure-gmail",
      extractDestination: (toolName, params) => params.to as string,
    });
    trustStore.seedDomains(config.trustedDomains ?? []);

    // Hook instances
    const leakGuard = new LeakGuard({ llm });
    const sendApproval = new SendApproval({ llm, trustStore });
    const injectionGuard = new InjectionGuard({ llm });
    const secretRedactor = new SecretRedactor({ llm });

    // Per-tool hook mapping
    const hookMap = {
      ingress: ["get_email", "list_emails", "get_attachments"],  // InjectionGuard + SecretRedactor
      skip: ["authenticate", "archive_email", "add_label"],
      // egress hooks added when send_email is implemented
    };

    // Connect to gmail-mcp server via stdio
    const mcpClient = await connectMcpServer(config.gmailMcpCommand);
    
    // Discover and register all gmail tools
    const tools = await mcpClient.listTools();
    for (const tool of tools) {
      if (hookMap.skip.includes(tool.name)) {
        api.registerTool(tool); // register as-is, no wrapping
        continue;
      }
      const egress = [
        ...(hookMap.egress.leakGuard.includes(tool.name) ? [leakGuard] : []),
        ...(hookMap.egress.sendApproval.includes(tool.name) ? [sendApproval] : []),
      ];
      const ingress = [
        ...(hookMap.ingress.injectionGuard.includes(tool.name) ? [injectionGuard] : []),
        ...(hookMap.ingress.secretRedactor.includes(tool.name) ? [secretRedactor] : []),
      ];
      api.registerTool(wrapWithHooks(tool, mcpClient, { egress, ingress }));
    }
  }
};

// Wraps an MCP tool with egress/ingress hooks
function wrapWithHooks(tool, mcpClient, hooks) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    async execute(params) {
      // EGRESS: run each hook, stop on first block
      for (const hook of hooks.egress ?? []) {
        const result = await hook.check(tool.name, params);
        if (result.action === "block") return { error: `Blocked: ${result.reason}` };
      }

      // TOOL: call gmail-mcp
      const result = await mcpClient.callTool(tool.name, params);
      const resultText = extractText(result);

      // INGRESS: run in parallel
      if (hooks.ingress?.length) {
        const results = await Promise.all(
          hooks.ingress.map(h => h.check(tool.name, resultText))
        );
        const blocked = results.find(r => r.action === "block");
        if (blocked) return { error: `Blocked: ${blocked.reason}` };
        const modified = results.find(r => r.action === "modify");
        if (modified) return modified.content;
      }

      return resultText;
    }
  };
}
```

### Per-Tool Hook Summary

| Direction | Tools | Hooks |
|-----------|-------|-------|
| **Ingress** | `get_email`, `list_emails`, `get_attachments` | InjectionGuard + SecretRedactor |
| *(skip)* | `authenticate`, `archive_email`, `add_label` | — |
| *(future: egress)* | `send_email` (when built) | LeakGuard + SendApproval |

### Reusable Pattern for Future MCP Tool Plugins

The secure-gmail plugin establishes a generic pattern for wrapping any MCP server:
1. Accept MCP server command path in plugin config
2. Connect via stdio using `@modelcontextprotocol/sdk`
3. Discover tools with `listTools()`
4. Register each with `api.registerTool()`, wrapping `execute()` with hooks
5. Plugin config controls: trusted flag, model override, per-tool hook overrides

Future instances (e.g., secure-calendar, secure-slack) copy this structure and only change the config schema and per-tool hook configuration.

---

## OpenClaw Configuration

```json
{
  "plugins": {
    "load": {
      "paths": ["~/git/productivity-mcp-servers/openclaw-plugins/secure-gmail"]
    },
    "entries": {
      "secure-gmail": {
        "config": {
          "gmailMcpCommand": "~/git/productivity-mcp-servers/servers/gmail-mcp/.venv/bin/python",
          "gmailMcpArgs": ["-m", "gmail_mcp"],
          "trusted": true,
          "model": "claude-haiku-4.5"
        }
      }
    }
  }
}
```

---

## Checklist

### Implementation
- [ ] Create `openclaw-plugins/secure-gmail/` directory structure
- [ ] Write `openclaw.plugin.json` manifest
- [ ] Write `plugin.ts` with MCP client connection + tool discovery + registration
- [ ] Wire mcp-hooks egress + ingress into each tool's `execute()`
- [ ] Handle per-tool hook configuration (or apply all hooks uniformly for v1)
- [ ] Write `package.json` with dependencies on `mcp-hooks` and `@modelcontextprotocol/sdk`

### Testing

**Unit tests (mocked dependencies, fast):**
- [ ] `wrapWithHooks()` correctly applies egress hooks before MCP call
- [ ] `wrapWithHooks()` correctly applies ingress hooks after MCP call
- [ ] Egress block prevents MCP call from executing
- [ ] Ingress block returns error instead of tool result
- [ ] Ingress modify returns redacted content
- [ ] Hook map correctly routes hooks to tools
- [ ] Skipped tools pass through without hooks
- [ ] Unknown tools get default hooks

**Integration tests (real Copilot API, requires PAT in keychain):**
- [ ] Plugin loads correctly in OpenClaw
- [ ] Tools are discovered from gmail-mcp and registered
- [ ] Full flow: InjectionGuard blocks injected email content
- [ ] Full flow: SecretRedactor redacts 2FA code in email body
- [ ] Full flow: clean email content passes through unmodified
- [ ] No regressions in normal tool behavior (authenticate, archive, add_label)

### Cleanup
- [ ] No unused imports or dead code
- [ ] Code is readable and well-commented where needed

### Documentation
- [ ] README.md with setup instructions
- [ ] OpenClaw config example in README
- [ ] Plan marked as complete with date
