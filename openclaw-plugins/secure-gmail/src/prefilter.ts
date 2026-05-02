/**
 * Shared key set + prefilter for the secure-gmail plugin.
 *
 * gmail-mcp returns JSON for `list_emails` and `get_email`
 * (servers/gmail-mcp/src/gmail_mcp/server.py):
 *
 *   list_emails → { count, emails: [{ id, from, subject, date, snippet }] }
 *   get_email   → { from, to, cc?, subject, date, body_text?, body_html?,
 *                   attachments?: [{ filename, mime_type, size_bytes }] }
 *
 * Sender-controlled keys: from/to/cc (display portion), subject, snippet,
 * body_text, body_html, attachment filename. Everything else (`id`, `date`,
 * `count`, `mime_type`, `size_bytes`) is gmail-issued envelope and never
 * scanned.
 *
 * Keep this set in sync with the gmail-mcp response schema whenever a new
 * sender-controlled field is added.
 */
import { makeUntrustedKeysPrefilter } from "mcp-hooks";

export const GMAIL_UNTRUSTED_KEYS: ReadonlySet<string> = new Set([
  "from",
  "to",
  "cc",
  "subject",
  "snippet",
  "body_text",
  "body_html",
  "filename",
  // Google API error strings can echo subjects/sender content. Cheap to scan.
  "error",
]);

export const gmailPrefilter = makeUntrustedKeysPrefilter({
  untrustedKeys: GMAIL_UNTRUSTED_KEYS,
});
