#!/usr/bin/env tsx
/**
 * Eval CLI. Examples:
 *   pnpm eval                        # run all 5 evals
 *   pnpm eval --eval=secrets         # run one
 *   pnpm eval --eval=injection -v    # verbose per-case logging
 *   pnpm eval --eval=all --concurrency=2 --output-dir=evals/baselines
 *
 * Skips with a warning if no Copilot PAT is reachable in the keychain.
 */
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { CopilotLLMClient } from "../src/copilot-llm.js";
import { runEval, defaultDatasetPath, datasetExists } from "./runner.js";
import type { EvalName, EvalReport } from "./types.js";

interface ParsedArgs {
  evalName: EvalName | "all";
  verbose: boolean;
  concurrency: number;
  retries: number;
  timeoutMs: number;
  outputDir: string | null;
  model: string;
  datasetDir: string | null;
}

const ALL_EVALS: EvalName[] = ["secrets", "sensitive", "pii", "injection", "redact"];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!(await hasPat())) {
    console.warn(
      "[eval] No Copilot PAT in keychain (service 'openclaw' or 'mcp-hooks').",
    );
    console.warn("[eval] See packages/mcp-hooks/README.md#credential-setup. Skipping.");
    process.exit(0);
  }

  const llm = new CopilotLLMClient({ model: args.model });
  const evalsToRun: EvalName[] = args.evalName === "all" ? ALL_EVALS : [args.evalName];
  const reports: EvalReport[] = [];

  for (const evalName of evalsToRun) {
    const datasetPath = args.datasetDir
      ? resolve(args.datasetDir, `${evalName}.json`)
      : defaultDatasetPath(evalName);
    if (!datasetExists(datasetPath)) {
      console.warn(`[eval:${evalName}] dataset missing at ${datasetPath} — skipping`);
      continue;
    }

    const outputPath = args.outputDir
      ? resolve(args.outputDir, `${evalName}.json`)
      : undefined;
    if (outputPath) {
      await mkdir(resolve(outputPath, ".."), { recursive: true });
    }

    console.log(`\n=== ${evalName} (model=${args.model}) ===`);
    const report = await runEval({
      evalName,
      llm,
      model: args.model,
      datasetPath,
      outputPath,
      concurrency: args.concurrency,
      retries: args.retries,
      timeoutMs: args.timeoutMs,
      verbose: args.verbose,
    });
    reports.push(report);
    printSummary(report);
    if (outputPath) console.log(`  → wrote ${outputPath}`);
  }

  // Exit non-zero if any eval had API errors AND zero successful cases
  // (i.e. everything failed — likely an auth/network problem worth surfacing).
  const totalFailures = reports.reduce(
    (acc, r) => acc + (r.metricsValidOnly.n === 0 && r.datasetSize > 0 ? 1 : 0),
    0,
  );
  if (totalFailures > 0) {
    console.error(`\n[eval] ${totalFailures} eval(s) had no successful responses`);
    process.exit(2);
  }
  // CopilotLLMClient / keytar can leave handles open that keep the
  // event loop alive. Force exit on success.
  process.exit(0);
}

function printSummary(r: EvalReport): void {
  const p = r.metricsProduction;
  const v = r.metricsValidOnly;
  const fmt = (n: number | null) => (n == null ? "n/a" : (n * 100).toFixed(1) + "%");
  console.log(
    `  production : n=${p.n} P=${fmt(p.precision)} R=${fmt(p.recall)} F1=${fmt(p.f1)} FPR=${fmt(p.fpr)}`,
  );
  console.log(
    `  valid-only : n=${v.n} P=${fmt(v.precision)} R=${fmt(v.recall)} F1=${fmt(v.f1)} FPR=${fmt(v.fpr)}`,
  );
  console.log(
    `  errors     : api=${r.errorCounts.api_error} parse=${r.errorCounts.parse_error}`,
  );
  if (r.byDifficulty.length) {
    const parts = r.byDifficulty.map(
      (b) => `${b.key}=F1:${fmt(b.f1)}(n=${b.n})`,
    );
    console.log(`  difficulty : ${parts.join(" ")}`);
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    evalName: "all",
    verbose: false,
    concurrency: 4,
    retries: 2,
    timeoutMs: 30_000,
    outputDir: null,
    model: "claude-haiku-4.5",
    datasetDir: null,
  };
  for (const arg of argv) {
    if (arg === "-v" || arg === "--verbose") out.verbose = true;
    else if (arg.startsWith("--eval=")) out.evalName = arg.slice(7) as EvalName | "all";
    else if (arg.startsWith("--concurrency=")) out.concurrency = Number(arg.slice(14));
    else if (arg.startsWith("--retries=")) out.retries = Number(arg.slice(10));
    else if (arg.startsWith("--timeout-ms=")) out.timeoutMs = Number(arg.slice(13));
    else if (arg.startsWith("--output-dir=")) out.outputDir = arg.slice(13);
    else if (arg.startsWith("--model=")) out.model = arg.slice(8);
    else if (arg.startsWith("--dataset-dir=")) out.datasetDir = arg.slice(14);
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${arg}`);
      printHelp();
      process.exit(1);
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`Usage: tsx evals/cli.ts [options]

Options:
  --eval=<name>         secrets|sensitive|pii|injection|redact|all (default: all)
  --concurrency=<n>     concurrent LLM calls (default: 4)
  --retries=<n>         retries per case on transient failure (default: 2)
  --timeout-ms=<n>      per-call timeout (default: 30000)
  --model=<id>          Copilot model id (default: claude-haiku-4.5)
  --output-dir=<path>   write report JSON files into this directory
  --dataset-dir=<path>  override datasets/ path (used by tests)
  -v, --verbose         log each case as it runs
  -h, --help            this help text
`);
}

async function hasPat(): Promise<boolean> {
  try {
    const { default: keytar } = await import("keytar");
    for (const service of ["openclaw", "mcp-hooks"]) {
      const accounts = await keytar.findCredentials(service);
      if (accounts.length > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error("[eval] fatal:", err);
  process.exit(1);
});
