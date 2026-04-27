import type { CopilotLLMClient } from "../copilot-llm.js";
import type { HookResult } from "../types.js";
import { classifyBoolean } from "../classify.js";
import { SECRETS_PROMPT, SENSITIVE_PROMPT, PII_PROMPT } from "../prompts.js";

export class LeakGuard {
  private llm: CopilotLLMClient;

  constructor(options: { llm: CopilotLLMClient }) {
    this.llm = options.llm;
  }

  async check(_toolName: string, content: string): Promise<HookResult> {
    const [secrets, sensitive, pii] = await Promise.all([
      classifyBoolean(this.llm, content, SECRETS_PROMPT, "leak.secrets"),
      classifyBoolean(this.llm, content, SENSITIVE_PROMPT, "leak.sensitive"),
      classifyBoolean(this.llm, content, PII_PROMPT, "leak.pii"),
    ]);

    // Fail open: api_error/parse_error → treat as not-detected (matches prior behavior)
    if (secrets.outcome === "ok" && secrets.detected) {
      return { action: "block", reason: `Secrets detected: ${secrets.evidence}` };
    }
    if (sensitive.outcome === "ok" && sensitive.detected) {
      return { action: "block", reason: `Sensitive data detected: ${sensitive.evidence}` };
    }
    if (pii.outcome === "ok" && pii.detected) {
      return { action: "block", reason: `PII detected: ${pii.evidence}` };
    }

    return { action: "allow" };
  }
}
