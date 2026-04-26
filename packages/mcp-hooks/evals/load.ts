import type { BooleanEvalCase, RedactEvalCase } from "./types.js";

/**
 * Decode `content` from `content_b64` if present. Throws if neither or both
 * are set, or if a case is missing required fields.
 *
 * Why b64: secret-shaped fixtures (real-looking AWS / GitHub / Stripe keys)
 * trigger GitHub push protection / secret scanning when committed
 * verbatim. Storing them base64-encoded lets us version-control realistic
 * test corpora without leaking false-positive "secrets" into the repo.
 */
export function decodeBooleanCase(c: BooleanEvalCase): {
  content: string;
} & Omit<BooleanEvalCase, "content" | "content_b64"> {
  const content = decodeContent(c.id, c.content, c.content_b64);
  const { content: _c, content_b64: _b, ...rest } = c;
  return { ...rest, content };
}

export function decodeRedactCase(c: RedactEvalCase): {
  content: string;
  expected_redactions: Array<{ secret: string; type: string }>;
} & Omit<RedactEvalCase, "content" | "content_b64" | "expected_redactions"> {
  const content = decodeContent(c.id, c.content, c.content_b64);
  const expected_redactions = c.expected_redactions.map((e, i) => {
    const secret = e.secret ?? (e.secret_b64 ? b64decode(e.secret_b64) : undefined);
    if (secret == null) {
      throw new Error(`Case ${c.id} expected_redactions[${i}]: missing secret/secret_b64`);
    }
    if (!content.includes(secret)) {
      throw new Error(
        `Case ${c.id} expected_redactions[${i}]: secret not found in (decoded) content`,
      );
    }
    return { secret, type: e.type };
  });
  const { content: _c, content_b64: _b, expected_redactions: _r, ...rest } = c;
  return { ...rest, content, expected_redactions };
}

function decodeContent(
  id: string,
  plain?: string,
  encoded?: string,
): string {
  if (plain != null && encoded != null) {
    throw new Error(`Case ${id}: must specify content OR content_b64, not both`);
  }
  if (plain != null) return plain;
  if (encoded != null) return b64decode(encoded);
  throw new Error(`Case ${id}: missing content/content_b64`);
}

function b64decode(s: string): string {
  return Buffer.from(s, "base64").toString("utf8");
}
