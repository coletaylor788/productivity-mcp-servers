import type { CopilotLLMClient } from "../copilot-llm.js";
import type { HookResult } from "../types.js";
import { classifyBoolean } from "../classify.js";
import { INJECTION_PROMPT } from "../prompts.js";

/**
 * Optional transform that scopes which slice of the tool's response is sent
 * to the prompt-injection LLM classifier.
 *
 * The plugin owns the structure of its tool output (which fields are
 * structural envelope vs which are user/attacker-controlled free-text
 * payload), and is therefore the right layer to decide which substring(s)
 * the classifier should judge. Returning a narrower slice both focuses the
 * model on the high-signal surface (e.g. email `body`/`subject`, calendar
 * `notes`) and reduces false positives on benign envelope fields.
 *
 * Contract:
 *   - Receives the raw content from the tool response.
 *   - Returns the substring to scan; may be empty (skips the LLM call,
 *     allows the response through).
 *   - Must be synchronous and side-effect free.
 *
 * Security boundary: this is a SCOPING knob, not an authorization knob.
 * Anything excluded from the returned slice is NOT scanned for prompt
 * injection. Plugin authors must therefore only exclude content they trust
 * to be structural envelope (e.g. opaque object IDs, server-set status
 * fields), never user/attacker-controlled payload. No auto-default is
 * provided — the hook can't tell trusted envelope from untrusted payload
 * by inspection alone.
 */
export type InjectionGuardPrefilter = (
  toolName: string,
  content: string,
) => string;

export class InjectionGuard {
  readonly name = "InjectionGuard";
  private llm: CopilotLLMClient;
  private prefilter?: InjectionGuardPrefilter;

  constructor(options: {
    llm: CopilotLLMClient;
    prefilter?: InjectionGuardPrefilter;
  }) {
    this.llm = options.llm;
    this.prefilter = options.prefilter;
  }

  async check(toolName: string, content: string): Promise<HookResult> {
    let scanInput = content;
    if (this.prefilter) {
      try {
        scanInput = this.prefilter(toolName, content);
      } catch {
        // Prefilter failure: fall back to scanning the full content.
        scanInput = content;
      }
    }

    if (scanInput.length === 0) {
      return { action: "allow" };
    }

    const result = await classifyBoolean(this.llm, scanInput, INJECTION_PROMPT, "injection");
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
