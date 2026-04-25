# mcp-hooks Architecture

Reference for working in this package. The high-level design rationale lives in
[`docs/plans/009-mcp-security-hooks.md`](../../../docs/plans/009-mcp-security-hooks.md);
this document is the living "what's actually here" companion.

---

## Purpose

`mcp-hooks` is a standalone TypeScript library of security hooks for MCP tool
pipelines. Consumers (OpenClaw plugins, container-side network proxies, ad-hoc
scripts) instantiate the hook classes they need and call `check()` directly —
the library is intentionally consumer-agnostic and ships no runner, registry, or
host integration.

It does two things:

1. **Egress checks** — inspect outbound tool inputs (URLs, queries, message
   bodies, command args) before the tool runs.
2. **Ingress checks** — inspect inbound tool outputs (email bodies, web pages,
   API responses) before they reach the model.

All semantic decisions are LLM-powered, classified via the GitHub Copilot API
using the same two-step token exchange OpenClaw uses.

---

## Package layout

```
packages/mcp-hooks/
├── src/
│   ├── index.ts              # Public API surface
│   ├── types.ts              # HookResult, HookAction, TrustLevel, ContentClassification
│   ├── copilot-llm.ts        # CopilotLLMClient — token exchange + caching + classify()
│   ├── trust-store.ts        # TrustStore — destination trust persistence + resolution
│   ├── egress/
│   │   ├── leak-guard.ts     # LeakGuard — universal egress blocker
│   │   └── send-approval.ts  # SendApproval — destination-aware send check
│   └── ingress/
│       ├── injection-guard.ts # InjectionGuard — prompt-injection detector
│       └── secret-redactor.ts # SecretRedactor — regex + LLM redaction
├── tests/
│   ├── copilot-llm.test.ts
│   ├── trust-store.test.ts
│   ├── leak-guard.test.ts
│   ├── send-approval.test.ts
│   ├── injection-guard.test.ts
│   ├── secret-redactor.test.ts
│   ├── wiring.test.ts          # End-to-end wiring with mocked LLM
│   └── integration.test.ts     # Real Copilot API (requires PAT in keychain)
└── docs/
    └── architecture.md         # this file
```

Everything in `index.ts` is part of the public API; everything else is internal.

---

## Public API surface

```ts
// Shared types
type HookAction = "allow" | "block" | "modify";
interface HookResult { action: HookAction; content?: string; reason?: string; }
type TrustLevel = "unknown" | "approved" | "trusted";
interface ContentClassification {
  has_secrets: boolean;
  has_sensitive: boolean;
  has_personal: boolean;
}
interface SendApprovalResult extends HookResult {
  classification?: ContentClassification;
  trustLevel: TrustLevel;
  destination?: string;
  approval?: { title: string; description: string; severity: "info" | "warning" | "critical"; };
}
interface EgressHook  { check(toolName, content, params?): Promise<HookResult | SendApprovalResult>; }
interface IngressHook { check(toolName, content): Promise<HookResult>; }

// Implementations
class CopilotLLMClient { /* …token mgmt + classify(content, systemPrompt) */ }
class TrustStore { /* …destination trust persistence */ }

class LeakGuard      implements EgressHook  { constructor({ llm }) }
class SendApproval   implements EgressHook  { constructor({ llm, trustStore }) }
class InjectionGuard implements IngressHook { constructor({ llm }) }
class SecretRedactor implements IngressHook { constructor({ llm }) }
```

---

## Hook responsibilities

| Hook | Direction | Runs on | Decisions |
|---|---|---|---|
| **LeakGuard** | egress | non-send tools (web_search, web_fetch, exec…) | secrets/sensitive/PII → **block**; otherwise allow |
| **SendApproval** | egress | send-type tools (email, message…) | secrets/sensitive → **block**; PII → trust-dependent; clean → trust-dependent (may surface approval) |
| **InjectionGuard** | ingress | any tool returning external content | injection detected → **block**; otherwise allow |
| **SecretRedactor** | ingress | tools returning authenticated content | regex + LLM pass → **modify** (redacted) or allow |

Important behavioral details:

- **LeakGuard fires three classification calls in parallel** (secrets, sensitive,
  PII) — separate single-purpose prompts are more reliable than asking one
  prompt to classify three categories. Latency is the same; cost is 3× but
  Haiku is cheap.
