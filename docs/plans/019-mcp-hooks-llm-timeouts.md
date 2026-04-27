# Plan 019 — mcp-hooks LLM timeouts + structured logging

**Status:** complete (2026-04-27)

## Problem

`CopilotLLMClient.classify()` calls `client.chat.completions.create({...})` with no
`timeout`, no `maxRetries: 0`, and no `AbortSignal`. When github-copilot's chat API is
flaky (we've seen `Connect Timeout` on the token-exchange path repeatedly), the call
hangs forever. Every ingress hook (`InjectionGuard`, `SecretRedactor`) and egress hook
(`LeakGuard`, `ContactsEgressGuard`) goes through `classifyBoolean` → `classify`, so a
single stuck LLM call freezes a tool result indefinitely → the agent's tool call never
returns → the run wedges silently. **Same root-cause class as Plan 009 (gmail-mcp), one
layer up.**

Today's wedge: reader subagent called `list_emails` at 08:55:41, bridge returned at
08:55:44, `secure-gmail-audit.jsonl` never updated — confirming the wedge is in the
ingress hooks' LLM calls, not the bridge.

There is also no logging when an LLM call starts/completes/errors, so we have no way to
see "hook X has been waiting Y seconds" from the gateway log.

## Approach

Mirror Plan 009 / `gmail-mcp/_async.py` at the TS LLM layer:

1. **Hard per-request timeout** on every chat completion call (default 30s) using the
   OpenAI SDK's `timeout` + `maxRetries: 0` options, **plus** a belt-and-suspenders
   `AbortSignal.timeout()` so we never depend on SDK-internal honoring.
2. **Slow-call warning** at 10s so chronic slowness is visible before it becomes a
   wedge.
3. **Structured JSON logging** to stderr (will land in `gateway.err.log`) for
   `llm_call_start`, `llm_call_done`, `llm_call_slow`, `llm_call_timeout`,
   `llm_call_error` — sanitized (no token leakage, content sizes only).
4. **Caller labels** so we can tell which hook hung:
   `classifyBoolean(llm, content, prompt, label)` — update the 4 production callsites
   to pass meaningful labels (`leak.secrets`, `injection`, `secret-redact`, etc.).
5. Same treatment on `refreshToken()` fetch (token-exchange) — `AbortSignal.timeout(15_000)`.

## Files

**New:**
- `packages/mcp-hooks/src/logger.ts` — `log(event, fields)` JSON-to-stderr + `sanitize()`.

**Modified:**
- `packages/mcp-hooks/src/copilot-llm.ts` — add timeout, abort, slow-warn, logging.
- `packages/mcp-hooks/src/classify.ts` — add `label` param, log start/done.
- `packages/mcp-hooks/src/egress/leak-guard.ts` — pass labels.
- `packages/mcp-hooks/src/egress/contacts-egress-guard.ts` — pass labels.
- `packages/mcp-hooks/src/ingress/injection-guard.ts` — pass label.
- `packages/mcp-hooks/src/ingress/secret-redactor.ts` — wrap direct `llm.classify` similarly (label `redact`).
- `packages/mcp-hooks/src/index.ts` — export logger primitives if useful.
- `packages/mcp-hooks/README.md` — document timeouts + log format.

**New tests:**
- `packages/mcp-hooks/tests/copilot-llm-timeout.test.ts` — hangs are aborted within timeout.
- `packages/mcp-hooks/tests/classify-label.test.ts` — label propagated to logs.
- `packages/mcp-hooks/tests/logger.test.ts` — sanitize + JSON shape.

## Defaults

| Knob | Default | Override |
|---|---|---|
| `requestTimeoutMs` | 30_000 | `CopilotLLMClient` ctor opt |
| `slowCallMs` | 10_000 | ctor opt |
| `tokenExchangeTimeoutMs` | 15_000 | ctor opt |

These are huge headroom vs. observed real latency (haiku classify ≈ 200–800ms). 30s is
catastrophic-flake territory, not normal flake.

## Out of scope

- Adding per-call timeouts inside `wrap-tool.ts`'s `Promise.all(ingress)` — the LLM-layer
  timeout already bounds the wait; doubling up adds complexity for no real protection.
- Defense-in-depth bridge stdio timeout in secure-gmail wrap — separate concern, file as
  follow-up if wedges persist.
- Watchdog (Plan 016 §6.1.4 still pending as ultimate backstop).

## Deployment

After merge:
1. SSH mini, `git pull`, `pnpm install`, `pnpm --filter mcp-hooks build`.
2. (Calendar/gmail bundles already inline-import the built dist or re-use the built
   package — verify with `pnpm --filter secure-gmail build`, same for calendar.)
3. `launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway`.
4. Trigger one tool call, confirm `llm_call_start` + `llm_call_done` appear in
   `~/.openclaw/logs/gateway.err.log`.

---

## Checklist

### Implementation
- [x] Create `logger.ts` with `log(event, fields)` + `sanitize()`
- [x] Add timeout/abort/slow-warn/logging to `copilot-llm.ts:classify()`
- [x] Add `AbortSignal.timeout` to `copilot-llm.ts:refreshToken()` fetch
- [x] Add optional `label` arg to `classifyBoolean` + log start/done
- [x] Update `leak-guard.ts` callsites with labels
- [x] Update `contacts-egress-guard.ts` callsites with labels
- [x] Update `injection-guard.ts` callsite with label
- [x] Wrap `secret-redactor.ts` direct `llm.classify` call with same logging/timeout (label `redact`)

### Testing
- [x] `logger.test.ts` written + passing
- [x] `copilot-llm-timeout.test.ts` written + passing (mocked hanging SDK)
- [x] `classify-label.test.ts` written + passing
- [x] Existing mcp-hooks suite still green
- [x] secure-gmail + secure-apple-calendar suites still green
- [x] `pnpm --filter mcp-hooks build` clean

### Cleanup
- [x] No unused imports
- [x] Lint clean (whatever the package uses)

### Documentation
- [x] `packages/mcp-hooks/README.md` "Logging" section added
- [x] Plan marked complete with date

### Commit + deploy
- [x] One commit covering all changes
- [x] Push to main
- [x] Deploy to mini (pull / install / build / kickstart)
- [x] Verify `llm_call_start`/`llm_call_done` appear in gateway.err.log after a real tool call
