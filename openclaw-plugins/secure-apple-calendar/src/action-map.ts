import type { EgressHook, IngressHook } from "mcp-hooks";
import type { HookSelection } from "./wrap-tool.js";

/**
 * Hooks the action-map can wire into a calendar tool call. The egress hook
 * is `ContactsEgressGuard` (configured by plugin.ts with a calendar-aware
 * extractDestinations callback so it can see `attendees[].email`).
 */
export interface CalendarHooks {
  ingress: IngressHook[];
  /** Used for create/update/batch_create when the call has attendees. */
  egress: EgressHook[];
}

/** Action handled by apple-pim's `calendar` MCP tool. */
export type CalendarAction =
  | "list"
  | "events"
  | "get"
  | "search"
  | "create"
  | "update"
  | "delete"
  | "batch_create"
  | "schema";

/**
 * Read-only calendar actions. Surfaced as the `calendar_read` OpenClaw tool
 * so a sandboxed reader agent can query without being able to mutate.
 * `delete` is intentionally NOT here: it mutates state.
 * `schema` is here because it returns the input schema (discovery only).
 */
export const READ_ACTIONS = new Set<CalendarAction>([
  "list",
  "events",
  "get",
  "search",
  "schema",
]);

/**
 * Mutating calendar actions. Surfaced as the `calendar_write` OpenClaw tool.
 * Writes with attendees go through the egress guard (ContactsEgressGuard);
 * writes with no attendees pass through unhooked because nothing leaves the
 * user's iCloud account in those cases.
 */
export const WRITE_ACTIONS = new Set<CalendarAction>([
  "create",
  "update",
  "delete",
  "batch_create",
]);

/**
 * Decide which hooks should run for one calendar tool call.
 *
 * Per-action routing:
 *   - list, schema, delete                  → no hooks (metadata or pure mutation)
 *   - events, get, search                    → ingress only (read paths can carry
 *                                              prompt-injection from external
 *                                              attendees / shared calendars)
 *   - create, update, batch_create with attendees → egress guard
 *   - create, update, batch_create with no attendees → no hooks
 *
 * Why nothing on the no-attendee write path: the event lands only on the
 * user's own iCloud account; there's no recipient and no network egress to
 * an external party, so there's nothing for an egress hook to protect.
 *
 * Why no all-trusted-domain fast path: trusted-domain handling lives inside
 * `ContactsEgressGuard` itself, which short-circuits the contacts lookup but
 * still runs content classifiers on the egress payload as a final safety net.
 *
 * Egress content (when the guard runs) focuses on the user-supplied text
 * fields (title, notes, location, url) — the fields actually persisted and
 * shared with attendees.
 */
export function selectHooksForCalendar(
  args: Record<string, unknown>,
  hooks: CalendarHooks,
): HookSelection {
  const action = (args.action as CalendarAction | undefined) ?? "events";

  switch (action) {
    case "list":
    case "schema":
    case "delete":
      return {};

    case "events":
    case "get":
    case "search":
      return { ingress: hooks.ingress };

    case "create":
    case "update":
    case "batch_create": {
      const emails = extractAttendeeEmails(args);
      if (emails.length === 0) {
        // No recipient — event stays on the user's iCloud account only.
        return {};
      }
      return {
        egress: hooks.egress,
        egressContent: buildEgressContent(args),
      };
    }

    default:
      // Unknown action — fail closed: run ingress on the response so anything
      // unexpected at least gets injection-checked. Don't run egress (we don't
      // know the intent).
      return { ingress: hooks.ingress };
  }
}

/**
 * Pull every attendee email out of a calendar tool call. Handles both single
 * events (`args.attendees`) and batch creates (`args.events[].attendees`).
 * Lower-cased and de-duplicated.
 */
export function extractAttendeeEmails(args: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  const collect = (attendees: unknown) => {
    if (!Array.isArray(attendees)) return;
    for (const a of attendees) {
      if (a && typeof a === "object" && typeof (a as { email?: unknown }).email === "string") {
        const email = ((a as { email: string }).email).trim().toLowerCase();
        if (email.length > 0) seen.add(email);
      }
    }
  };

  collect(args.attendees);

  const events = args.events;
  if (Array.isArray(events)) {
    for (const ev of events) {
      if (ev && typeof ev === "object") {
        collect((ev as { attendees?: unknown }).attendees);
      }
    }
  }

  return Array.from(seen);
}

/**
 * `extractDestinations` callback for the egress guard. Routes calendar
 * attendees (single or batch) into the trust check. The plugin wires this
 * into the `ContactsEgressGuard` instance at construction time.
 */
export function calendarExtractDestinations(
  _toolName: string,
  params: Record<string, unknown>,
): string[] {
  return extractAttendeeEmails(params);
}

/**
 * Build a focused egress-content string from the user-supplied free-text
 * fields the agent could leak data into. Excludes IDs, calendar names, dates,
 * durations — those are not meaningful exfil channels.
 */
export function buildEgressContent(args: Record<string, unknown>): string {
  const parts: string[] = [];
  const pushField = (label: string, value: unknown) => {
    if (typeof value === "string" && value.length > 0) {
      parts.push(`${label}: ${value}`);
    }
  };

  pushField("title", args.title);
  pushField("location", args.location);
  pushField("notes", args.notes);
  pushField("url", args.url);

  // Batch create: include each event's free-text fields too.
  if (Array.isArray(args.events)) {
    for (let i = 0; i < args.events.length; i++) {
      const ev = args.events[i];
      if (ev && typeof ev === "object") {
        const e = ev as Record<string, unknown>;
        pushField(`events[${i}].title`, e.title);
        pushField(`events[${i}].location`, e.location);
        pushField(`events[${i}].notes`, e.notes);
        pushField(`events[${i}].url`, e.url);
      }
    }
  }

  return parts.join("\n");
}
