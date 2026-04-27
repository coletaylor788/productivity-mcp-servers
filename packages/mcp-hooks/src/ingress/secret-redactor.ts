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

export class SecretRedactor {
  readonly name = "SecretRedactor";
  private llm: CopilotLLMClient;

  constructor(options: { llm: CopilotLLMClient }) {
    this.llm = options.llm;
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

    // Phase 2: LLM (on already-redacted content)
    try {
      const raw = await this.llm.classify(redacted, REDACT_PROMPT, { label: "secret-redact" });
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
