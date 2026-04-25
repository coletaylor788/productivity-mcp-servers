# Plan 012: Secure Web Plugin

**Status:** On Hold (defer until other plans are complete; revisit last)
**Created:** 2026-04-12
**Revised:** 2026-04-25 (after auditing OpenClaw plugin SDK; placed on hold)
**Depends on:** Plan 009 (mcp-hooks), Plan 013 (plugins scaffold), Plan 010 (secure-gmail — wrapping pattern)

## Summary (intent)

Wrap OpenClaw's built-in `web_fetch` and `web_search` tools with `mcp-hooks`
security:

- **Ingress** (LLM-backed `InjectionGuard` + `SecretRedactor`) on the tool's
  result text so prompt-injection / secret-laden web pages and search snippets
  can't poison the agent.
- **Egress** (LLM-backed `LeakGuard`) on the request args (URL / query) so the
  agent can't exfiltrate conversational secrets via outbound requests.

## Why this is on hold

After auditing the OpenClaw plugin SDK at version `2026.3.2`, no
out-of-the-box customization path delivers both ingress and egress without
changes to OpenClaw itself. Two independent blockers:

### Blocker #1 — built-in web tool factories are package-internal

The factories exist in the SDK source tree:

- `dist/plugin-sdk/agents/tools/web-fetch.d.ts` exports `createWebFetchTool`
- `dist/plugin-sdk/agents/tools/web-search.d.ts` exports `createWebSearchTool`
- Re-exported from `dist/plugin-sdk/agents/tools/web-tools.d.ts`

But OpenClaw's `package.json` `exports` map only routes:

```
"./plugin-sdk"
"./plugin-sdk/account-id"
"./plugin-sdk/keyed-async-queue"
```

There is no entry for `web-tools`. Node ESM refuses deep imports outside the
`exports` map (verified: `require.resolve("openclaw/plugin-sdk/agents/tools/web-tools")`
fails with `MODULE_NOT_FOUND`). A plugin therefore cannot import the factory
to call it from its own wrapper. The "disable built-in → register
same-named replacement that wraps the factory" design is blocked here.

Plugin tool name conflicts with built-ins are also rejected at
`pi-embedded-CtM2Mrrj.js:83936` (logs `plugin tool name conflict (...)` and
skips the plugin tool), so we cannot register a plugin tool named `web_fetch`
on top of an enabled built-in either.

### Blocker #2 — no async post-tool result-mutation hook

`PluginHookName` enumerates all hook events. Relevant ones for tool
interception:

| Hook | Async | Can mutate args | Can mutate result |
|---|---|---|---|
| `before_tool_call` | yes (`Promise<{params?, block?, blockReason?}>`) | yes | n/a |
| `after_tool_call` | yes (`Promise<void>`) | n/a | **no** (observe-only) |
| `tool_result_persist` | **no** (sync; rejects Promise-returning handlers) | n/a | yes |
| `before_message_write` | **no** (sync; rejects Promise-returning handlers) | n/a | yes (message text) |

LLM-backed `InjectionGuard` / `SecretRedactor` are async and call out to
Copilot, so they cannot run inside `tool_result_persist` or
`before_message_write`. There is no async hook that can replace a tool
result.

(For confirmation that the persist/message hooks reject async handlers, see
`/opt/homebrew/lib/node_modules/openclaw/dist/deliver-DCtqEVTU.js:213-247` and
`:261-287`.)

## What IS possible today as a customization

`before_tool_call` is fully async and can block / mutate args. So an
egress-only secure-web plugin is feasible without any OpenClaw change:

- Register `before_tool_call` for `web_fetch` and `web_search`
- Run async `LeakGuard` on the URL / query
- Return `{ block: true, blockReason }` if a leak is detected

This catches the classic "fetch attacker.tld?leak=…" exfiltration pattern,
but provides no defense against malicious content returned by the tool — the
larger threat surface for prompt injection.

## Three paths forward (decide when we revisit)

