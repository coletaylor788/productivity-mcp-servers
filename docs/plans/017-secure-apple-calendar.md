# Plan 017: Secure Apple Calendar Plugin

**Status:** Draft
**Created:** 2026-04-24
**Depends on:** Plan 009 (MCP Security Hooks Library) ✅, Plan 013 (OpenClaw Plugins Scaffold) ✅, Plan 016 §4 (Apple PIM install)
**Companion to:** Plan 010 (Secure Gmail Plugin) — same architecture, different MCP server

## Summary

Build an OpenClaw plugin (`openclaw-plugins/secure-apple-calendar/`) that wraps **Apple PIM Agent Plugin** ([omarshahine/Apple-PIM-Agent-Plugin](https://github.com/omarshahine/Apple-PIM-Agent-Plugin)) **calendar tools only** with security hooks from `packages/mcp-hooks/`. Reuses the Plan 010 wrapping pattern verbatim.

**Scope decision (narrowed from earlier draft):**

| Domain | Wrapped? | Reasoning |
|---|---|---|
| **Calendar** | ✅ Yes | CalDAV invitations egress to external email addresses → real SendApproval surface. Shared calendars carry external content → real InjectionGuard surface. |
| **Reminders** | ❌ No | No egress (local lists; shared iCloud lists are limited to a fixed family set). No PII beyond what user typed. Wrapping adds friction with no real threat. |
| **Contacts** | ❌ No (with caveat) | No egress surface of its own. Exfil-by-composition risk is already mitigated upstream: main agent has no `web_fetch`, and any email/calendar egress flows through *those* plugins' SendApproval. See "Contacts: Optional Follow-Up" below. |
| **Mail** | ❌ No | Owned by Plan 010 (Gmail via delegation). Disabled in apple-pim config. |

So this plugin is laser-focused: **wrap apple-pim's calendar tools, disable everything else at the apple-pim layer.**

## How It Fits

```
Plan 009: mcp-hooks library (LeakGuard, SendApproval, InjectionGuard, SecretRedactor)
   │
   ├── Plan 010: secure-gmail            → wraps gmail-mcp (delegated Gmail API)
   └── Plan 017: secure-apple-calendar   → wraps apple-pim MCP (calendar only)
```

Reminders + contacts are accessed by the agent unwrapped (or not at all, if we keep them disabled in apple-pim config and only enable when actually needed).

## Why MCP-Bridged (Path A)

Apple-pim ships dual modes: a stdio MCP server (built for Claude Code) and a "native" OpenClaw plugin that calls `api.registerTool()` directly. We use the **MCP server** because:

1. **Plan 010's pattern is verbatim reusable.** The plugin spawns the MCP server via stdio, lists tools, wraps each `execute()` with hooks. No fork, no upstream coupling.
2. **Ingress hooks must live inside `execute()`.** Per Plan 010 hook research, `tool_result_persist` and `before_message_write` are sync-only — they can't await an LLM. The only way to run async ingress checks on apple-pim's results is to control its tools' `execute()` function. The MCP bridge gives us that ownership.
3. **Avoids a fork.** A native-plugin path would require either forking apple-pim-agent-plugin to embed hooks, or accepting egress-only via `before_tool_call` (losing ingress on a tool surface where ingress is the dominant risk — meeting descriptions from external attendees carry the highest injection risk in our entire stack).

## Apple-PIM Domain Configuration

Apple-pim supports per-domain on/off. We disable everything except calendar:

```jsonc
// Passed through to apple-pim MCP server env (exact var names TBD during impl)
{
  "domains": {
    "calendar":  true,
    "reminders": false,   // not wrapped; keep disabled until a use case appears
    "contacts":  false,   // see "Contacts: Optional Follow-Up"
    "mail":      false    // owned by gmail-mcp + secure-gmail
  }
}
```

If/when reminders or contacts become genuinely useful to the agent, revisit the threat model and either enable unwrapped (low-risk surfaces) or write a small targeted hook (e.g., a `pii-redactor` for contacts.search results — see below).

## Architecture

```
OpenClaw
  │
  ├── loads secure-apple-calendar plugin
  │     │
  │     ├── spawns apple-pim MCP server via stdio (calendar domain only)
  │     ├── lists tools (list_events, create_event, update_event, …)
  │     ├── for each tool: api.registerTool(wrapWithHooks(tool, mcpClient, perToolHooks(name)))
  │     │
  │     └── each registered tool's execute() does:
  │           1. Egress hooks — for create_event/update_event with attendees → SendApproval
  │           2. await mcpClient.callTool(name, params)
  │           3. Ingress hooks (InjectionGuard + SecretRedactor in parallel) for read paths
  │           4. Return blocked / redacted / passthrough text
  │
  └── agent uses tools normally; security is transparent
```

### Plugin Manifest (`openclaw.plugin.json`)

```json
{
  "id": "secure-apple-calendar",
  "name": "Secure Apple Calendar",
  "version": "0.1.0",
  "description": "Apple Calendar MCP tools with egress/ingress security hooks",
  "configSchema": {
    "type": "object",
    "properties": {
      "applePimMcpCommand": {
        "type": "string",
        "description": "Command to spawn the apple-pim MCP server (e.g. 'npx apple-pim-cli')"
      },
      "applePimMcpArgs": {
        "type": "array",
        "items": { "type": "string" },
        "default": []
      },
      "applePimMcpEnv": {
        "type": "object",
        "description": "Env vars passed to the apple-pim MCP server. Use this to disable non-calendar domains."
      },
      "trustedAttendeeDomains": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Attendee email domains that auto-pass SendApproval (e.g. work + personal)",
        "default": []
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

## Per-Tool Hook Map

Tool names are the expected apple-pim MCP names; verify against the running server during implementation.

| Direction | Tools | Hooks | Rationale |
|---|---|---|---|
| **Ingress** | `list_events`, `get_event`, `search_events` | InjectionGuard + SecretRedactor | Shared calendars (Cole→Puddles per Plan 016 §4.2) carry external content; meeting descriptions and notes are unsanitized; conferencing URLs frequently embed passcodes / one-time tokens |
| **Egress** | `create_event`, `update_event` (with attendees) | **SendApproval** | CalDAV invitation = email egress. `extractDestination` pulls attendee emails from event params, not `params.to` |
| **Egress** | `create_event`, `update_event` (no attendees) | LeakGuard | Local mutation; LeakGuard catches accidental secret/PII writes into event titles/descriptions/notes |
| *(skip)* | `delete_event`, `list_calendars` | — | Pure mutations / metadata reads with no exfil channel |

**SendApproval `extractDestination` for calendar:** unlike email's `params.to`, calendar events carry attendees as a structured list. The destination for trust evaluation is the set of attendee email addresses (deduped, lowercased). Multi-attendee events are evaluated against the highest-trust-required attendee. `trustedAttendeeDomains` config provides an allowlist so common meetings don't generate constant approval prompts.

## Plugin Structure

Mirrors `openclaw-plugins/secure-gmail/`:

```
openclaw-plugins/secure-apple-calendar/
├── openclaw.plugin.json
├── package.json              # workspace:* dep on mcp-hooks
├── tsconfig.json
├── src/
│   ├── plugin.ts             # default export { id, register(api) }
│   ├── mcp-bridge.ts         # spawn apple-pim MCP via stdio, list/call
│   ├── wrap-tool.ts          # wrap MCP tool with hooks → AnyAgentTool
│   └── hook-map.ts           # per-tool hook routing + extractDestination
├── tests/
│   ├── wrap-tool.test.ts
│   ├── mcp-bridge.test.ts
│   └── hook-map.test.ts      # specifically: extractDestination on event params
└── README.md
```

`mcp-bridge.ts` and `wrap-tool.ts` are largely transferable from secure-gmail. Do NOT pre-extract a shared package — wait until secure-apple-calendar is working, then refactor only if duplication is real (Principle 1: no bloat).

## OpenClaw Configuration

```json
{
  "plugins": {
    "load": {
      "paths": [
        "~/git/puddles/openclaw-plugins/secure-gmail",
        "~/git/puddles/openclaw-plugins/secure-apple-calendar"
      ]
    },
    "entries": {
      "secure-apple-calendar": {
        "config": {
          "applePimMcpCommand": "npx",
          "applePimMcpArgs": ["-y", "apple-pim-cli"],
          "applePimMcpEnv": {
            "APPLE_PIM_DOMAINS_MAIL": "false",
            "APPLE_PIM_DOMAINS_REMINDERS": "false",
            "APPLE_PIM_DOMAINS_CONTACTS": "false"
          },
          "trustedAttendeeDomains": ["<work-domain>", "<personal-domain>"],
          "model": "claude-haiku-4.5"
        }
      }
    }
  }
}
```

(Exact env var names TBD — verify against apple-pim source during implementation.)

## Contacts: Optional Follow-Up

If/when the agent needs read access to contacts (e.g., "what's Alice's email?" before creating an event), enable apple-pim's contacts domain *unwrapped* and accept the residual exfil-by-composition risk. If that risk feels real later, add a small `tool_result_persist` redactor (sync, regex-based — phone/address strip; keep names+emails) rather than spinning up a full secure-apple-contacts plugin.

## Open Questions for Implementation

1. **MCP server tool surface vs native plugin tool surface** — verify they're identical for calendar. If the MCP server is a strict subset, document gaps.
2. **How does apple-pim signal "event has attendees"** in `create_event` / `update_event` params? Drives the conditional SendApproval-vs-LeakGuard routing.
3. **Per-domain disable mechanism** — env var? config file? CLI flag? Need to confirm before writing the plugin config schema.
4. **Trust seeding for SendApproval** — populate `trustedAttendeeDomains` with your work + personal domains before flipping the plugin on.

## Out of Scope

- Mail (Plan 010 + delegation).
- Reminders, Contacts (intentionally not wrapped; see top table).
- Tasks/Notes (not in apple-pim per its README).
- Two-way sync conflict resolution.
- Forking apple-pim itself.

---

## Checklist

### Implementation
- [ ] Verify apple-pim MCP calendar tool surface vs native plugin (open question 1)
- [ ] Verify per-domain disable mechanism (open question 3)
- [ ] Create `openclaw-plugins/secure-apple-calendar/` directory structure
- [ ] Write `openclaw.plugin.json` manifest
- [ ] Write `mcp-bridge.ts` (port from secure-gmail; parameterize on command/args/env)
- [ ] Write `wrap-tool.ts` (port from secure-gmail; should be near-identical)
- [ ] Write `hook-map.ts` with per-tool routing per the table above
- [ ] Implement `extractDestination` for calendar attendees in `hook-map.ts`
- [ ] Implement `trustedAttendeeDomains` allowlist short-circuit in SendApproval routing
- [ ] Wire plugin entrypoint `plugin.ts` together
- [ ] `package.json` with `workspace:*` dep on mcp-hooks
- [ ] OpenClaw config update on the mini (loads plugin + disables non-calendar apple-pim domains)

### Testing
- [ ] Unit: `extractDestination` correctly extracts attendee list from `create_event` params (single, multi, none)
- [ ] Unit: hookMap routes `create_event` with attendees → SendApproval, without attendees → LeakGuard
- [ ] Unit: `trustedAttendeeDomains` short-circuits SendApproval for fully-trusted attendee sets, falls back to LLM check when any attendee is outside the allowlist
- [ ] Unit: ingress hooks run on `list_events`/`get_event`/`search_events` results
- [ ] Unit: skipped tools (`delete_event`, `list_calendars`) pass through without hooks
- [ ] Unit: non-calendar tools (if any leak through despite domain disable) are explicitly rejected (defense-in-depth)
- [ ] Integration: plugin loads in OpenClaw on the mini; apple-pim MCP server spawns; only calendar tools visible
- [ ] Integration: shared calendar from Cole → Puddles read returns events; injected description in a test event triggers InjectionGuard
- [ ] Integration: `create_event` with external attendee triggers SendApproval flow
- [ ] Integration: `create_event` with attendees only in `trustedAttendeeDomains` passes through without prompting
- [ ] Integration: `create_event` with no attendees and clean params passes through

### Cleanup
- [ ] No unused imports or dead code
- [ ] Code linting passes (`pnpm lint` per repo conventions)
- [ ] If `mcp-bridge.ts` ends up identical to secure-gmail's → consider promoting to shared package; otherwise leave duplicated

### Documentation
- [ ] README.md with setup instructions (CLI install, MCP server cmd, OpenClaw config, domain disable env vars)
- [ ] OpenClaw config example in README
- [ ] Update plan 010 to cross-reference plan 017 and the mail/calendar domain split
- [ ] Update plan 016 §4 (Apple PIM install) to reference plan 017 for calendar hook wrapping; note reminders/contacts intentionally unwrapped
- [ ] Plan marked as complete with date
