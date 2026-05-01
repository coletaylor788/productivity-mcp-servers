import type { CopilotLLMClient } from "../copilot-llm.js";
import type { HookResult } from "../types.js";
import { REDACT_PROMPT } from "../prompts.js";

// Regex patterns for common secret formats
const REGEX_PATTERNS: Array<{ pattern: RegExp; type: string }> = [
  // API keys with known prefixes
  { pattern: /\b(sk-proj-[A-Za-z0-9_-]{20,})\b/g, type: "api_key" },
  { pattern: /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g, type: "api_key" },
  { pattern: /\b(sk-[A-Za-z0-9]{32,})\b/g, type: "api_key" },
  { pattern: /\b(ghp_[A-Za-z0-9]{36,})\b/g, type: "github_token" },
  { pattern: /\b(gho_[A-Za-z0-9]{36,})\b/g, type: "github_token" },
  { pattern: /\b(ghs_[A-Za-z0-9]{36,})\b/g, type: "github_token" },
  { pattern: /\b(github_pat_[A-Za-z0-9_]{22,})\b/g, type: "github_token" },
  { pattern: /\b(AKIA[0-9A-Z]{16})\b/g, type: "aws_key" },
  { pattern: /\b(xoxb-[0-9]+-[A-Za-z0-9-]+)\b/g, type: "slack_token" },
  { pattern: /\b(xoxp-[0-9]+-[A-Za-z0-9-]+)\b/g, type: "slack_token" },
  { pattern: /\b(xoxs-[0-9]+-[A-Za-z0-9-]+)\b/g, type: "slack_token" },

  // JWT tokens
  { pattern: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, type: "jwt" },

  // Private keys
  { pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, type: "private_key" },
  { pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?-----END PGP PRIVATE KEY BLOCK-----/g, type: "private_key" },

  // Connection strings
  { pattern: /((?:postgres|postgresql|mysql|mongodb\+srv|redis|amqp):\/\/[^\s"'`]+)/g, type: "connection_string" },

  // Bearer tokens in headers
  { pattern: /Authorization:\s*Bearer\s+([A-Za-z0-9_\-.~+/]+=*)/gi, type: "bearer_token" },

  // Password reset / magic links
  { pattern: /(https?:\/\/[^\s"'`]*(?:reset|verify|confirm|login|signin|auth|activate|invite)[^\s"'`]*[?&](?:token|code|key|nonce)=[^\s"'`&]{8,})/gi, type: "reset_link" },

  // 2FA/verification codes in context
  { pattern: /(?:code|verification|verify|OTP|2FA|MFA|passcode)[\s:]*(?:is\s+)?(\d{4,8})\b/gi, type: "2fa_code" },
  { pattern: /\b([A-Z]-?\d{5,6})\b/g, type: "2fa_code" }, // G-123456 format

  // SSN
  { pattern: /\b(\d{3}-\d{2}-\d{4})\b/g, type: "ssn" },

  // Credit card numbers (basic)
  { pattern: /\b(\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4})\b/g, type: "credit_card" },
];

/**
 * Optional transform that scopes which slice of the tool's response is sent
 * to the Phase-2 LLM redaction scan.
 *
 * The plugin owns the structure of its tool output (envelope fields vs
 * untrusted free-text payload), and is therefore the right layer to decide
 * which substring(s) the LLM should judge. Returning a narrower slice both
 * focuses LLM attention on the high-signal surface (where credentials would
 * actually leak — e.g. `body`, `notes`, `description`) and reduces false
 * positives on opaque object identifiers (e.g. `id`, `event_id`, `etag`)
 * that are routable handles, not secrets.
 *
 * Contract:
 *   - Receives the regex-redacted content (Phase-1 has already run).
 *   - Returns the substring to scan; may be empty (skips the LLM call) or
 *     reformatted free text. Findings the LLM emits are still applied to
 *     the FULL post-Phase-1 content; any finding whose `secret` substring
 *     does not appear verbatim in the full content is dropped.
 *   - Must be synchronous and side-effect free.
 *
 * Security boundary: this is a SCOPING knob, not an authorization knob.
 * Anything excluded from the returned slice is NOT scanned for secrets.
 * Plugin authors must therefore only exclude content they trust to be
 * structural envelope (e.g. opaque object IDs from a verified upstream),
 * never user/attacker-controlled payload.
 */
export type SecretRedactorPrefilter = (
  toolName: string,
  content: string,
) => string;

export class SecretRedactor {
  readonly name = "SecretRedactor";
  private llm: CopilotLLMClient;
  private prefilter?: SecretRedactorPrefilter;

  constructor(options: {
    llm: CopilotLLMClient;
    prefilter?: SecretRedactorPrefilter;
  }) {
    this.llm = options.llm;
    this.prefilter = options.prefilter;
  }

  async check(toolName: string, content: string): Promise<HookResult> {
    // Phase 1: Regex
    let redacted = content;
    const findingTypes: string[] = [];
    let findingCount = 0;

    for (const { pattern, type } of REGEX_PATTERNS) {
      // Reset regex state for each use
      const regex = new RegExp(pattern.source, pattern.flags);
      const matches = redacted.matchAll(regex);
      for (const match of matches) {
        const secret = match[1] ?? match[0];
        redacted = redacted.replaceAll(secret, `[REDACTED:${type}]`);
        findingTypes.push(type);
        findingCount += 1;
      }
    }

    // Phase 2: LLM (on already-redacted content, optionally scoped by prefilter)
    let llmInput = redacted;
    if (this.prefilter) {
      try {
        llmInput = this.prefilter(toolName, redacted);
      } catch {
        // Prefilter failure: fall back to scanning the full post-Phase-1 content.
        llmInput = redacted;
      }
    }

    if (llmInput.length > 0) {
      try {
        const raw = await this.llm.classify(llmInput, REDACT_PROMPT, { label: "secret-redact" });
        const parsed = JSON.parse(raw);

        if (Array.isArray(parsed.findings)) {
          for (const finding of parsed.findings) {
            if (
              typeof finding.secret === "string" &&
              typeof finding.type === "string" &&
              redacted.includes(finding.secret)
            ) {
              redacted = redacted.replaceAll(
                finding.secret,
                `[REDACTED:${finding.type}]`,
              );
              findingTypes.push(finding.type);
              findingCount += 1;
            }
          }
        }
      } catch {
        // LLM failure: return regex-only results
      }
    }

    if (findingCount > 0) {
      return {
        action: "modify",
        content: redacted,
        details: { findingTypes, findingCount },
      };
    }

    return { action: "allow" };
  }
}
