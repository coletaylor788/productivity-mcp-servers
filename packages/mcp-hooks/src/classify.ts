import type { CopilotLLMClient } from "./copilot-llm.js";

/**
 * Outcome of a boolean LLM classification call. Used by LeakGuard,
 * SendApproval, InjectionGuard, and the eval harness.
 *
 * `outcome` distinguishes the failure modes that production callers all
 * collapse to "fail open" but evals want to track separately:
 *  - "ok"          — model returned valid JSON; trust `detected`/`evidence`
 *  - "parse_error" — model returned invalid/unexpected JSON
 *  - "api_error"   — network or API failure (already wrapped by CopilotLLMClient)
 *
 * Production hooks should treat anything other than `ok` as `detected: false`
 * (preserving fail-open behavior). The eval harness uses `outcome` to compute
 * a separate "valid responses only" metric view alongside the
 * production-semantics view.
 */
export interface ClassificationResult {
  detected: boolean;
  evidence: string;
  outcome: "ok" | "parse_error" | "api_error";
  raw?: string;
  error?: string;
}

/**
 * Run a single boolean classification: ask the LLM whether `content` matches
 * `prompt`, parse the response as `{detected, evidence}`. Always returns
 * (never throws) — failure modes are surfaced via `outcome`.
 */
export async function classifyBoolean(
  llm: CopilotLLMClient,
  content: string,
  prompt: string,
): Promise<ClassificationResult> {
  let raw: string;
  try {
    raw = await llm.classify(content, prompt);
  } catch (err) {
    return {
      detected: false,
      evidence: "",
      outcome: "api_error",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      detected: Boolean(parsed.detected),
      evidence: String(parsed.evidence ?? ""),
      outcome: "ok",
      raw,
    };
  } catch (err) {
    return {
      detected: false,
      evidence: "",
      outcome: "parse_error",
      raw,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