### Option A — One-line `exports` add upstream + plugin wraps factories

Add to OpenClaw's `package.json`:

```json
"./plugin-sdk/web-tools": {
  "types": "./dist/plugin-sdk/agents/tools/web-tools.d.ts",
  "default": "./dist/plugin-sdk/agents/tools/web-tools.js"
}
```

Then the plugin:

1. Reads `api.config`, `structuredClone`s it, sets
   `tools.web.fetch.enabled = true` and `tools.web.search.enabled = true` on
   the clone (the user must disable the built-ins in their own config so the
   names are free; the clone is what we pass to the factory because the
   factory returns `null` when disabled).
2. Calls `createWebFetchTool({ config: clone })` and
   `createWebSearchTool({ config: clone })` — both return `AnyAgentTool | null`.
3. Wraps each `AnyAgentTool` with our `wrap-agent-tool.ts` (egress via
   `before_tool_call`-style pre-check on args; ingress via async hooks on the
   result text returned by the delegate's `execute()`).
4. `api.registerTool(wrapped)` for each.

Code volume: ~200 LOC + tests. No upstream drift. Same pattern works for any
future built-in tool we want to harden.

### Option B — Egress-only plugin via `before_tool_call`

No OpenClaw changes. Real value but limited (egress only). ~80 LOC + tests.

### Option C — Rename + reimplement (`safe_web_fetch` / `safe_web_search`)

No OpenClaw changes; sidesteps both blockers because we never call OpenClaw's
factories and our tool names don't conflict. But we sign up to fork
`web_fetch` (HTTP, readability extraction, image sanitization, Firecrawl) and
to maintain a single search provider integration (OpenClaw supports
`brave | perplexity | grok | gemini | kimi`). ~400 LOC + ongoing maintenance
burden.

## Recommendation when we revisit

Option A. The upstream change is one entry in `package.json`'s `exports` and
unblocks the entire "secure-* plugins around built-in tools" pattern (web
today; bash, file writes, screenshot tools later). Options B and C are
fallbacks if upstream contributions are off the table at the time.

## Notes for next attempt

- The `wrap-agent-tool.ts` design (parallel ingress via `Promise.all`,
  block→sentinel `[secure-web] blocked …`, modify→text replace, audit per
  verdict, egress runs first and skips delegate on block) is reusable verbatim
  from secure-gmail's `wrap-tool.ts`, with the difference that the delegate is
  an `AnyAgentTool` returning `AgentToolResult` directly rather than an MCP
  bridge call.
- Egress hook config defaults: `egressChecks.fetch = false` (URLs are usually
  benign), `egressChecks.search = true` (free-form queries are higher risk).
- Firecrawl note: when `tools.web.fetch.firecrawl.apiKey` is set, the URL
  reaches Firecrawl before any ingress runs. Egress on `fetch` is the only
  filter for outbound URLs in that mode. Document in the plugin README when
  built.
- Verified: `OpenClawPluginApi.config: OpenClawConfig` is exposed
  (`plugin-sdk/plugins/types.d.ts:229`), so a plugin can read the user's full
  config to derive the clone in Option A.

## Checklist

### Decision
- [ ] Pick Option A / B / C when revisiting
- [ ] If A: open OpenClaw PR (one-line exports add)
- [ ] If A: wait for release / vendor locally

### Implementation (only after decision)
- [ ] Scaffold `openclaw-plugins/secure-web/` (package.json, tsconfig,
      manifest, vitest configs, write-dist-manifest)
- [ ] `src/wrap-agent-tool.ts` (Option A) OR `src/before-tool-call.ts`
      (Option B) OR full reimplementation (Option C)
- [ ] `src/plugin.ts` entry
- [ ] Unit tests
- [ ] Integration test against real Copilot LLM
- [ ] README (install, config, security guarantees, Firecrawl note)

### Wrap-up
- [ ] Plan checklist complete
- [ ] Commit and push
