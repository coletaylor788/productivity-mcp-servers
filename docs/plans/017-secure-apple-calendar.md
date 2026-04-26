# Plan 017: Secure Apple Calendar Plugin

**Status:** Complete (2026-04-24)
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

**Resolved during implementation:** apple-pim's MCP server exposes 5 consolidated tools (`calendar`, `reminder`, `contact`, `mail`, `apple-pim`). The plugin **only registers `calendar`** at the OpenClaw layer — the other four tools are silently dropped, regardless of apple-pim's own config. This is defense in depth at the registration boundary; we don't pass env-var disables.

For belt-and-suspenders at the apple-pim layer too, users can also drop a `~/.config/apple-pim/config.json`:

```json
{
  "items": {
    "mail":      { "enabled": false },
    "reminders": { "enabled": false },
    "contacts":  { "enabled": false }
  }
}
```

If/when reminders or contacts become genuinely useful to the agent, revisit the threat model and either register them unwrapped (low-risk surfaces) or write a small targeted hook (e.g., a `pii-redactor` for contact reads — see below).

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

## Per-Action Hook Map

**Resolved during implementation:** apple-pim's MCP server collapses calendar operations into a single `calendar` tool dispatched on `args.action`. Routing is per-action, implemented in `src/action-map.ts`:

| Action | Ingress | Egress | Rationale |
|---|---|---|---|
| `list`, `schema`, `delete` | — | — | Metadata / pure mutation; no exfil channel |
| `events`, `get`, `search` | InjectionGuard + SecretRedactor | — | Shared calendars carry external content; meeting descriptions are unsanitized; conferencing URLs frequently embed passcodes |
| `create`, `update`, `batch_create` (no attendees) | — | LeakGuard | Local mutation; LeakGuard catches accidental secret/PII writes into title/notes |
| `create`, `update`, `batch_create` (≥1 untrusted attendee) | — | **SendApproval** | CalDAV invitation = email egress. `extractDestinations` returns the full attendee list (also handles `args.events[]` for `batch_create`) |
| `create`, `update`, `batch_create` (all attendees in `trustedAttendeeDomains`) | — | skipped | Common-case short-circuit; domains also seeded into TrustStore as belt-and-suspenders |
| any unknown action | InjectionGuard + SecretRedactor | — | Fail-closed for unfamiliar reads |

Egress content is focused: title, location, notes, url (and `events[].*` for batch_create). IDs / calendar names / dates / durations are excluded — not meaningful exfil channels and they inflate LLM cost.

