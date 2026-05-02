# mcp-hooks

Security hooks for MCP tool pipelines. Provides egress and ingress content scanning powered by LLM classification via GitHub Copilot API.

## Hooks

### Egress (outbound content)

| Hook | Purpose | Runs on |
|------|---------|---------|
| **LeakGuard** | Blocks secrets, sensitive data, and PII from leaking via non-send tools | web_search, web_fetch, exec, etc. |
| **ContactsEgressGuard** | Destination-aware trust check backed by iCloud Contacts | send_email, message, calendar create/update with attendees, etc. |

### Ingress (inbound content)

| Hook | Purpose | Runs on |
|------|---------|---------|
| **InjectionGuard** | Detects prompt injection attacks in external content | All tools returning external data |
| **SecretRedactor** | Redacts secrets (2FA codes, API keys, reset links, etc.) via regex + LLM | MCP tools returning authenticated data |

## Usage

```typescript
import {
  CopilotLLMClient,
  LeakGuard,
  ContactsEgressGuard,
  ContactsTrustResolver,
  InjectionGuard,
  SecretRedactor,
} from "mcp-hooks";

// LLM client — reads GitHub PAT from keychain, exchanges for Copilot token
const llm = new CopilotLLMClient({ model: "claude-haiku-4.5" });

// Egress: block leaks on non-send tools
const leakGuard = new LeakGuard({ llm });
const result = await leakGuard.check("web_search", queryText);
// result.action: "allow" | "block"

// Egress: destination-aware approval for send tools, backed by iCloud Contacts
const contacts = new ContactsTrustResolver({
  // optional: cliPath defaults to "contacts-cli" on PATH
});

const sendGuard = new ContactsEgressGuard({
  contacts,
  trustedDomains: ["mycompany.com"], // domain short-circuit (case-insensitive)
  llm,                                 // optional: enable secrets/sensitive classifiers
  extractDestinations: (toolName, params) =>
    Array.isArray(params.to) ? (params.to as string[]) : [params.to as string],
});

const sendResult = await sendGuard.check(
  "send_email",
  emailBody,
  { to: "someone@random.com" },
);
// sendResult.action: "allow" | "block"
// sendResult.reason (if blocked): action-oriented string naming the offending recipient(s)

// Ingress: detect prompt injection
const injectionGuard = new InjectionGuard({ llm });
const ingressResult = await injectionGuard.check("get_email", emailContent);

// Ingress: redact secrets
const secretRedactor = new SecretRedactor({ llm });
const redactResult = await secretRedactor.check("get_email", emailContent);
// redactResult.action: "allow" | "modify"
// redactResult.content: redacted text (if "modify")
```

### Scoping ingress LLM scans with a prefilter

Both `InjectionGuard` and `SecretRedactor` accept an optional `prefilter`
that decides which slice of the tool response is sent to the LLM. The
plugin owns the schema of its tool output (envelope vs untrusted free
text), so it's the right layer to pick that slice. Scoping focuses LLM
attention on the actual attack surface and reduces false positives on
benign envelope fields (opaque IDs, etags, dates).

The shared helper `makeUntrustedKeysPrefilter` walks JSON tool responses
and emits only values whose key is in a configured set:

```typescript
import {
  CopilotLLMClient,
  InjectionGuard,
  SecretRedactor,
  makeUntrustedKeysPrefilter,
} from "mcp-hooks";

const llm = new CopilotLLMClient({ model: "claude-haiku-4.5" });

// Sender-controlled JSON keys for a Gmail-like response.
// Keys NOT listed here are treated as trusted envelope and are not
// sent to the LLM scans.
const gmailPrefilter = makeUntrustedKeysPrefilter({
  untrustedKeys: new Set([
    "from", "to", "cc", "subject", "snippet",
    "body_text", "body_html", "filename", "error",
  ]),
});

const injectionGuard = new InjectionGuard({ llm, prefilter: gmailPrefilter });
const secretRedactor = new SecretRedactor({ llm, prefilter: gmailPrefilter });
```

Behavior:

