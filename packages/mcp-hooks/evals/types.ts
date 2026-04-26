/**
 * Shared types for the hook eval harness.
 *
 * Two case shapes:
 *  - BooleanEvalCase: for secrets/sensitive/pii/injection — classifier
 *    returns boolean (detected/not), expected is a boolean.
 *  - RedactEvalCase: for the SecretRedactor end-to-end eval — runs the
 *    full check() pipeline (regex + LLM) and verifies that each expected
 *    secret string was replaced in the output.
 */

export interface BooleanEvalCase {
  id: string;
  /**
   * The text to classify. Provide EITHER `content` (plain) OR `content_b64`
   * (base64-encoded). Use `content_b64` for cases whose content matches
   * known credential regexes — committing the literal string would trigger
   * GitHub push protection / secret scanning. The runner decodes b64 once
   * at load time and forwards the plaintext to the classifier.
   */
  content?: string;
  content_b64?: string;
  expected: boolean;
  category: string;
  difficulty: "easy" | "medium" | "hard";
  notes?: string;
}

export interface RedactEvalCase {
  id: string;
  /** See BooleanEvalCase docstring for the b64 escape hatch rationale. */
  content?: string;
  content_b64?: string;
  /**
   * Each entry's `secret` MUST appear verbatim in the decoded `content`.
   * Use `secret_b64` for entries that would otherwise trigger secret
   * scanners. The eval passes for a positive case when ALL expected
   * secrets have been replaced by the redactor. An empty array represents
   * a clean-content negative case — passes when the redactor returns
   * `allow` (no findings).
   */
  expected_redactions: Array<{ secret?: string; secret_b64?: string; type: string }>;
  category: string;
  difficulty: "easy" | "medium" | "hard";
  notes?: string;
}

export type EvalName = "secrets" | "sensitive" | "pii" | "injection" | "redact";

/**
 * Per-case result. `outcome` mirrors classifyBoolean's outcome so the
 * runner can compute both production-semantics metrics (parse_error /
 * api_error → predicted false) and valid-responses-only metrics.
 */
export interface CaseRunResult {
  id: string;
  category: string;
  difficulty: "easy" | "medium" | "hard";
  expected: boolean;
  predicted: boolean;
  outcome: "ok" | "parse_error" | "api_error";
  evidence?: string;
  /** For redact cases: which expected secrets were not redacted. */
  missingRedactions?: string[];
  /** Latency in ms for diagnostic purposes. */
  latencyMs: number;
  error?: string;
}

export interface MetricBucket {
  n: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  fpr: number | null;
}

export interface BreakdownEntry extends MetricBucket {
  key: string;
  warning?: "low_sample_size";
}

export interface EvalReport {
  eval: EvalName;
  model: string;
  createdAt: string;
  gitSha: string | null;
  promptHash: string;
  datasetHash: string;
  datasetSize: number;
  concurrency: number;
  retries: number;
  /** Production-semantics: api_error/parse_error → predicted false. */
  metricsProduction: MetricBucket;
  /** Valid-responses-only: drops api_error and parse_error cases. */
  metricsValidOnly: MetricBucket;
  byCategory: BreakdownEntry[];
  byDifficulty: BreakdownEntry[];
  errorCounts: {
    api_error: number;
    parse_error: number;
  };
  /** Subset of cases the runner thinks are most actionable (FP/FN with `ok` outcome). */
  falsePositives: Array<{ id: string; category: string; evidence?: string }>;
  falseNegatives: Array<{ id: string; category: string; evidence?: string }>;
}
