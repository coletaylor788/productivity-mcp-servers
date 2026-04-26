import type { CopilotLLMClient } from "../copilot-llm.js";
import type { HookResult } from "../types.js";
import { classifyBoolean } from "../classify.js";
import { INJECTION_PROMPT } from "../prompts.js";

export class InjectionGuard {
  readonly name = "InjectionGuard";
  private llm: CopilotLLMClient;

  constructor(options: { llm: CopilotLLMClient }) {
    this.llm = options.llm;
  }

  async check(_toolName: string, content: string): Promise<HookResult> {
    const result = await classifyBoolean(this.llm, content, INJECTION_PROMPT);
    if (result.outcome !== "ok" || !result.detected) {
      // Fail open on api_error/parse_error to avoid blocking legitimate work
      return { action: "allow" };
    }
    const evidence = result.evidence || "unspecified";
    return {
      action: "block",
      reason: `Prompt injection detected: ${evidence}`,
      details: { evidence },
    };
  }
}