- **SendApproval reuses the same three prompts as LeakGuard** but routes PII
  through the trust store instead of blocking unconditionally. The two hooks
  intentionally duplicate the prompt text rather than sharing a module — keeps
  each hook self-contained and lets the prompts diverge later if needed.
- **SecretRedactor is regex-first, LLM-second.** Regex catches the
  well-formatted majority (API keys, JWTs, private keys, connection strings,
  bearer tokens, reset links, 2FA codes, SSNs, credit cards). The LLM pass runs
  on the *already-regex-redacted* content to catch context-dependent leaks the
  regex missed. The LLM returns `{secret: "exact string", type: "category"}`
  pairs and we do deterministic `replaceAll` — no position math, no off-by-one.
  Hallucination guard: if the returned string isn't found in the content, it's
  silently dropped.
- **All four hooks fail open on LLM error.** A network blip or malformed JSON
  will not block legitimate tool calls. This is a deliberate availability
  trade-off; the trust boundary lives at the consumer layer (e.g., the plugin
  can choose to escalate or refuse), not inside the hook.

---

## CopilotLLMClient

The single point of LLM access. One instance per process is the expected
pattern; share it across hooks.

### Token lifecycle

1. **Bootstrap** — first `classify()` call triggers a refresh.
2. **Refresh** —
   - Read GitHub PAT from keychain (`service: openclaw`, `account: github-pat`)
     unless an explicit `githubToken` was passed.
   - GET `https://api.github.com/copilot_internal/v2/token` with the PAT.
   - Parse response `{ token, expires_at }`. `expires_at` may be seconds or
     milliseconds — values `> 10_000_000_000` are treated as ms, otherwise
     multiplied by 1000.
   - Derive base URL from the `proxy-ep=…` field embedded in the token (regex
     `/(?:^|;)\s*proxy-ep=([^;\s]+)/i`); strip protocol, swap `proxy.` →
     `api.`, prepend `https://`. Falls back to
     `https://api.individual.githubcopilot.com`.
   - Construct an `OpenAI` client pointed at that base URL with the Copilot
     headers (`User-Agent`, `Editor-Version`, `Editor-Plugin-Version`,
     `Copilot-Integration-Id`).
3. **Use** — `classify(content, systemPrompt)` calls
   `chat.completions.create` at `temperature: 0` and returns the assistant
   message with markdown code fences stripped.
4. **Proactive refresh** — `setTimeout` schedules a refresh
   `5 minutes` before expiry, with `60s` retry on failure and a `5s` floor to
   prevent tight loops.
5. **Concurrent dedup** — if a refresh is in flight, additional callers `await`
   the same promise.

### State

Token state lives only in memory (`this.tokenState`). The Copilot API token
never touches disk or env vars. The GitHub PAT is read fresh from keychain each
refresh cycle.

### Cleanup

`destroy()` clears the refresh timer. Long-running consumers that rotate
clients should call this; one-shot scripts can ignore it.

---

## TrustStore

Plugin-injected destination trust resolver, persisted to disk.

### Configuration

```ts
new TrustStore({
  pluginId: "secure-gmail",
  extractDestination: (toolName, params) => params.to as string,
  // optional:
  extractDomain: (dest) => /* default: split on @ */,
  storageDir: /* default: ~/.openclaw/trust/ */,
});
```

The plugin only needs to teach the store **how to extract a destination key
from arbitrary tool params**. Everything else (resolution, persistence, tier
upgrades) is handled internally.

### Resolution

`resolve(toolName, params)` and `resolveDestination(dest)` return:

- Contact-level trust (exact match, lowercased) if present, else
- Domain-level trust (default extractor splits on `@`) if present, else
- `"unknown"`.

Contacts always override domains.

`resolveAll(destinations[])` returns the **lowest** level across a recipient
list — any `unknown` recipient yields `unknown`; any `approved` recipient
caps the result at `approved`; only an all-`trusted` set is `trusted`.

### Tier upgrades

```
allow-once                            → no change
allow-always on unknown destination   → upgrade to approved
allow-always on approved + PII flagged → upgrade to trusted
deny                                   → no change
```

Implemented in `handleApprovalDecision(destinations, decision, piiDetected)`.

