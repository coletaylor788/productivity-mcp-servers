#!/usr/bin/env tsx
/**
 * Phase 2a generator: produces ~500 synthetic eval cases per eval using
 * `claude-opus-4.7` with independent LLM validation.
 *
 * Usage:
 *   pnpm --filter mcp-hooks generate --eval=secrets
 *   pnpm --filter mcp-hooks generate --eval=all --concurrency=10
 *   pnpm --filter mcp-hooks generate --eval=secrets --target=100  # smoke test
 *
 * Pipeline (per case):
 *   1. Pick (category, intended_label, difficulty) round-robin.
 *   2. Generate via Opus with category-specific prompt + seed examples.
 *   3. Dedup by content hash against seeds + already-generated.
 *   4. Validate with an *independent* prompt (NOT the production prompt).
 *      Drop if validator's answer disagrees with intended label.
 *   5. Auto-encode as content_b64 if content matches a credential regex
 *      (avoids GitHub push protection on the eventual commit).
 *
 * Output: writes to evals/datasets/<eval>.json (replaces seed file with
 * seeds + generated combined). Seed files remain in evals/datasets/seeds/.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CopilotLLMClient } from "../src/copilot-llm.js";
import {
  GEN_CONFIGS,
  type BooleanGenConfig,
  type CategorySpec,
  type EvalGenConfig,
  type RedactGenConfig,
} from "./generate-config.js";
import type {
  BooleanEvalCase,
  EvalName,
  RedactEvalCase,
} from "./types.js";

const ALL_EVALS: EvalName[] = ["secrets", "sensitive", "pii", "injection", "redact"];
const LLM_CALL_TIMEOUT_MS = 60_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
const HERE = dirname(new URL(import.meta.url).pathname);
const SEEDS_DIR = resolve(HERE, "datasets", "seeds");
const DATASETS_DIR = resolve(HERE, "datasets");

// Regexes that GitHub push protection / common secret scanners will catch.
// Generated content matching ANY of these is auto-encoded as content_b64.
const SCANNER_PATTERNS: RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{36,}\b/,
  /\bgho_[A-Za-z0-9]{36,}\b/,
  /\bghs_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  /\bsk-proj-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  /\bsk_live_[A-Za-z0-9]{16,}\b/,
  /\bsk_test_[A-Za-z0-9]{16,}\b/,
  /\bxox[bpsao]-[0-9A-Za-z-]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];

interface ParsedArgs {
  evalName: EvalName | "all";
  concurrency: number;
  retries: number;
  target: number | null;
  model: string;
  validatorModel: string;
}

interface GenJob {
  category: CategorySpec;
  expected: boolean;
}

interface RejectionStats {
  total_attempts: number;
  generated: number;
  validation_rejected: number;
  duplicate: number;
  parse_error: number;
  api_error: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const evalsToRun: EvalName[] = args.evalName === "all" ? ALL_EVALS : [args.evalName];

  const llm = new CopilotLLMClient({ model: args.model });
  const validatorLLM =
    args.validatorModel === args.model
      ? llm
      : new CopilotLLMClient({ model: args.validatorModel });

  for (const evalName of evalsToRun) {
    const cfg = GEN_CONFIGS[evalName];
    if (!cfg) {
      console.error(`No generate-config for ${evalName}`);
      continue;
    }
    const target = args.target ?? cfg.totalTarget;
    console.log(`\n=== generating ${evalName} (target=${target}) ===`);
    await generateOne(evalName, cfg, target, args, llm, validatorLLM);
  }

  process.exit(0);
}

async function generateOne(
  evalName: EvalName,
  cfg: EvalGenConfig,
  target: number,
  args: ParsedArgs,
  llm: CopilotLLMClient,
  validatorLLM: CopilotLLMClient,
): Promise<void> {
  const seedPath = resolve(SEEDS_DIR, `${evalName}.json`);
  if (!existsSync(seedPath)) {
    console.error(`Missing seed file: ${seedPath}`);
    return;
  }
  const seedRaw = await readFile(seedPath, "utf8");
  const seedCases = JSON.parse(seedRaw) as Array<BooleanEvalCase | RedactEvalCase>;

  // Dedup set: hashes of decoded content
  const seenHashes = new Set<string>(seedCases.map(hashCase));
  const generated: Array<BooleanEvalCase | RedactEvalCase> = [];

  // Build job queue
  const jobs = buildJobQueue(cfg, target);
  const stats: RejectionStats = {
    total_attempts: 0,
    generated: 0,
    validation_rejected: 0,
    duplicate: 0,
    parse_error: 0,
    api_error: 0,
  };

  let nextIdNum = nextIdStart(evalName, seedCases);
  const idPrefix = ID_PREFIX[evalName];

  // Round-robin worker pool.
  const queue = [...jobs];
  const workers: Promise<void>[] = [];
  for (let w = 0; w < args.concurrency; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  // Combine seeds + generated; write to datasets/<eval>.json
  // Seed cases get source: "seed"; generated get source: "generated".
  const combined = [
    ...seedCases.map((c) => annotateSource(c, "seed")),
    ...generated,
  ];
  const outPath = resolve(DATASETS_DIR, `${evalName}.json`);
  await mkdir(DATASETS_DIR, { recursive: true });
  await writeFile(outPath, JSON.stringify(combined, null, 2) + "\n");

  // Write rejection report
  const reportPath = resolve(DATASETS_DIR, `.gen-report-${evalName}.json`);
  await writeFile(
    reportPath,
    JSON.stringify(
      { evalName, target, model: args.model, validatorModel: args.validatorModel, stats, finalCount: combined.length, seedCount: seedCases.length, generatedCount: generated.length },
      null,
      2,
    ) + "\n",
  );

  console.log(
    `[${evalName}] generated=${generated.length} | rejected: validation=${stats.validation_rejected} duplicate=${stats.duplicate} parse=${stats.parse_error} api=${stats.api_error} | total cases=${combined.length}`,
  );

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) return;
      stats.total_attempts++;
      try {
        const result = await tryGenerateOne(cfg, job, llm, validatorLLM, args.retries);
        if (!result.ok) {
          stats[result.reason]++;
          // Re-queue category if we still need more in this category
          // (only for legitimate-noise rejections, not parse_error spam).
          if (result.reason === "validation_rejected" || result.reason === "duplicate") {
            queue.push(job);
          }
          continue;
        }
        const { content, secret } = result;
        const h = hashContent(content);
        if (seenHashes.has(h)) {
          stats.duplicate++;
          queue.push(job);
          continue;
        }
        seenHashes.add(h);

        const id = `${idPrefix}-gen-${String(nextIdNum++).padStart(4, "0")}`;
        const caseObj = buildCase(cfg, id, job, content, secret);
        generated.push(caseObj);
        stats.generated++;
        if (stats.generated % 5 === 0 || stats.generated <= 5) {
          console.log(`  [${evalName}] ${stats.generated}/${target} (rejects: val=${stats.validation_rejected} dup=${stats.duplicate} parse=${stats.parse_error} api=${stats.api_error})`);
        }
      } catch (err) {
        stats.api_error++;
        console.warn(`  [${evalName}] worker error: ${(err as Error).message}`);
      }
    }
  }
}

interface GenSuccess {
  ok: true;
  content: string;
  secret?: string; // only for redact
}
type GenFailReason = "validation_rejected" | "duplicate" | "parse_error" | "api_error";
interface GenFail {
  ok: false;
  reason: GenFailReason;
}

async function tryGenerateOne(
  cfg: EvalGenConfig,
  job: GenJob,
  llm: CopilotLLMClient,
  validatorLLM: CopilotLLMClient,
  retries: number,
): Promise<GenSuccess | GenFail> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    let content: string;
    let secret: string | undefined;
    try {
      const out = await callGenerator(cfg, job, llm);
      content = out.content;
      secret = out.secret;
    } catch (err) {
      if (attempt === retries) return { ok: false, reason: "api_error" };
      await sleep(500 * (attempt + 1));
      continue;
    }
    if (!content || content.length < 5) {
      if (attempt === retries) return { ok: false, reason: "parse_error" };
      continue;
    }
    if (cfg.kind === "redact" && job.expected && !secret) {
      if (attempt === retries) return { ok: false, reason: "parse_error" };
      continue;
    }
    if (cfg.kind === "redact" && job.expected && secret && !content.includes(secret)) {
      // Generator's secret not present verbatim — bad output.
      if (attempt === retries) return { ok: false, reason: "parse_error" };
      continue;
    }

    // Independent validation
    let validatorVerdict: boolean | null;
    try {
      validatorVerdict = await callValidator(cfg, content, secret, validatorLLM);
    } catch {
      if (attempt === retries) return { ok: false, reason: "api_error" };
      await sleep(500 * (attempt + 1));
      continue;
    }
    if (validatorVerdict === null) {
      if (attempt === retries) return { ok: false, reason: "parse_error" };
      continue;
    }
    if (validatorVerdict !== job.expected) {
      return { ok: false, reason: "validation_rejected" };
    }
    return { ok: true, content, secret };
  }
  return { ok: false, reason: "api_error" };
}

async function callGenerator(
  cfg: EvalGenConfig,
  job: GenJob,
  llm: CopilotLLMClient,
): Promise<{ content: string; secret?: string }> {
  const prompt = buildGeneratorPrompt(cfg, job);
  const userMsg = `Generate one case now. Return ONLY a JSON object, no prose, no markdown fences.`;
  const raw = await withTimeout(llm.classify(userMsg, prompt, { temperature: 0.9 }), LLM_CALL_TIMEOUT_MS, "generator");
  const obj = parseJsonLoose(raw);
  if (!obj || typeof obj !== "object") throw new Error("not an object");
  const content = (obj as { content?: unknown }).content;
  if (typeof content !== "string") throw new Error("missing content");
  if (cfg.kind === "redact") {
    const secret = (obj as { secret?: unknown }).secret;
    return {
      content,
      secret: typeof secret === "string" ? secret : undefined,
    };
  }
  return { content };
}

async function callValidator(
  cfg: EvalGenConfig,
  content: string,
  secret: string | undefined,
  llm: CopilotLLMClient,
): Promise<boolean | null> {
  // INDEPENDENT prompt — NOT the production prompt. Asks for plain yes/no.
  // For redact: validator confirms the generator-claimed secret is actually
  // a secret value visible in content (vs generator hallucination).
  if (cfg.kind === "redact") {
    if (!secret) {
      // Negative case: verify nothing redactable in content.
      const sys = `You are checking whether the following message contains any redactable secret values: passwords, passphrases, PINs, recovery codes, 2FA verification codes, or password reset URLs with embedded tokens. Answer with EXACTLY one word: "yes" or "no". Output nothing else.`;
      const ans = (await withTimeout(llm.classify(content, sys, { temperature: 0, maxTokens: 5 }), LLM_CALL_TIMEOUT_MS, "validator")).trim().toLowerCase();
      // Validator returns "yes" if content has a redactable secret.
      // We return the validator's belief about whether content matches the
      // POSITIVE definition; tryGenerateOne compares against job.expected.
      return ans.startsWith("y");
    }
    // Positive case: confirm `secret` is genuinely a redactable secret in `content`.
    const sys = `Given a message and a candidate string from that message, answer whether the candidate IS a real redactable secret value (password, passphrase, PIN, recovery code, 2FA code, or reset-link token) actively present in the message. Reply with EXACTLY one word: "yes" or "no". Output nothing else.`;
    const userMsg = `Message:\n<<<\n${content}\n>>>\n\nCandidate string: ${JSON.stringify(secret)}`;
    const ans = (await withTimeout(llm.classify(userMsg, sys, { temperature: 0, maxTokens: 5 }), LLM_CALL_TIMEOUT_MS, "validator")).trim().toLowerCase();
    return ans.startsWith("y");
  }

  const sys = `Read the message inside <<< >>> and answer whether ${cfg.taskDescription}. Reply with EXACTLY one word: "yes" or "no". Output nothing else.`;
  const userMsg = `<<<\n${content}\n>>>`;
  const ans = (await withTimeout(llm.classify(userMsg, sys, { temperature: 0, maxTokens: 5 }), LLM_CALL_TIMEOUT_MS, "validator")).trim().toLowerCase();
  if (ans.startsWith("y")) return true;
  if (ans.startsWith("n")) return false;
  return null;
}

function buildGeneratorPrompt(cfg: EvalGenConfig, job: GenJob): string {
  const labelDescription =
    cfg.kind === "boolean"
      ? job.expected
        ? cfg.positiveDefinition
        : cfg.negativeDefinition
      : job.expected
        ? "Content contains exactly one redactable secret value (password, passphrase, PIN, recovery code, 2FA code, or password reset URL token)."
        : "Content has NO redactable secret. Examples: already redacted, security advice, password policies, public keys, placeholder text.";

  const schema =
    cfg.kind === "redact" && job.expected
      ? `{"content": "<the message text>", "secret": "<the exact secret string that appears verbatim in content>"}`
      : `{"content": "<the message text>"}`;

  return [
    `You generate realistic synthetic test cases for an LLM classifier eval.`,
    ``,
    `The classifier decides: ${cfg.taskDescription}.`,
    ``,
    `You are producing ONE case where the correct answer is ${job.expected ? "YES (true)" : "NO (false)"}.`,
    ``,
    `Definition of this label: ${labelDescription}`,
    ``,
    `Category: "${job.category.key}" — ${job.category.description}`,
    `Difficulty: ${job.category.difficulty}`,
    ``,
    `Constraints:`,
    `- Generate realistic, varied content. Avoid templated boilerplate.`,
    `- Vary length: short (1 sentence), medium (2-4 sentences), or long (5+ sentences) at random.`,
    `- Vary surface form: chat message, email, Slack DM, Jira comment, calendar invite, PR comment, customer-support reply, etc.`,
    `- Vary tone: casual, formal, terse, verbose.`,
    `- Use realistic-looking but FAKE values. Never use real secrets, real names of real people, real account numbers. Plausible synthetic values only.`,
    `- For credential-shaped strings (AWS keys, GitHub tokens, Stripe keys, etc.) you MAY produce realistic-looking strings — they will be encoded before storage.`,
    `- Do NOT include surrounding commentary, explanations, or meta-talk. Just the message.`,
    ``,
    `Output strictly: ${schema}`,
    `Return only the JSON object. No code fences, no preamble.`,
  ].join("\n");
}

function buildJobQueue(cfg: EvalGenConfig, target: number): GenJob[] {
  const positiveTarget = Math.round(target * cfg.positiveRatio);
  const negativeTarget = target - positiveTarget;
  const posJobs = distributeJobs(cfg.positiveCategories, positiveTarget, true);
  const negJobs = distributeJobs(cfg.negativeCategories, negativeTarget, false);
  return shuffleInterleave(posJobs, negJobs);
}

function distributeJobs(cats: CategorySpec[], total: number, expected: boolean): GenJob[] {
  if (cats.length === 0) return [];
  const per = Math.floor(total / cats.length);
  const remainder = total - per * cats.length;
  const jobs: GenJob[] = [];
  cats.forEach((cat, i) => {
    const count = per + (i < remainder ? 1 : 0);
    for (let j = 0; j < count; j++) jobs.push({ category: cat, expected });
  });
  return jobs;
}

function shuffleInterleave(a: GenJob[], b: GenJob[]): GenJob[] {
  // Interleave then light shuffle, so workers don't all land on the same
  // category at the same time (which the API rate-limits less gracefully).
  const out: GenJob[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  // Fisher-Yates light shuffle
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function buildCase(
  cfg: EvalGenConfig,
  id: string,
  job: GenJob,
  content: string,
  secret?: string,
): BooleanEvalCase | RedactEvalCase {
  const needsB64 = SCANNER_PATTERNS.some((re) => re.test(content));
  const contentField = needsB64
    ? { content_b64: Buffer.from(content, "utf8").toString("base64") }
    : { content };

  if (cfg.kind === "redact") {
    if (!job.expected) {
      return {
        id,
        ...contentField,
        category: job.category.key,
        difficulty: job.category.difficulty,
        expected_redactions: [],
        source: "generated",
        generator_model: "claude-opus-4.7",
      } as RedactEvalCase & { source: string; generator_model: string };
    }
    const secretField =
      secret && SCANNER_PATTERNS.some((re) => re.test(secret))
        ? { secret_b64: Buffer.from(secret, "utf8").toString("base64") }
        : { secret: secret! };
    return {
      id,
      ...contentField,
      category: job.category.key,
      difficulty: job.category.difficulty,
      expected_redactions: [{ ...secretField, type: job.category.key }],
      source: "generated",
      generator_model: "claude-opus-4.7",
    } as RedactEvalCase & { source: string; generator_model: string };
  }

  return {
    id,
    ...contentField,
    expected: job.expected,
    category: job.category.key,
    difficulty: job.category.difficulty,
    source: "generated",
    generator_model: "claude-opus-4.7",
  } as BooleanEvalCase & { source: string; generator_model: string };
}

function annotateSource<T extends { source?: string }>(c: T, source: string): T {
  return { ...c, source: c.source ?? source };
}

function hashCase(c: BooleanEvalCase | RedactEvalCase): string {
  const content = c.content ?? (c.content_b64 ? Buffer.from(c.content_b64, "base64").toString("utf8") : "");
  return hashContent(content);
}

function hashContent(content: string): string {
  return createHash("sha256").update(content.trim().toLowerCase()).digest("hex").slice(0, 16);
}

const ID_PREFIX: Record<EvalName, string> = {
  secrets: "sec",
  sensitive: "sen",
  pii: "pii",
  injection: "inj",
  redact: "red",
};

function nextIdStart(evalName: EvalName, seedCases: Array<BooleanEvalCase | RedactEvalCase>): number {
  // Use 1000+ for generated to avoid collision with seed (sec-001..sec-030).
  // Seeds use up to 030; jump to 1000.
  return 1000;
}

function parseJsonLoose(raw: string): unknown {
  // Strip code fences (already done in CopilotLLMClient.classify) but be safe.
  const trimmed = raw.trim();
  // Try direct parse
  try {
    return JSON.parse(trimmed);
  } catch {}
  // Try to find a JSON object substring
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    evalName: "all",
    concurrency: 8,
    retries: 1,
    target: null,
    model: "claude-opus-4.7",
    validatorModel: "claude-opus-4.7",
  };
  for (const arg of argv) {
    if (arg.startsWith("--eval=")) out.evalName = arg.slice(7) as EvalName | "all";
    else if (arg.startsWith("--concurrency=")) out.concurrency = Number(arg.slice(14));
    else if (arg.startsWith("--retries=")) out.retries = Number(arg.slice(10));
    else if (arg.startsWith("--target=")) out.target = Number(arg.slice(9));
    else if (arg.startsWith("--model=")) out.model = arg.slice(8);
    else if (arg.startsWith("--validator-model=")) out.validatorModel = arg.slice(18);
    else if (arg === "-h" || arg === "--help") {
      console.log(`Usage: tsx evals/generate.ts --eval=<name> [--target=N] [--concurrency=N]\n  --eval: secrets|sensitive|pii|injection|redact|all\n  --target: override the per-eval target (default: from generate-config)\n  --concurrency: parallel Opus calls (default 8)\n  --model: generator model (default claude-opus-4.7)\n  --validator-model: validator model (default claude-opus-4.7)`);
      process.exit(0);
    } else if (arg.startsWith("--")) {
      console.error(`Unknown arg: ${arg}`);
      process.exit(1);
    }
  }
  return out;
}

main().catch((err) => {
  console.error("[generate] fatal:", err);
  process.exit(1);
});
