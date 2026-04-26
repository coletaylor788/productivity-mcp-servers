import type { CaseRunResult, MetricBucket, BreakdownEntry } from "./types.js";

/** Compute precision/recall/F1/FPR for a set of case results. */
export function computeMetrics(results: CaseRunResult[]): MetricBucket {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const r of results) {
    if (r.expected && r.predicted) tp++;
    else if (!r.expected && r.predicted) fp++;
    else if (!r.expected && !r.predicted) tn++;
    else fn++;
  }
  const n = results.length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 =
    precision != null && recall != null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;
  const fpr = fp + tn > 0 ? fp / (fp + tn) : null;
  return { n, tp, fp, tn, fn, precision, recall, f1, fpr };
}

/**
 * Group results by a key extractor and compute per-bucket metrics.
 * Buckets with n < 10 are tagged with `low_sample_size` — Phase 1 seed
 * datasets are intentionally small, so per-category metrics are smoke-test
 * diagnostics, not real performance claims.
 */
export function breakdown(
  results: CaseRunResult[],
  keyOf: (r: CaseRunResult) => string,
): BreakdownEntry[] {
  const groups = new Map<string, CaseRunResult[]>();
  for (const r of results) {
    const k = keyOf(r);
    let arr = groups.get(k);
    if (!arr) {
      arr = [];
      groups.set(k, arr);
    }
    arr.push(r);
  }
  return Array.from(groups.entries())
    .map(([key, group]) => {
      const m = computeMetrics(group);
      const entry: BreakdownEntry = { key, ...m };
      if (m.n < 10) entry.warning = "low_sample_size";
      return entry;
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function round(n: number | null, digits = 3): number | null {
  if (n == null) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}
