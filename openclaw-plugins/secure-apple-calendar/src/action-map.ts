import type { EgressHook, IngressHook } from "mcp-hooks";
import type { HookSelection } from "./wrap-tool.js";

/**
 * Hooks the action-map can wire into a calendar tool call. SendApproval is
 * configured by the plugin entrypoint with a calendar-aware
 * extractDestinations callback so it can see `attendees[].email`.
 */
export interface CalendarHooks {
  ingress: IngressHook[];
  /** Used for create/update/batch_create when the call has attendees. */
  sendApproval: EgressHook;
  /** Used for create/update/batch_create when the call has NO attendees. */
  leakGuard: EgressHook;
}

export interface ActionMapOptions {
  /** Email domains whose attendees auto-pass SendApproval. Case-insensitive. */
  trustedAttendeeDomains?: string[];
}

/** Action handled by apple-pim's `calendar` MCP tool. */
type CalendarAction =
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
 * Decide which hooks should run for one calendar tool call.
 *
 * Per-action routing:
 *   - list, schema, delete                  → no hooks (metadata or pure mutation)
 *   - events, get, search                    → ingress only (read paths can carry
 *                                              prompt-injection from external
 *                                              attendees / shared calendars)
 *   - create, update, batch_create with attendees    → SendApproval (egress)
 *   - create, update, batch_create without attendees → LeakGuard (egress)
 *
 * Egress content focuses on the user-supplied text fields (title, notes,
 * location, url) — the fields actually persisted and shared with attendees.
 *
 * If every attendee's email is in `trustedAttendeeDomains`, the egress hook
 * is skipped (skipEgress=true) — the user has pre-approved this destination.
 */
export function selectHooksForCalendar(
  args: Record<string, unknown>,
  hooks: CalendarHooks,
  opts: ActionMapOptions = {},
): HookSelection {
  const action = (args.action as CalendarAction | undefined) ?? "events";
  const trustedDomains = normalizeDomains(opts.trustedAttendeeDomains ?? []);

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
      const egressContent = buildEgressContent(args);
      if (emails.length > 0) {
        if (allTrusted(emails, trustedDomains)) {
          return { skipEgress: true };
        }
        return {
          egress: [hooks.sendApproval],
          egressContent,
        };
      }
      return {
        egress: [hooks.leakGuard],
        egressContent,
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
 * `extractDestinations` callback for SendApproval. Routes calendar attendees
 * (single or batch) into the trust-store lookup. The plugin wires this into
 * the SendApproval instance at construction time.
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

function normalizeDomains(domains: string[]): string[] {
  return domains
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter((d) => d.length > 0);
}

function allTrusted(emails: string[], trustedDomains: string[]): boolean {
  if (trustedDomains.length === 0) return false;
  return emails.every((email) => {
    const at = email.lastIndexOf("@");
    if (at === -1) return false;
    const domain = email.slice(at + 1);
    return trustedDomains.includes(domain);
  });
}