**SendApproval extension:** the built-in `extractDestinations` only checks `to/recipient/recipients/email/address`. We added an optional override constructor option (`packages/mcp-hooks/src/egress/send-approval.ts`) and wire `calendarExtractDestinations` from `action-map.ts` so attendee emails are picked up.

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
          "applePimMcpCommand": "node",
          "applePimMcpArgs": [
            "/Users/<you>/git/Apple-PIM-Agent-Plugin/mcp-server/dist/server.js"
          ],
          "trustedAttendeeDomains": ["<work-domain>", "<personal-domain>"],
          "model": "claude-haiku-4.5"
        }
      }
    }
  }
}
```

apple-pim's MCP server has no npm bin — invoke it directly via `node` against the built `mcp-server/dist/server.js`. Domain disable is via `~/.config/apple-pim/config.json` (not env vars); see "Apple-PIM Domain Configuration" above.

## Contacts: Optional Follow-Up

If/when the agent needs read access to contacts (e.g., "what's Alice's email?" before creating an event), enable apple-pim's contacts domain *unwrapped* and accept the residual exfil-by-composition risk. If that risk feels real later, add a small `tool_result_persist` redactor (sync, regex-based — phone/address strip; keep names+emails) rather than spinning up a full secure-apple-contacts plugin.

## Implementation Notes (resolved)

1. **Tool surface:** apple-pim MCP exposes 5 consolidated tools; only `calendar` is registered. Routing is per-`args.action` (see Per-Action Hook Map above).
2. **Attendees:** live at `args.attendees[].email` for single-event actions and at `args.events[].attendees[].email` for `batch_create`. `extractAttendeeEmails()` handles both shapes.
3. **Per-domain disable:** N/A — handled at the OpenClaw registration boundary by only registering `calendar`. Optional `~/.config/apple-pim/config.json` for defense in depth.
4. **Trust seeding:** populate `trustedAttendeeDomains` with your work + personal domains in OpenClaw config. Domains are also seeded into TrustStore via `seedDomains()` for belt-and-suspenders.
5. **apple-pim datamarking:** apple-pim wraps PIM content with sentinels at the source (`markToolResult` + `getDatamarkingPreamble`). Our `InjectionGuard` is the second line of defense — note this in the README threat model.
6. **MCP server install path:** install-dependent (Claude Code plugin cache vs dev clone). README documents both; user picks per-mini.

## Out of Scope

- Mail (Plan 010 + delegation).
- Reminders, Contacts (intentionally not wrapped; see top table).
- Tasks/Notes (not in apple-pim per its README).
- Two-way sync conflict resolution.
- Forking apple-pim itself.

---

## Checklist

### Implementation
- [x] Verify apple-pim MCP calendar tool surface vs native plugin → consolidated 5-tool surface; only `calendar` registered
- [x] Verify per-domain disable mechanism → handled at registration boundary; optional apple-pim config file documented
- [x] Create `openclaw-plugins/secure-apple-calendar/` directory structure
- [x] Write `openclaw.plugin.json` manifest
- [x] Write `mcp-bridge.ts` (port from secure-gmail; parameterized on command/args/env)
- [x] Write `wrap-tool.ts` — extended with per-call `selectHooks(args)` for ingress + egress phases
- [x] Write `action-map.ts` with per-action routing per the table above
- [x] Implement `calendarExtractDestinations` for attendees (single + batch_create shapes)
- [x] Implement `trustedAttendeeDomains` allowlist short-circuit (action-map sets `skipEgress`; also seeded into TrustStore)
- [x] Extend `mcp-hooks` SendApproval with optional `extractDestinations` override (backward compatible)
- [x] Wire plugin entrypoint `plugin.ts` together (hardcoded `CALENDAR_TOOL` for synchronous registration)
- [x] `package.json` with `workspace:*` dep on mcp-hooks
- [ ] OpenClaw config update on the mini (loads plugin + optional apple-pim config) — operational task; deferred to user

### Testing
- [x] Unit: `extractAttendeeEmails` correctly extracts attendees (single, multi, none, batch_create, malformed)
- [x] Unit: action-map routes mutations with attendees → SendApproval, without → LeakGuard, reads → ingress
- [x] Unit: `trustedAttendeeDomains` short-circuits when all attendees match; falls through when any external
- [x] Unit: ingress hooks run on `events`/`get`/`search` results
- [x] Unit: skipped actions (`list`, `schema`, `delete`) pass through without hooks
- [x] Unit: unknown actions fail-closed (ingress applied)
- [x] Unit: SendApproval custom `extractDestinations` override (in `packages/mcp-hooks`)
- [x] Integration: InjectionGuard + SecretRedactor + LeakGuard against real Copilot LLM with calendar fixtures (6 tests)
- [ ] Integration: plugin loads in OpenClaw on the mini; apple-pim MCP server spawns; only calendar tool visible — operational, deferred
- [ ] Integration: shared-calendar live read with injected description triggers InjectionGuard — operational, deferred
- [ ] Integration: `create` with external attendee triggers SendApproval flow — operational, deferred
- [ ] Integration: `create` with trusted-only attendees passes through without prompting — operational, deferred

### Cleanup
- [x] No unused imports or dead code
- [x] Code linting passes (`pnpm --filter secure-apple-calendar lint` clean)
- [x] `mcp-bridge.ts` left duplicated from secure-gmail (per "no premature extraction" — revisit when 3rd consumer appears)

### Documentation
- [x] README.md with setup instructions (apple-pim install, MCP server cmd, OpenClaw config, optional domain disable)
- [x] OpenClaw config example in README
- [ ] Update plan 010 to cross-reference plan 017 and the mail/calendar domain split — low priority, defer
- [ ] Update plan 016 §4 (Apple PIM install) to reference plan 017 — low priority, defer
- [x] Plan marked as complete with date
