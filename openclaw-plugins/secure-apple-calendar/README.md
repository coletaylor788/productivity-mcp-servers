# secure-apple-calendar

OpenClaw plugin that wraps the [apple-pim](https://github.com/omarshahine/Apple-PIM-Agent-Plugin)
MCP server's `calendar` tool with security hooks from
[`mcp-hooks`](../../packages/mcp-hooks/).

It registers a single OpenClaw `AnyAgentTool` named `calendar` whose
`execute()`:

1. Inspects the `action` arg (`list`, `events`, `get`, `search`, `create`,
   `update`, `delete`, `batch_create`, `schema`) to decide which hooks apply.
2. Runs **egress** hooks first on mutation actions:
   - `SendApproval` if the event has attendees, gated by an
     attendee-domain TrustStore. External (untrusted) domains require
     approval; trusted domains pass.
   - `LeakGuard` otherwise (no attendees → no recipient to evaluate).
3. Calls the underlying MCP tool only if egress allowed (or no egress hook
   was selected).
4. Pipes the text result through **ingress** hooks (`InjectionGuard` +
   `SecretRedactor`) on read actions before returning it to the agent.

If any hook returns `block`, the agent receives a sentinel message instead
of the raw content / instead of a successful mutation. If all hooks return
`allow` the original MCP result passes through unchanged.

The other four apple-pim tools (`reminder`, `contact`, `mail`, `apple-pim`)
are intentionally **not registered** by this plugin — defense in depth on
top of any apple-pim per-domain config.

## Per-action hook map

| Action | Ingress | Egress |
|---|---|---|
| `list`, `schema`, `delete` | — | — |
| `events`, `get`, `search` | InjectionGuard + SecretRedactor | — |
| `create`, `update`, `batch_create` (with attendees, all trusted) | — | skipped |
| `create`, `update`, `batch_create` (with at least one untrusted attendee) | — | SendApproval |
| `create`, `update`, `batch_create` (no attendees) | — | LeakGuard |
| any unknown action | InjectionGuard + SecretRedactor | — (fail-closed for reads) |

## Why this lives in `execute()`

OpenClaw's `tool_result_persist` and `before_message_write` lifecycle hooks
are **synchronous** and reject `Promise`-returning handlers. The hooks need
to await an LLM call, so they can't live there. Wrapping the registered
tool's `execute()` is the only place where async work can run between the
MCP call and the result the agent sees on its next turn.

See [Plan 010](../../docs/plans/010-secure-gmail-plugin.md) for the full
architecture rationale (the same constraint shaped secure-gmail).

## Threat model notes

- **apple-pim already datamarks PIM content** at the source (sentinels
  around event titles, descriptions, etc). Our `InjectionGuard` is the
  second line — it inspects the marked text and uses an LLM to flag
  injection attempts that survived the markup.
- **External calendars (Google, Outlook, etc.) work the same as iCloud**
  calendars from this plugin's perspective — apple-pim talks to EventKit
  which exposes any calendar added to macOS Calendar.app at the OS level.
  The agent sees the same risk surface regardless of source.
- **Attendees are extracted from `args.attendees[].email`**, including
  inside `args.events[]` for `batch_create`. SendApproval treats the entire
  attendee list as the recipient set; ALL must match
  `trustedAttendeeDomains` to skip approval.
- **Egress content is focused on free-text fields the agent could leak
  through**: title, location, notes, url. IDs / calendar names / dates /
  durations are excluded — they're not meaningful exfil channels and only
  inflate LLM cost.
- **Calendar invites still route through the source provider's mail
  server.** SendApproval evaluates the attendee email — if it's a Gmail
  address, the invite goes through Gmail regardless of which calendar the
  event lives in.

## Install in OpenClaw

### Prerequisites — apple-pim and auth

1. **apple-pim Swift CLIs** installed and built. Clone
   [`Apple-PIM-Agent-Plugin`](https://github.com/omarshahine/Apple-PIM-Agent-Plugin)
   and run:
   ```bash
   cd Apple-PIM-Agent-Plugin
   ./setup.sh --install      # builds the Swift binaries (calendar, reminders, etc)
   cd mcp-server && npm install && npm run build   # builds the MCP server
   ```
2. **Calendar permission** granted to whichever process spawns the
   apple-pim CLIs (typically OpenClaw via this plugin) — macOS will prompt
   on first use; if it doesn't, grant manually in System Settings →
   Privacy & Security → Calendars.
3. **(Optional) External calendars** — to surface Google / Outlook
   calendars, add the account in System Settings → Internet Accounts and
   enable Calendars. Sync latency means newly-created events take seconds
   to a minute to appear in EventKit.
4. **GitHub Copilot PAT** in the macOS Keychain (used by the hook LLM
   checks). Service `openclaw`, account `github-pat`. See
   [`packages/mcp-hooks/README.md`](../../packages/mcp-hooks/README.md#credential-setup).

Verify:

```bash
ls /abs/path/to/Apple-PIM-Agent-Plugin/mcp-server/dist/server.js && echo "apple-pim mcp: OK"
security find-generic-password -s openclaw -a github-pat >/dev/null && echo "copilot PAT: OK"
```

### (Recommended) apple-pim domain config

Even though this plugin only registers `calendar`, you can disable other
apple-pim domains at the source for belt-and-suspenders. Create
`~/.config/apple-pim/config.json`:

```json
{
  "items": {
    "mail":      { "enabled": false },
    "reminders": { "enabled": false },
    "contacts":  { "enabled": false }
  }
}
```

### Build, install, enable

```bash
# from the repo root, build the plugin's dist/ first
pnpm install
pnpm --filter secure-apple-calendar build

# then link + enable in OpenClaw
openclaw plugins install -l ./openclaw-plugins/secure-apple-calendar
openclaw plugins enable secure-apple-calendar
openclaw plugins doctor   # surfaces load errors if any
```

After enabling, add the config block below.

## Configuration

| Key | Required | Default | Purpose |
|---|---|---|---|
| `applePimMcpCommand` | ✅ | — | Command to spawn the MCP server. Typically `"node"`. |
| `applePimMcpArgs` | | `[]` | Args appended to the command (path to apple-pim's `mcp-server/dist/server.js`). |
| `applePimMcpCwd` | | — | Working directory for the subprocess. |
| `applePimMcpEnv` | | — | Extra env vars passed to the subprocess. |
| `trustedAttendeeDomains` | | `[]` | Email domains whose attendees auto-pass SendApproval. Case-insensitive; leading `@` accepted. |
| `model` | | `claude-haiku-4.5` | Copilot model used by hook LLM checks. |
| `auditLogPath` | | `~/.openclaw/logs/secure-apple-calendar-audit.jsonl` | JSONL audit log. |

The Copilot PAT used by the hooks must be in the macOS Keychain — see
Prerequisites above.

### OpenClaw config example

```json
{
  "plugins": {
    "load": {
      "paths": ["/Users/<you>/git/puddles/openclaw-plugins/secure-apple-calendar"]
    },
    "entries": {
      "secure-apple-calendar": {
        "config": {
          "applePimMcpCommand": "node",
          "applePimMcpArgs": [
            "/Users/<you>/git/Apple-PIM-Agent-Plugin/mcp-server/dist/server.js"
          ],
          "trustedAttendeeDomains": ["example.com"],
          "model": "claude-haiku-4.5"
        }
      }
    }
  }
}
```

## Development

```bash
# from the repo root
pnpm install

# from this directory
pnpm test                # unit tests only (mocked MCP + hooks; fast, no auth)
pnpm test:integration    # integration tests (real Copilot LLM)
pnpm test:all            # everything
pnpm lint                # tsc --noEmit
pnpm build               # emits dist/
```

The integration test (`tests/integration.hooks.test.ts`) runs
`InjectionGuard`, `SecretRedactor`, and `LeakGuard` against canned
calendar-shaped fixtures using the real GitHub Copilot API. It skips
automatically when no PAT is reachable in the keychain.

## Manual integration smoke test

1. Confirm apple-pim's MCP server and Swift CLIs are installed.
2. Confirm the Copilot PAT is in the keychain.
3. Add the OpenClaw config block above.
4. Start an OpenClaw session and ask the agent: "What's on my calendar
   tomorrow?". Verify it returns events and that
   `[secure-apple-calendar] registering calendar tool` appears in the
   OpenClaw logs at startup.
5. Ask: "Create an event 'Coffee with Alice' tomorrow at 10am with
   alice@example.com" (where `example.com` is in `trustedAttendeeDomains`).
   Verify it goes through without an approval prompt.
6. Ask: "Create an event with stranger@unknown-domain.com". Verify
   SendApproval blocks (or prompts).
7. Ask: "Create a personal event titled 'todo' with notes containing
   sk_live_..." (no attendees). Verify LeakGuard blocks.

## Layout

```
secure-apple-calendar/
├── openclaw.plugin.json   # manifest (id + configSchema)
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── plugin.ts          # default-exported plugin: register(api)
│   ├── mcp-bridge.ts      # spawns apple-pim mcp-server via stdio
│   ├── wrap-tool.ts       # wrap one MCP tool with per-call ingress + egress
│   └── action-map.ts      # per-action hook routing for `calendar`
└── tests/
    ├── action-map.test.ts        # unit
    ├── wrap-tool.test.ts         # unit
    └── integration.hooks.test.ts # hits real Copilot API
```
