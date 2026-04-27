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
security add-generic-password -s "openclaw" -a "github-pat" -w "ghp_your_token_here"
```

Or pass directly:
```typescript
const llm = new CopilotLLMClient({ githubToken: "ghp_..." });
```

## Development

```bash
npm install
npm test          # Run tests
npm run build     # Compile TypeScript
npm run lint      # Type check
```
