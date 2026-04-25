# Plan 010: Secure MCP Tool Plugins

**Status:** In Progress  
**Created:** 2026-04-12  
**Depends on:** Plan 009 (MCP Security Hooks Library) ✅, Plan 013 (OpenClaw Plugins Scaffold) ✅

## Summary

Build an OpenClaw plugin that wraps Gmail MCP server tools with security hooks from `packages/mcp-hooks/` (Plan 009). The plugin connects to an MCP server via stdio, discovers its tools, registers them with `api.registerTool()`, and wraps each tool's `execute()` with egress + ingress hooks.

Gmail (`openclaw-plugins/secure-gmail/`) is the first instance. The pattern is reusable for any future MCP server.

## Why wrap `execute()` (not OpenClaw lifecycle hooks)

Verified against OpenClaw 1.x plugin SDK source (`/opt/homebrew/lib/node_modules/openclaw/dist/`):

| OpenClaw hook | Async support | Can block / modify result | Verdict for our use case |
|---|---|---|---|
| `before_tool_call` | ✅ awaits handler | block + modify params | ✅ Suitable for egress (LeakGuard / SendApproval) — needs awaiting LLM |
| `after_tool_call` | ✅ async, **fire-and-forget** | observation only | ❌ Cannot modify result |
| `tool_result_persist` | ❌ **sync only** (Promises rejected) | modify message before transcript write | ❌ Cannot await ingress LLM check |
| `before_message_write` | ❌ **sync only** | block + modify message | ❌ Same problem |

Ingress hooks (`InjectionGuard`, `SecretRedactor`) require awaiting LLM calls, so they cannot live in `tool_result_persist` / `before_message_write`. The only place to run async work in the result path is **inside the registered tool's `execute()` itself**, which OpenClaw fully awaits. This matches the plan's original wrapping approach.

