import { describe, it, expect } from "vitest";
import {
  selectHooksForCalendar,
  extractAttendeeEmails,
  calendarExtractDestinations,
  buildEgressContent,
  type CalendarHooks,
} from "../src/action-map.js";
import type { EgressHook, IngressHook } from "mcp-hooks";

const stubIngress: IngressHook = {
  name: "Stub",
  async check() {
    return { action: "allow" } as const;
  },
};
const stubEgress: EgressHook = {
  async check() {
    return { action: "allow" } as const;
  },
};
const hooks: CalendarHooks = {
  ingress: [stubIngress],
  egress: [stubEgress],
};

describe("extractAttendeeEmails", () => {
  it("returns [] when no attendees field is present", () => {
    expect(extractAttendeeEmails({ action: "create", title: "x" })).toEqual([]);
  });

  it("extracts a single attendee email and lowercases it", () => {
    expect(
      extractAttendeeEmails({
        attendees: [{ email: "Alice@Example.COM", name: "A" }],
      }),
    ).toEqual(["alice@example.com"]);
  });

  it("dedups multiple attendees with the same email (case-insensitive)", () => {
    expect(
      extractAttendeeEmails({
        attendees: [
          { email: "a@x.com" },
          { email: "A@X.COM" },
          { email: "b@x.com" },
        ],
      }),
    ).toEqual(["a@x.com", "b@x.com"]);
  });

  it("ignores malformed attendee entries (no email, wrong type)", () => {
    expect(
      extractAttendeeEmails({
        attendees: [
          { email: "a@x.com" },
          { email: "" },
          { name: "no email here" },
          "not an object",
          null,
          { email: 42 },
        ],
      }),
    ).toEqual(["a@x.com"]);
  });

  it("walks batch_create events[].attendees", () => {
    expect(
      extractAttendeeEmails({
        events: [
          { title: "e1", attendees: [{ email: "a@x.com" }] },
          { title: "e2", attendees: [{ email: "b@y.com" }] },
          { title: "e3" },
        ],
      }),
    ).toEqual(["a@x.com", "b@y.com"]);
  });

  it("dedups across single + batch even though both are unusual together", () => {
    expect(
      extractAttendeeEmails({
        attendees: [{ email: "a@x.com" }],
        events: [{ attendees: [{ email: "A@X.COM" }, { email: "b@y.com" }] }],
      }),
    ).toEqual(["a@x.com", "b@y.com"]);
  });
});

describe("calendarExtractDestinations", () => {
  it("delegates to extractAttendeeEmails", () => {
    expect(
      calendarExtractDestinations("calendar", {
        attendees: [{ email: "a@x.com" }],
      }),
    ).toEqual(["a@x.com"]);
  });
});

describe("buildEgressContent", () => {
  it("returns labeled lines for the user-supplied free-text fields", () => {
    expect(
      buildEgressContent({
        action: "create",
        title: "Q3 review",
        location: "HQ",
        notes: "Bring slides",
        url: "https://example.com",
        // ignored:
        id: "abc",
        calendar: "Work",
        start: "2026-01-01T10:00:00Z",
      }),
    ).toBe("title: Q3 review\nlocation: HQ\nnotes: Bring slides\nurl: https://example.com");
  });

  it("includes batch_create event fields", () => {
    expect(
      buildEgressContent({
        events: [
          { title: "a", notes: "n1" },
          { title: "b", location: "L" },
        ],
      }),
    ).toBe("events[0].title: a\nevents[0].notes: n1\nevents[1].title: b\nevents[1].location: L");
  });

  it("returns empty string when no free-text fields are set", () => {
    expect(buildEgressContent({ action: "delete", id: "x" })).toBe("");
  });
});

describe("selectHooksForCalendar", () => {
  it("returns no hooks for list / schema / delete", () => {
    expect(selectHooksForCalendar({ action: "list" }, hooks)).toEqual({});
    expect(selectHooksForCalendar({ action: "schema" }, hooks)).toEqual({});
    expect(selectHooksForCalendar({ action: "delete", id: "x" }, hooks)).toEqual({});
  });

  it("returns ingress for events / get / search", () => {
    for (const action of ["events", "get", "search"] as const) {
      const sel = selectHooksForCalendar({ action }, hooks);
      expect(sel.ingress).toBe(hooks.ingress);
      expect(sel.egress).toBeUndefined();
    }
  });

  it("routes create with attendees → egress; egressContent excludes IDs/dates", () => {
    const sel = selectHooksForCalendar(
      {
        action: "create",
        title: "Sync",
        notes: "monthly",
        start: "2026-01-01",
        attendees: [{ email: "ext@other.com" }],
      },
      hooks,
    );
    expect(sel.egress).toBe(hooks.egress);
    expect(sel.skipEgress).toBeFalsy();
    expect(sel.egressContent).toBe("title: Sync\nnotes: monthly");
  });

  it("routes create without attendees → no hooks (event stays in user's iCloud)", () => {
    const sel = selectHooksForCalendar(
      { action: "create", title: "private", notes: "pwd hunter2" },
      hooks,
    );
    expect(sel.egress).toBeUndefined();
    expect(sel.ingress).toBeUndefined();
    expect(sel.skipEgress).toBeFalsy();
  });

  it("update with attendees → egress (same as create)", () => {
    const sel = selectHooksForCalendar(
      { action: "update", id: "evt-1", attendees: [{ email: "a@x.com" }] },
      hooks,
    );
    expect(sel.egress).toBe(hooks.egress);
  });

  it("batch_create with attendees on any event → egress", () => {
    const sel = selectHooksForCalendar(
      {
        action: "batch_create",
        events: [
          { title: "a" },
          { title: "b", attendees: [{ email: "c@x.com" }] },
        ],
      },
      hooks,
    );
    expect(sel.egress).toBe(hooks.egress);
  });

  it("batch_create with no attendees on any event → no hooks", () => {
    const sel = selectHooksForCalendar(
      {
        action: "batch_create",
        events: [{ title: "a" }, { title: "b" }],
      },
      hooks,
    );
    expect(sel.egress).toBeUndefined();
    expect(sel.ingress).toBeUndefined();
  });

  it("unknown actions fall back to ingress (fail-closed for reads)", () => {
    const sel = selectHooksForCalendar(
      { action: "rumplestiltskin" } as never,
      hooks,
    );
    expect(sel.ingress).toBe(hooks.ingress);
    expect(sel.egress).toBeUndefined();
  });
});
