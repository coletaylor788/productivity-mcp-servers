/**
 * Structured JSON logging for mcp-hooks.
 *
 * Mirrors `gmail-mcp/logging_setup.py`: every event is one JSON object on stderr,
 * with fields sanitized so we never leak tokens or large payloads. These records
 * land in `~/.openclaw/logs/gateway.err.log` and are the primary signal for
 * diagnosing wedges/hangs in the LLM-powered hooks.
 *
 * Conventions:
 *  - `event` is a snake_case verb_noun ("llm_call_start", "classify_done").
 *  - `elapsed_ms` is a number, not a string.
 *  - `outcome` is one of "ok" | "timeout" | "error" | "slow".
 *  - Any field whose value is a string longer than `MAX_FIELD_LEN` is truncated;
 *    keys matching `SENSITIVE_KEY_RE` are replaced with `"<redacted>"`.
 */

const MAX_FIELD_LEN = 200;
const SENSITIVE_KEY_RE = /token|secret|password|api[_-]?key|authorization|bearer|cookie/i;

export type LogFields = Record<string, unknown>;

export function sanitize(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      out[k] = "<redacted>";
      continue;
    }
    if (typeof v === "string" && v.length > MAX_FIELD_LEN) {
      out[k] = `${v.slice(0, MAX_FIELD_LEN)}…(+${v.length - MAX_FIELD_LEN})`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function log(event: string, fields: LogFields = {}): void {
  const record = {
    ts: new Date().toISOString(),
    src: "mcp-hooks",
    event,
    ...sanitize(fields),
  };
  try {
    process.stderr.write(`${JSON.stringify(record)}\n`);
  } catch {
    // Logging must never throw.
  }
}