For v1, gmail-mcp has no send-style tools, so we only need ingress. When `send_email` lands, egress can be added either in the same `execute()` wrapper or via `api.on("before_tool_call")` (both work; we'll pick whichever composes best at that time).

See also:
- Plan 012 — Secure web provider plugins (`web_fetch`, `web_search`)
- Plan 014 — Egress approval plugin (when `send_email` lands)
- Plan 017 — Secure Apple Calendar plugin (calendar only; same wrapping pattern, sister plugin. Reminders/contacts intentionally unwrapped — see 017 for rationale)

## Addendum (2026-04-24): Gmail Delegation Auth

**Decision:** Puddles operates on Cole's Gmail via Google's [delegate access](https://support.google.com/mail/answer/138350) feature, not by holding Cole's credentials. Puddles authenticates as `puddles@gmail.com` and Cole grants delegate access on `cole@gmail.com`. Apple Mail (and IMAP/SMTP in general) cannot be used for this — IMAP has no concept of delegated mailboxes; only the Gmail API supports it.

**Implications for `gmail-mcp` and this plugin:**

1. **`userId` parameter must be the delegated address, not `me`.** All Gmail API calls (`users.messages.list`, `users.messages.send`, etc.) take a `userId` path parameter. Authenticated-as-self uses `me`; delegated access uses the target address (`cole@gmail.com`). `gmail-mcp` needs to support a configurable `userId` (default `me`, but settable per plugin config).
2. **OAuth scopes don't change.** Standard Gmail scopes (`gmail.readonly`, `gmail.send`, `gmail.modify`) apply; Google enforces what the delegate can do server-side (delegates cannot change settings, manage filters, or rotate the password — useful security ceiling).
3. **`Send mail as` header behavior.** By default, mail sent via delegated access shows "from cole@gmail.com (sent by puddles@gmail.com)". Cole can toggle "show sender as the delegator only" in Gmail settings. `SendApproval` UX should display the From: address as the user will actually see it, including the "on behalf of" line.
4. **Token refresh & failure modes.** If Cole revokes delegate access, the next Gmail API call returns 403 / `Delegation denied`. Plugin should surface this clearly (not as a generic auth failure) so Cole can see "I revoked access; this is expected" without burning debugging time.
5. **No effect on the wrapping architecture.** All Plan 010 hook wiring (LeakGuard, SendApproval, InjectionGuard, SecretRedactor) sits above the API call. The `userId` parameter is opaque to hooks. Hook implementation is unchanged by this decision.

**Action items** (track in this plan's checklist when implementation resumes):
- [ ] Verify `gmail-mcp` accepts a configurable `userId` (or default `me`); add support if missing.
- [ ] Add `delegatedUserId` to the secure-gmail plugin config schema; pass through to gmail-mcp.
- [ ] Update README setup to document the Google-side delegate-access grant procedure.
- [ ] Surface "Delegation denied" 403 distinctly in plugin error mapping.

## Context: How OpenClaw Plugins Work

OpenClaw plugins live in a directory with:
- `openclaw.plugin.json` — required manifest (id, configSchema, etc.)
- A module exporting either `{ id, register(api) }` or a `(api) => void` function
- Inside `register()`, plugins call `api.registerTool()`, `api.on(hookName, handler)`, etc.

Plugins are loaded by pointing OpenClaw config at plugin directories:
```json
{
  "plugins": {
    "load": {
      "paths": ["~/git/puddles/openclaw-plugins/secure-gmail"]
    }
  }
}
```

## Plugin Structure (v1)

```
openclaw-plugins/secure-gmail/
├── openclaw.plugin.json     # manifest: id + configSchema
├── package.json             # workspace:* dep on mcp-hooks, peer-dep on openclaw
├── tsconfig.json            # extends ../../tsconfig.base.json
├── src/
│   ├── plugin.ts            # default export: { id, register(api) }
│   ├── mcp-bridge.ts        # spawn gmail-mcp via stdio, list/call tools
│   └── wrap-tool.ts         # wrap MCP tool with hooks, return AnyAgentTool
├── tests/
│   ├── wrap-tool.test.ts    # unit tests with mocked MCP client + hooks
│   └── mcp-bridge.test.ts
└── README.md
```

Depends on `packages/mcp-hooks/` for `LeakGuard`, `SendApproval`, `InjectionGuard`, `SecretRedactor`, `CopilotLLMClient`, `TrustStore`.

---

## Architecture

```
OpenClaw
  │
  ├── loads secure-gmail plugin
  │     │
  │     ├── spawns gmail-mcp via stdio (@modelcontextprotocol/sdk client)
  │     ├── lists gmail tools (list_emails, get_email, get_attachments, ...)
  │     ├── for each tool: api.registerTool(wrapWithHooks(tool, mcpClient, hooks))
  │     │
  │     └── each registered tool's execute() does:
  │           1. (v2) Egress hooks — check outgoing params, await, may block
  │           2. await mcpClient.callTool(name, params)
  │           3. Ingress hooks (InjectionGuard + SecretRedactor in parallel) — await
  │           4. Return blocked / redacted / passthrough text
  │
  └── agent uses tools normally; security is transparent
```

### Plugin Manifest (`openclaw.plugin.json`)

```json
{
  "id": "secure-gmail",
  "name": "Secure Gmail",
  "version": "0.1.0",
  "description": "Gmail MCP tools with ingress security hooks (injection guard + secret redactor)",
  "configSchema": {
    "type": "object",
    "required": ["gmailMcpCommand"],
    "properties": {
      "gmailMcpCommand": {
        "type": "string",
        "description": "Path to the gmail-mcp Python interpreter (e.g. .venv/bin/python)"
      },
      "gmailMcpArgs": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Args passed to gmailMcpCommand to launch the MCP server",
        "default": ["-m", "gmail_mcp"]
      },
      "gmailMcpCwd": {
        "type": "string",
        "description": "Working directory for the gmail-mcp subprocess (optional)"
      },
      "model": {
        "type": "string",
        "description": "Copilot model used by hook LLM checks",
        "default": "claude-haiku-4.5"
      },
      "skipTools": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Tool names to register without ingress hooks (default: authenticate, archive_email, add_label)",
        "default": ["authenticate", "archive_email", "add_label"]
      }
    }
  }
}
```

### Tool Wrapping Pattern (v1, ingress-only)

```typescript
// src/plugin.ts
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { InjectionGuard, SecretRedactor, CopilotLLMClient } from "mcp-hooks";
import { connectGmailMcp } from "./mcp-bridge.js";
import { wrapWithHooks } from "./wrap-tool.js";

export default {
  id: "secure-gmail",

  async register(api: OpenClawPluginApi) {
    const config = api.pluginConfig as {
      gmailMcpCommand: string;
      gmailMcpArgs?: string[];
      gmailMcpCwd?: string;
      model?: string;
      skipTools?: string[];
    };

    const llm = new CopilotLLMClient({ model: config.model ?? "claude-haiku-4.5" });
    const injectionGuard = new InjectionGuard({ llm });
    const secretRedactor = new SecretRedactor({ llm });
    const skip = new Set(config.skipTools ?? ["authenticate", "archive_email", "add_label"]);

    const mcpClient = await connectGmailMcp({
      command: config.gmailMcpCommand,
      args: config.gmailMcpArgs ?? ["-m", "gmail_mcp"],
      cwd: config.gmailMcpCwd,
    });

    const { tools } = await mcpClient.listTools();
    for (const tool of tools) {
      if (skip.has(tool.name)) {
        api.registerTool(wrapWithHooks(tool, mcpClient, { ingress: [] }));
      } else {
        api.registerTool(wrapWithHooks(tool, mcpClient, {
          ingress: [injectionGuard, secretRedactor],
        }));
      }
    }
  },
};
```

```typescript
// src/wrap-tool.ts
export function wrapWithHooks(tool, mcpClient, hooks) {
  return {
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.inputSchema,
    async execute(params: Record<string, unknown>) {
      const raw = await mcpClient.callTool({ name: tool.name, arguments: params });
      const text = extractText(raw);

      if (!hooks.ingress?.length) return text;

      const verdicts = await Promise.all(
        hooks.ingress.map(h => h.check(tool.name, text)),
      );
      const blocked = verdicts.find(v => v.action === "block");
      if (blocked) return `[secure-gmail] blocked: ${blocked.reason}`;

      // Apply each modify in order; redactors compose
      let current = text;
      for (const v of verdicts) {
        if (v.action === "modify" && typeof v.content === "string") current = v.content;
      }
      return current;
    },
  };
}
```

### Per-Tool Hook Summary

| Direction | Tools | Hooks |
|-----------|-------|-------|
| **Ingress (v1)** | `list_emails`, `get_email`, `get_attachments` | InjectionGuard + SecretRedactor |
| *(skip, v1)* | `authenticate`, `archive_email`, `add_label` | — |
| *(future v2 egress)* | `send_email` (when built) | LeakGuard + SendApproval |

### Reusable Pattern for Future MCP Tool Plugins

The secure-gmail plugin establishes a generic pattern for wrapping any MCP server:
1. Accept MCP server command/args in plugin config
2. Connect via stdio using `@modelcontextprotocol/sdk`
3. Discover tools with `listTools()`
4. Register each via `api.registerTool()`, wrapping `execute()` with hooks
5. Plugin config controls model and per-tool skip list

Future instances (e.g., secure-calendar, secure-slack) copy this structure and only change the manifest's `id`/defaults.

---

## OpenClaw Configuration

```json
{
  "plugins": {
    "load": {
      "paths": ["~/git/puddles/openclaw-plugins/secure-gmail"]
    },
    "entries": {
      "secure-gmail": {
        "config": {
          "gmailMcpCommand": "~/git/puddles/servers/gmail-mcp/.venv/bin/python",
          "gmailMcpArgs": ["-m", "gmail_mcp"],
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
- [x] Create `openclaw-plugins/secure-gmail/` directory + workspace `package.json` (workspace:* dep on `mcp-hooks`, peer-dep on `openclaw`, dep on `@modelcontextprotocol/sdk`)
- [x] Add `tsconfig.json` extending `../../tsconfig.base.json`
- [x] Write `openclaw.plugin.json` manifest with full configSchema
- [x] Implement `src/mcp-bridge.ts` (spawn gmail-mcp via stdio, expose `listTools` / `callTool`, clean shutdown)
- [x] Implement `src/wrap-tool.ts` (`wrapMcpTool`, ingress await + Promise.all, block / modify / passthrough)
- [x] Implement `src/plugin.ts` (default-exported `{ id, register(api) }`, instantiate hooks, register each tool)
- [x] Run `pnpm install` at root and verify workspace resolves

### Testing

**Unit tests (mocked MCP client + mocked hooks, fast) — 20/20 passing:**
- [x] `wrapMcpTool` calls `mcpClient.callTool` with the right name/params
- [x] Ingress hooks run in parallel via `Promise.all`
- [x] Ingress `block` verdict → returns blocked sentinel, never reveals raw content
- [x] Ingress `modify` verdict → returns modified content
- [x] Multiple modify verdicts compose (last write wins on shared text)
- [x] Skipped tools register without ingress hook invocation
- [x] Falls back to empty schema when MCP tool has no `inputSchema`
- [x] `mcp-bridge` lifecycle (connect/listTools/callTool/close) including idempotency

**Automated integration tests (real subprocess + real LLM) — 6/6 passing:**
- [x] Spawn real gmail-mcp via stdio, complete handshake, `listTools` returns the expected tool surface
- [x] gmail-mcp returns `isError: true` (not a thrown protocol error) for unknown tool names
- [x] Real `InjectionGuard` blocks a clear prompt-injection email body via Copilot API
- [x] Real `InjectionGuard` allows a clean email body
- [x] Real `SecretRedactor` redacts a 6-digit 2FA code
- [x] Real `SecretRedactor` leaves clean prose untouched

**Manual end-to-end smoke (requires gmail-mcp OAuth + OpenClaw running):**
- [ ] Plugin loads in OpenClaw (`openclaw plugins list` shows secure-gmail)
- [ ] All gmail tools appear and are callable from an agent session
- [ ] Injected email body triggers InjectionGuard block end-to-end
- [ ] 2FA code in email body is redacted end-to-end
- [ ] Clean email passes through unmodified
- [ ] `authenticate`, `archive_email`, `add_label` work without hook overhead

### Cleanup
- [x] No unused imports or dead code (`pnpm lint` clean)
- [x] Code is readable and well-commented where needed

### Documentation
- [x] Plugin `README.md` with setup, OpenClaw config example, manual test steps
- [ ] Plan marked as Complete with date (after manual e2e smoke test)
