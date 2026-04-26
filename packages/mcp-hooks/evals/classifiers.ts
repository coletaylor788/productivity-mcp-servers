import type { CopilotLLMClient } from "../src/copilot-llm.js";
import { classifyBoolean, type ClassificationResult } from "../src/classify.js";
import {
  SECRETS_PROMPT,
  SENSITIVE_PROMPT,
  PII_PROMPT,
  INJECTION_PROMPT,
} from "../src/prompts.js";
import { SecretRedactor } from "../src/ingress/secret-redactor.js";
import type { EvalName } from "./types.js";

/**
 * Boolean classifier: takes content, returns a `ClassificationResult`.
 * Used by the runner to score boolean evals (secrets/sensitive/pii/injection).
 *
 * For these four evals we call the prompt in isolation rather than the
 * hook's full check(). This gives us per-prompt scores even though
 * LeakGuard composes three of them in production. Composite egress
 * scoring is deferred to Phase 2 (see plan 015).
 */
export type BooleanClassifier = (content: string) => Promise<ClassificationResult>;

export function makeBooleanClassifier(
  llm: CopilotLLMClient,
  evalName: Exclude<EvalName, "redact">,
): BooleanClassifier {
  const prompt = PROMPT_FOR_EVAL[evalName];
  return (content) => classifyBoolean(llm, content, prompt);
}

const PROMPT_FOR_EVAL: Record<Exclude<EvalName, "redact">, string> = {
  secrets: SECRETS_PROMPT,
  sensitive: SENSITIVE_PROMPT,
  pii: PII_PROMPT,
  injection: INJECTION_PROMPT,
};

/**
 * Returns the production prompt string for a given eval name. Used to
 * compute prompt hashes for report metadata.
 */
export function promptForEval(evalName: EvalName): string {
  if (evalName === "redact") {
    // Redact is end-to-end (regex + LLM), but we still hash the LLM prompt
    // alongside the regex pattern set so prompt-only changes are visible.
    return REDACT_PROMPT_FOR_HASH;
  }
  return PROMPT_FOR_EVAL[evalName];
}

import { REDACT_PROMPT } from "../src/prompts.js";
const REDACT_PROMPT_FOR_HASH = REDACT_PROMPT;

/**
 * Redact eval runner: invoke the full SecretRedactor.check() pipeline
 * (regex + LLM) and report which expected secret strings remain in the
 * output. This is what production sees, so we measure the production
 * pipeline rather than the LLM prompt in isolation.
 */
export interface RedactRunResult {
  outcome: "ok" | "api_error";
  redactedContent: string;
  /** Expected secret strings that are still present in the output. */
  missing: string[];
  /** True if the redactor returned `allow` (no findings). */
  allowed: boolean;
  error?: string;
}

export async function runRedact(
  redactor: SecretRedactor,
  toolName: string,
  content: string,
  expectedSecrets: string[],
): Promise<RedactRunResult> {
  try {
    const result = await redactor.check(toolName, content);
    const redacted = result.action === "modify" ? (result.content ?? content) : content;
    const missing = expectedSecrets.filter((s) => redacted.includes(s));
    return {
      outcome: "ok",
      redactedContent: redacted,
      missing,
      allowed: result.action === "allow",
    };
  } catch (err) {
    return {
      outcome: "api_error",
      redactedContent: content,
      missing: expectedSecrets,
      allowed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
