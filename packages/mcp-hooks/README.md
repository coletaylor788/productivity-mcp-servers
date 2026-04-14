# mcp-hooks

Security hooks for MCP tool pipelines. Provides egress and ingress content scanning powered by LLM classification via GitHub Copilot API.

## Hooks

### Egress (outbound content)

| Hook | Purpose | Runs on |
|------|---------|---------|
| **LeakGuard** | Blocks secrets, sensitive data, and PII from leaking via non-send tools | web_search, web_fetch, exec, etc. |
| **SendApproval** | Destination-aware trust check for deliberate communication | send_email, message, etc. |

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
  SendApproval,
  InjectionGuard,
  SecretRedactor,
  TrustStore,
} from "mcp-hooks";

// LLM client — reads GitHub PAT from keychain, exchanges for Copilot token
const llm = new CopilotLLMClient({ model: "claude-haiku-4.5" });

// Egress: block leaks on non-send tools
const leakGuard = new LeakGuard({ llm });
const result = await leakGuard.check("web_search", queryText);
// result.action: "allow" | "block"

// Egress: destination-aware approval for send tools
const trustStore = new TrustStore({
  pluginId: "secure-gmail",
  extractDestination: (toolName, params) => params.to as string,
});
trustStore.seedDomains(["mycompany.com"]);

const sendApproval = new SendApproval({ llm, trustStore });
const result = await sendApproval.check("send_email", emailBody, { to: "someone@random.com" });
// result.action: "allow" | "block"
// result.trustLevel: "unknown" | "approved" | "trusted"
// result.approval?: { title, description, severity }

// Ingress: detect prompt injection
const injectionGuard = new InjectionGuard({ llm });
const result = await injectionGuard.check("get_email", emailContent);
// result.action: "allow" | "block"

// Ingress: redact secrets
const secretRedactor = new SecretRedactor({ llm });
const result = await secretRedactor.check("get_email", emailContent);
// result.action: "allow" | "modify"
// result.content: redacted text (if "modify")
```

## Trust Model

SendApproval uses a two-tier trust model:

| Trust Level | Can message? | Can send PII? |
|---|---|---|
| **unknown** | Needs approval | Needs approval |
| **approved** | ✅ | Needs approval |
| **trusted** | ✅ | ✅ |

Secrets and sensitive data are **always blocked** regardless of trust.

Trust is built through user approvals:
- `allow-always` on unknown destination → upgrades to **approved**
- `allow-always` on approved destination (with PII) → upgrades to **trusted**

Trust stores persist to `~/.openclaw/trust/{pluginId}.json`.

## LLM Client

Uses GitHub Copilot API via two-step token exchange:

1. GitHub PAT (from keychain) → `api.github.com/copilot_internal/v2/token`
2. Copilot token → `api.individual.githubcopilot.com/v1/chat/completions`

Tokens cached in-memory with proactive refresh (5 min before expiry).

### Credential Setup

Store your GitHub PAT in macOS Keychain:
```bash
# Using security CLI
security add-generic-password -s "mcp-hooks" -a "github-pat" -w "ghp_your_token_here"
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
