import type { CopilotLLMClient } from "./copilot-llm.js";
import { log } from "./logger.js";

/**
 * Outcome of a boolean LLM classification call. Used by LeakGuard,
 * ContactsEgressGuard, InjectionGuard, and the eval harness.
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
  label = "unlabeled",
): Promise<ClassificationResult> {
  const start = Date.now();
  log("classify_start", { label, content_len: content.length });
  let raw: string;
  try {
    raw = await llm.classify(content, prompt, { label });
  } catch (err) {
    const result: ClassificationResult = {
      detected: false,
      evidence: "",
      outcome: "api_error",
      error: err instanceof Error ? err.message : String(err),
    };
    log("classify_done", {
      label,
      elapsed_ms: Date.now() - start,
      outcome: "api_error",
      error: result.error,
    });
    return result;
  }

  try {
    const parsed = JSON.parse(raw);
    const result: ClassificationResult = {
      detected: Boolean(parsed.detected),
      evidence: String(parsed.evidence ?? ""),
      outcome: "ok",
      raw,
    };
    log("classify_done", {
      label,
      elapsed_ms: Date.now() - start,
      outcome: "ok",
      detected: result.detected,
    });
    return result;
  } catch (err) {
    const result: ClassificationResult = {
      detected: false,
      evidence: "",
      outcome: "parse_error",
      raw,
      error: err instanceof Error ? err.message : String(err),
    };
    log("classify_done", {
      label,
      elapsed_ms: Date.now() - start,
      outcome: "parse_error",
      error: result.error,
    });
    return result;
  }
}
