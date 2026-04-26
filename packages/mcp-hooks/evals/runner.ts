import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import type { CopilotLLMClient } from "../src/copilot-llm.js";
import { SecretRedactor } from "../src/ingress/secret-redactor.js";
import type {
  BooleanEvalCase,
  RedactEvalCase,
  EvalName,
  CaseRunResult,
  EvalReport,
  MetricBucket,
} from "./types.js";
import { computeMetrics, breakdown, round } from "./scoring.js";
import { makeBooleanClassifier, runRedact, promptForEval } from "./classifiers.js";
import { decodeBooleanCase, decodeRedactCase } from "./load.js";

export interface RunOptions {
  evalName: EvalName;
  llm: CopilotLLMClient;
  model: string;
  datasetPath: string;
  outputPath?: string;
  concurrency?: number;
  retries?: number;
  timeoutMs?: number;
  verbose?: boolean;
}

export async function runEval(opts: RunOptions): Promise<EvalReport> {
  const concurrency = opts.concurrency ?? 4;
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const datasetRaw = await readFile(opts.datasetPath, "utf8");
  const datasetHash = sha256(datasetRaw).slice(0, 12);

  const promptHash = sha256(promptForEval(opts.evalName)).slice(0, 12);

  let results: CaseRunResult[];
  if (opts.evalName === "redact") {
    const cases = (JSON.parse(datasetRaw) as RedactEvalCase[]).map(decodeRedactCase);
    results = await runRedactBatch(cases, opts.llm, {
      concurrency,
      retries,
      timeoutMs,
      verbose: opts.verbose ?? false,
    });
  } else {
    const cases = (JSON.parse(datasetRaw) as BooleanEvalCase[]).map(decodeBooleanCase);
    results = await runBooleanBatch(cases, opts.llm, opts.evalName, {
      concurrency,
      retries,
      timeoutMs,
      verbose: opts.verbose ?? false,
    });
  }

  const report = buildReport(opts.evalName, opts.model, datasetHash, promptHash, results, {
    concurrency,
    retries,
  });

  if (opts.outputPath) {
    await mkdir(dirname(opts.outputPath), { recursive: true });
    await writeFile(opts.outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  }
  return report;
}

interface BatchOpts {
  concurrency: number;
  retries: number;
  timeoutMs: number;
  verbose: boolean;
}

async function runBooleanBatch(
  cases: Array<{
    id: string;
    content: string;
    expected: boolean;
    category: string;
    difficulty: "easy" | "medium" | "hard";
  }>,
  llm: CopilotLLMClient,
  evalName: Exclude<EvalName, "redact">,
  opts: BatchOpts,
): Promise<CaseRunResult[]> {
  const classifier = makeBooleanClassifier(llm, evalName);
  return runWithConcurrency(cases, opts.concurrency, async (c) => {
    const start = Date.now();
    const result = await withRetry(
      () => withTimeout(classifier(c.content), opts.timeoutMs),
      opts.retries,
    );
    const latencyMs = Date.now() - start;
    const predicted = result.outcome === "ok" && result.detected;
    if (opts.verbose) logCase(c.id, c.expected, predicted, result.outcome);
    return {
      id: c.id,
      category: c.category,
      difficulty: c.difficulty,
      expected: c.expected,
      predicted,
      outcome: result.outcome,
      evidence: result.evidence,
      latencyMs,
      error: result.error,
    };
  });
}

async function runRedactBatch(
  cases: Array<{
    id: string;
    content: string;
    expected_redactions: Array<{ secret: string; type: string }>;
    category: string;
    difficulty: "easy" | "medium" | "hard";
  }>,
  llm: CopilotLLMClient,
  opts: BatchOpts,
): Promise<CaseRunResult[]> {
  const redactor = new SecretRedactor({ llm });
  return runWithConcurrency(cases, opts.concurrency, async (c) => {
    const start = Date.now();
    const expected = c.expected_redactions.map((e) => e.secret);
    const result = await withRetry(
      () => withTimeout(runRedact(redactor, "test_tool", c.content, expected), opts.timeoutMs),
      opts.retries,
    );
    const latencyMs = Date.now() - start;
    // Treat as "expected positive" if there's anything to redact.
    const expectedPositive = expected.length > 0;
    // Predicted positive = something was redacted, AND for positive cases
    // we additionally require all expected secrets to be redacted.
    let predicted: boolean;
    if (expectedPositive) {
      predicted = result.outcome === "ok" && result.missing.length === 0;
    } else {
      // Negative case: predicted = redactor reported anything (false positive)
      predicted = result.outcome === "ok" && !result.allowed;
    }
    if (opts.verbose) logCase(c.id, expectedPositive, predicted, result.outcome);
    return {
      id: c.id,
      category: c.category,
      difficulty: c.difficulty,
      expected: expectedPositive,
      predicted,
      outcome: result.outcome === "ok" ? "ok" : "api_error",
      missingRedactions: result.missing,
      latencyMs,
      error: result.error,
    };
  });
}

function buildReport(
  evalName: EvalName,
  model: string,
  datasetHash: string,
  promptHash: string,
  results: CaseRunResult[],
  knobs: { concurrency: number; retries: number },
): EvalReport {
  const metricsProduction = roundMetrics(computeMetrics(results));
  const validOnly = results.filter((r) => r.outcome === "ok");
  const metricsValidOnly = roundMetrics(computeMetrics(validOnly));
  const errorCounts = {
    api_error: results.filter((r) => r.outcome === "api_error").length,
    parse_error: results.filter((r) => r.outcome === "parse_error").length,
  };
  const fps = results.filter((r) => r.outcome === "ok" && !r.expected && r.predicted);
  const fns = results.filter((r) => r.outcome === "ok" && r.expected && !r.predicted);
  return {
    eval: evalName,
    model,
    createdAt: new Date().toISOString(),
    gitSha: gitSha(),
    promptHash,
    datasetHash,
    datasetSize: results.length,
    concurrency: knobs.concurrency,
    retries: knobs.retries,
    metricsProduction,
    metricsValidOnly,
    byCategory: breakdown(results, (r) => r.category).map(roundBucket),
    byDifficulty: breakdown(results, (r) => r.difficulty).map(roundBucket),
    errorCounts,
    falsePositives: fps.map((r) => ({ id: r.id, category: r.category, evidence: r.evidence })),
    falseNegatives: fns.map((r) => ({ id: r.id, category: r.category, evidence: r.evidence })),
  };
}

function roundMetrics(m: MetricBucket): MetricBucket {
  return {
    ...m,
    precision: round(m.precision),
    recall: round(m.recall),
    f1: round(m.f1),
    fpr: round(m.fpr),
  };
}

function roundBucket<T extends MetricBucket>(b: T): T {
  return {
    ...b,
    precision: round(b.precision),
    recall: round(b.recall),
    f1: round(b.f1),
    fpr: round(b.fpr),
  };
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

async function withRetry<T>(fn: () => Promise<T>, retries: number): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(250 * 2 ** attempt + Math.floor(Math.random() * 100));
      }
    }
  }
  throw lastErr;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function gitSha(): string | null {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim();
  } catch {
    return null;
  }
}

function logCase(id: string, expected: boolean, predicted: boolean, outcome: string): void {
  const ok = expected === predicted ? "✓" : "✗";
  const tag = outcome === "ok" ? "" : ` [${outcome}]`;
  // eslint-disable-next-line no-console
  console.log(`  ${ok} ${id} (expected=${expected}, predicted=${predicted}${tag})`);
}

/** Resolve a dataset path relative to the evals/ dir. */
export function defaultDatasetPath(evalName: EvalName): string {
  // import.meta.dirname is available in Node 20.11+
  const dir = (import.meta as { dirname?: string }).dirname
    ?? new URL(".", import.meta.url).pathname;
  return resolve(dir, "datasets", `${evalName}.json`);
}

/** Resolve a default output path: evals/results/<eval>-<timestamp>.json */
export function defaultOutputPath(evalName: EvalName): string {
  const dir = (import.meta as { dirname?: string }).dirname
    ?? new URL(".", import.meta.url).pathname;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(dir, "results", `${evalName}-${ts}.json`);
}

export function datasetExists(path: string): boolean {
  return existsSync(path);
}