- The prefilter parses the tool response as JSON. If parsing fails it
  returns the **full** content unchanged (defence in depth — never
  silently skip a scan because we couldn't parse).
- It walks the parsed tree recursively and emits `key: value` lines
  for every value whose key is in `untrustedKeys`. Nested matches are
  found regardless of depth.
- An empty result skips the LLM call (the hook returns `allow`).
- For `SecretRedactor`, the prefilter only scopes Phase-2 (LLM). Phase-1
  (regex sweep for `sk-…`, JWTs, AWS keys, SSNs, credit cards, etc.)
  always runs on the full content.
- When the LLM identifies a secret in a scanned slice, `SecretRedactor`
  replaces every occurrence of that string anywhere in the full
  response — detection is scoped, replacement is not.

> **Security boundary:** the prefilter is a *scoping* knob, not an
> *authorization* knob. Anything excluded from the returned slice is
> NOT scanned by the LLM. Plugin authors must only exclude content they
> trust to be structural envelope (opaque IDs from a verified upstream,
> server-set status fields), never user/attacker-controlled payload.
> When in doubt, include the key.

For a custom shape, write your own `SimplePrefilter`:

```typescript
import type { SimplePrefilter } from "mcp-hooks";

const myPrefilter: SimplePrefilter = (toolName, content) => {
  // Return the substring(s) you want the LLM to scan.
  // Empty string => skip the LLM call.
  // Anything you don't return is NOT scanned.
  return extractAttackerControlledFields(content);
};
```

## Trust Model

`ContactsEgressGuard` treats **membership in iCloud Contacts** as the
sole source of egress trust. There are no persisted approvals, no
runtime-mutable trust ladder, no on-disk store. To grant trust, the user
adds the recipient to Contacts (the agent can do this via apple-pim's
`contact create` once the user authorizes).

Decision flow per call:

1. Content has secrets → **block** (always).
2. Content has sensitive data → **block** (always).
3. For each destination (email):
   - email domain matches `trustedDomains` → trusted
   - email matches a Contact → trusted
   - else → untrusted
4. If any destination is untrusted → **block** with an action-oriented
   reason naming the offending recipient(s).
5. Otherwise → **allow**.

Fail-closed: if `contacts-cli` can't read AddressBook (e.g. TCC
permission revoked), every destination is untrusted until repaired.

## LLM Client

Uses GitHub Copilot API via two-step token exchange:

1. GitHub PAT (from keychain) → `api.github.com/copilot_internal/v2/token`
2. Copilot token → `api.individual.githubcopilot.com/v1/chat/completions`

Tokens cached in-memory with proactive refresh (5 min before expiry).

### Credential Setup

Store your GitHub PAT in macOS Keychain (service `openclaw`, account `github-pat` —
shared with OpenClaw itself):
```bash
security add-generic-password -s openclaw -a github-pat -w "ghp_your_token_here" \
  -T /opt/homebrew/opt/node@22/bin/node \
  -T /opt/homebrew/bin/node \
  -T '' \
  -U
```
The `-T` flags pre-authorize the binaries that will read the entry. Both node
paths matter — the gateway invokes one path directly, and helper subprocesses
may resolve through the brew-managed symlink (a separate ACL identity). Without
these, headless callers (LaunchAgents) hang on an invisible Keychain prompt —
see `docs/openclaw-setup/04-secure-gmail.md` §7 for the full recovery
procedure if you've already created an entry without these flags.

Or pass directly:
```typescript
const llm = new CopilotLLMClient({ githubToken: "ghp_..." });
```

### Timeouts and logging

All chat completion calls are bounded by a hard timeout (default 30s, override
with `requestTimeoutMs`) using both the OpenAI SDK's `timeout`/`maxRetries: 0`
options and an `AbortSignal`. A `slowCallMs` warning (default 10s) fires for
chronic slowness before it becomes a wedge. The token-exchange fetch is bounded
separately by `tokenExchangeTimeoutMs` (default 15s).

Every call emits structured JSON to stderr (lands in
`~/.openclaw/logs/gateway.err.log`):

| Event | Fields |
|---|---|
| `llm_call_start` | `call_id`, `label`, `model`, `content_len`, `timeout_ms` |
| `llm_call_done` | `call_id`, `label`, `elapsed_ms`, `outcome: "ok"`, `response_len` |
| `llm_call_slow` | `call_id`, `label`, `elapsed_ms`, `threshold_ms` |
| `llm_call_timeout` | `call_id`, `label`, `elapsed_ms`, `error` |
| `llm_call_error` | `call_id`, `label`, `elapsed_ms`, `error` |
| `classify_start` / `classify_done` | `label`, `elapsed_ms`, `outcome`, `detected` |
| `token_refresh_start` / `token_refresh_done` / `token_refresh_error` | `elapsed_ms`, `expires_in_ms` |

`label` identifies the caller (e.g. `leak.secrets`, `injection`, `secret-redact`,
`contacts-egress.sensitive`) so wedges can be diagnosed quickly.

## Development

```bash
npm install
npm test          # Run tests
npm run build     # Compile TypeScript
npm run lint      # Type check
```