### Persistence

- Path: `${storageDir}/${pluginId}.json`, default
  `~/.openclaw/trust/${pluginId}.json`.
- Format: `{ contacts: { dest: TrustLevel }, domains: { domain: TrustLevel } }`.
- Permissions: parent directory created `0o700`, file written `0o600`.
- Loaded once at construction; corrupt files fall back to an empty store
  rather than throwing.

`seedDomains(domains, level = "trusted")` is the standard way for a plugin to
preload trusted domains from config.

---

## Trust + classification matrix

The two egress hooks share the classification but diverge on PII:

| Finding | LeakGuard (non-send) | SendApproval / unknown | SendApproval / approved | SendApproval / trusted |
|---|---|---|---|---|
| Secrets | **block** | **block** | **block** | **block** |
| Sensitive | **block** | **block** | **block** | **block** |
| PII | **block** | **block** + approval | **block** + approval | allow |
| Clean | allow | **block** + approval | allow | allow |

When SendApproval blocks with `approval: {...}` set, the consumer is expected
to surface that approval to the user and feed the result back through
`TrustStore.handleApprovalDecision()`.

---

## LLM prompt strategy

Prompts live as module-level constants beside each hook (not in a shared
prompts module — see "shared prompt text" note below). Each prompt:

- States the classifier's role.
- Enumerates positive examples ("flag if…").
- Enumerates negative examples ("do NOT flag…") to combat over-blocking.
- Demands JSON-only output: `{"detected": bool, "evidence": "…"}` for
  classifiers; `{"findings": [{"secret": "…", "type": "…"}]}` for the
  redactor's LLM pass.

The classifier prompts are deliberately verbose because Haiku-class models
respond well to enumerated do/don't lists. Iteration on these prompts is a
core part of Plan 015 (hook evals).

**Shared prompt text:** LeakGuard and SendApproval currently duplicate the
secrets/sensitive/PII prompt strings verbatim. This is intentional — the two
hooks are tested independently and may evolve different examples. If they
drift, that's fine. If they don't, dedup later when a third consumer appears.

---

## Testing

| Suite | Command | What it covers |
|---|---|---|
| Unit (mocked LLM) | `npm test` | 92 tests across all modules; deterministic |
| Integration (real Copilot API) | `npx vitest run tests/integration.test.ts` | Real token exchange + real classification of canonical inputs |
| Type check / lint | `npm run lint` (`tsc --noEmit`) | Strict TS, no implicit any |

Unit tests mock `fetch` for token exchange and stub `CopilotLLMClient.classify`
for hook tests. Integration tests require a GitHub PAT in keychain and are
excluded from the default `npm test` run via `vitest --exclude`.

---

## Extension points

To add a new hook:

1. Implement `EgressHook` or `IngressHook` in `src/egress/` or `src/ingress/`.
2. Define its classification prompt(s) as module-level constants.
3. Fail open on LLM errors (catch JSON.parse and request failures, return
   `{ action: "allow" }`).
4. Export from `src/index.ts`.
5. Add a unit test file alongside, mocking `CopilotLLMClient.classify`.
6. Add an integration test case in `tests/integration.test.ts`.

To support a new tool destination shape in SendApproval, override
`extractDestinations` semantics by passing a custom `extractDestination`
function to the `TrustStore` — SendApproval reads destinations from common
param keys (`to`, `recipient`, `recipients`, `email`, `address`) but defers
trust resolution entirely to the store.

---

## Operational notes

- **Keychain bootstrap:** Store the GitHub PAT once with
  `security add-generic-password -s "openclaw" -a "github-pat" -w "<pat>"`.
  Storage is shared with OpenClaw itself.
- **Trust store inspection:** `cat ~/.openclaw/trust/<pluginId>.json` to
  audit current trust state. Edit by hand if you want to revoke.
- **Cost:** A single LeakGuard or SendApproval check is ~3 Haiku calls;
  InjectionGuard and SecretRedactor are 1 each. A typical send-email flow
  through Gmail's secure plugin (Plan 010) will run SendApproval (3 calls)
  for the outbound body.
- **Logging:** The library emits no logs. Consumers should log
  `HookResult.reason` on block decisions and approval prompts for audit
  trails — the library is intentionally quiet so consumers control PII in
  logs.
