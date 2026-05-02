/**
 * Shared key set + prefilter for the secure-apple-calendar plugin.
 *
 * Mirrors apple-pim's own `UNTRUSTED_FIELDS.event` schema
 * (`Apple-PIM-Agent-Plugin/lib/sanitize.js`):
 *
 *   event: ["title", "notes", "location", "url"]
 *
 * Plus attendee `name` (set by remote invitations) and `email` (display
 * portion can be spoofed). Everything else in the calendar response (event
 * IDs, calendar IDs, dates, allDay, recurrence struct, attendee
 * status/role enums, success flags, counts, verification dicts, error
 * messages) is structural envelope and intentionally NOT scanned.
 *
 * Keep this set in sync with upstream `UNTRUSTED_FIELDS.event` whenever
 * apple-pim adds a new attacker-controlled field.
 */
import { makeUntrustedKeysPrefilter } from "mcp-hooks";

export const CALENDAR_UNTRUSTED_KEYS: ReadonlySet<string> = new Set([
  "title",
  "notes",
  "location",
  "url",
  "name",
  "email",
  // System-generated NSError messages can echo user/remote input
  // (e.g. EventKit refusing a malformed title). Cheap to scan.
  "error",
]);

export const calendarPrefilter = makeUntrustedKeysPrefilter({
  untrustedKeys: CALENDAR_UNTRUSTED_KEYS,
});
