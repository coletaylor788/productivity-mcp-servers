/**
 * Build a `SecretRedactorPrefilter` (and, once `InjectionGuard` gains a
 * compatible parameter, an injection-guard prefilter) that scopes the LLM
 * scan to JSON values whose key is in `untrustedKeys`.
 *
 * Intended for tool responses whose payload is JSON (or starts with a
 * preamble followed by `\n\n` then JSON, as apple-pim does). The walk:
 *
 *   1. Locate the JSON tail: prefer the `\n\n` separator (apple-pim style),
 *      else fall back to the first `{` (top-level object only — both
 *      gmail-mcp and apple-pim return objects at the top level).
 *   2. Recursively visit objects/arrays; whenever a key matches
 *      `untrustedKeys` and the value is a non-empty string, emit
 *      `<key>: <value>`. All other values are NOT scanned.
 *   3. If parsing fails (truncated response, unexpected non-JSON tail),
 *      return the original content so the scan still runs (defence in depth).
 *
 * Security boundary: this is a SCOPING knob, not an authorization knob.
 * Anything outside `untrustedKeys` is structural envelope (IDs, etags,
 * timestamps, enums, success flags, counts) and is intentionally NOT
 * scanned. Plugin authors must keep their `untrustedKeys` set in sync with
 * the actual schema of attacker-controlled fields emitted by their tool.
 */
export interface UntrustedKeysPrefilterOptions {
  /** Keys whose string values should be scanned. */
  untrustedKeys: ReadonlySet<string>;
}

export type SimplePrefilter = (toolName: string, content: string) => string;

export function makeUntrustedKeysPrefilter(
  options: UntrustedKeysPrefilterOptions,
): SimplePrefilter {
  const { untrustedKeys } = options;
  return (_toolName: string, content: string): string => {
    if (!content) return content;
    const parsed = parseJsonTail(content);
    if (parsed === null) {
      return content;
    }
    const parts: string[] = [];
    collect(parsed, untrustedKeys, parts);
    return parts.join("\n");
  };
}

/**
 * Parse the JSON portion of a tool response. Tries `\n\n` separator first
 * (apple-pim datamarking preamble), then falls back to first `{`.
 * Returns null on parse failure.
 */
function parseJsonTail(content: string): unknown | null {
  const sep = content.indexOf("\n\n");
  if (sep >= 0) {
    try {
      return JSON.parse(content.slice(sep + 2));
    } catch {
      /* fall through */
    }
  }
  const objStart = content.indexOf("{");
  if (objStart >= 0) {
    try {
      return JSON.parse(content.slice(objStart));
    } catch {
      /* fall through */
    }
  }
  return null;
}

function collect(
  node: unknown,
  untrustedKeys: ReadonlySet<string>,
  out: string[],
): void {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, untrustedKeys, out);
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (untrustedKeys.has(k) && typeof v === "string" && v.length > 0) {
        out.push(`${k}: ${v}`);
      } else {
        collect(v, untrustedKeys, out);
      }
    }
  }
}
