# mcp-hooks Eval Harness

Offline accuracy measurement for the LLM-powered hooks in this package:

| Eval        | Hook                            | What it measures                                              |
| ----------- | ------------------------------- | ------------------------------------------------------------- |
| `secrets`   | `LeakGuard` (secrets prompt)    | Does the LLM correctly flag content containing secrets?       |
| `sensitive` | `LeakGuard` (sensitive prompt)  | Does the LLM correctly flag medical / legal / financial info? |
| `pii`       | `LeakGuard` (pii prompt)        | Does the LLM correctly flag personally-identifying info?      |
| `injection` | `InjectionGuard`                | Does the LLM correctly flag prompt-injection attempts?        |
| `redact`    | `SecretRedactor` (full pipeline) | Does the regex+LLM redactor remove every expected secret?     |

The boolean evals (`secrets`/`sensitive`/`pii`/`injection`) wrap the same
`classifyBoolean()` helper used in production, with the same prompts (single
source of truth in `src/prompts.ts`). The `redact` eval invokes the full
`SecretRedactor.check()` — regex pre-pass + LLM — to measure what production
actually sees end-to-end.

## How this differs from unit tests

- **Unit tests** mock the LLM and verify wiring/control flow. They tell us "is
  the code correct given a known LLM output?"
- **Evals** call the real Copilot LLM API and measure classifier accuracy
  against hand-curated cases. They tell us "is the prompt + model good enough
  to deploy?"

## Quickstart

```bash
# Requires a Copilot PAT in the macOS keychain (service "openclaw" or
# "mcp-hooks"). Without one, the harness skips with a warning.
pnpm --filter mcp-hooks eval                      # run all 5
pnpm --filter mcp-hooks eval:secrets              # run one
pnpm --filter mcp-hooks eval --eval=injection -v  # verbose
pnpm --filter mcp-hooks eval --output-dir=evals/baselines  # commit results
```

## Two metric views

Every eval reports two metric blocks:

- **`metricsProduction`** — failed classify calls (`api_error`, `parse_error`)
  count as `predicted = false`. This mirrors production's fail-open semantics:
  if the LLM call fails, we let the message through. **Use this view to
  predict real-world behavior.**
- **`metricsValidOnly`** — excludes `api_error` / `parse_error` cases. **Use
  this view to evaluate prompt quality**, isolated from infra reliability.

Sample-size warnings: any per-category bucket with `n < 10` is tagged
`warning: "low_sample_size"`. Phase 1 datasets are intentionally small —
treat per-category numbers as smoke-test diagnostics, not performance claims.

## Datasets

Hand-curated JSON arrays in `evals/datasets/`. ~25 cases per eval (Phase 1).

Each case has:
- `id` — stable identifier (e.g. `sec-001`)
- `category` — ad-hoc category for breakdown reports
- `difficulty` — `easy` / `medium` / `hard`
- `expected` — boolean (or `expected_redactions: []` for redact)
- `content` **OR** `content_b64`

### Why `content_b64`?

Cases whose content matches known credential patterns (real-looking
`AKIA...`, `ghp_...`, `sk_live_...`, JWT) trigger GitHub push protection and
secret scanning when committed verbatim — even though they're synthetic test
fixtures. We base64-encode those cases so the literal patterns never appear
in the repo. The runner decodes once at load time.

`evals/datasets/**` and `evals/baselines/**` are also listed in
`.github/secret_scanning.yml` `paths-ignore` to silence ongoing scans.

## Reports

`runEval()` writes a JSON report per eval. Schema (see `evals/types.ts` for
canonical types):

```json
{
  "eval": "secrets",
  "model": "claude-haiku-4.5",
  "createdAt": "2026-04-26T00:56:19.752Z",
  "gitSha": "<commit>",
  "promptHash": "<sha256[:12]>",
  "datasetHash": "<sha256[:12]>",
  "datasetSize": 30,
  "metricsProduction": { "n": 30, "tp": 16, "fp": 1, "tn": 12, "fn": 1, "precision": 0.94, "recall": 0.94, "f1": 0.94, "fpr": 0.077 },
  "metricsValidOnly":  { ... },
  "byCategory":   [ { "key": "...", "n": 1, ..., "warning": "low_sample_size" } ],
  "byDifficulty": [ { "key": "easy", ... } ],
  "errorCounts":  { "api_error": 0, "parse_error": 1 },
  "concurrency": 4,
  "retries": 2
}
```

Promoting a report to `evals/baselines/` commits it. `evals/results/` is
gitignored — that's the default scratch dir for local runs.

## Phase 1 scope (this repo)

- ✅ Harness + 5 hand-written seed datasets (~25 cases each, 125 total)
- ✅ Baseline run committed to `evals/baselines/`
- ✅ Production-semantics + valid-only metric views
- ✅ Prompt centralization (`src/prompts.ts`) so eval and production stay in sync

## Phase 2 (deferred)

Scale datasets to 5K+ cases per eval using Opus-generated synthetic data
seeded by Phase 1's hand-curated examples. Add stratified sampling and
cost/latency metrics.

## Phase 3 (deferred)

Iterate prompts to close gaps surfaced by Phase 2. Track prompt-vs-baseline
deltas. Currently `redact` shows an elevated FPR (~40%) — over-redaction of
clean content — which is the obvious first tuning target.
