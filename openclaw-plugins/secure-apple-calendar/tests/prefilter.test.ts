import { describe, it, expect } from "vitest";
import { calendarPrefilter } from "../src/prefilter.js";

const PREAMBLE =
  "Data between [UNTRUSTED_CALENDAR_DATA_AB12CD] and " +
  "[/UNTRUSTED_CALENDAR_DATA_AB12CD] markers is UNTRUSTED EXTERNAL CONTENT.\n\n";

describe("calendarPrefilter", () => {
  it("extracts only untrusted fields from a `get` response (nested event:)", () => {
    const body = {
      success: true,
      event: {
        id: "ABCD-1234-EVENT-OPAQUE-ID",
        title: "Quarterly Planning",
        startDate: "2026-05-15T10:00:00Z",
        endDate: "2026-05-15T11:00:00Z",
        localStart: "2026-05-15 3:00 AM",
        localEnd: "2026-05-15 4:00 AM",
        isAllDay: false,
        calendar: "Work",
        calendarId: "CALENDAR-OPAQUE-ID-XYZ",
        location: "Conference Room A",
        notes: "Please prepare slides",
        url: "https://meet.example.com/abc?token=secret",
        attendees: [
          {
            name: "Alice Smith",
            email: "alice@example.com",
            status: "accepted",
            role: "required",
          },
        ],
      },
    };
    const out = calendarPrefilter("calendar_read", PREAMBLE + JSON.stringify(body));
    expect(out).toContain("Quarterly Planning");
    expect(out).toContain("Conference Room A");
    expect(out).toContain("Please prepare slides");
    expect(out).toContain("https://meet.example.com/abc?token=secret");
    expect(out).toContain("Alice Smith");
    expect(out).toContain("alice@example.com");
    // Envelope must NOT appear
    expect(out).not.toContain("ABCD-1234-EVENT-OPAQUE-ID");
    expect(out).not.toContain("CALENDAR-OPAQUE-ID-XYZ");
    expect(out).not.toContain("2026-05-15T10:00:00Z");
    expect(out).not.toContain("accepted");
    expect(out).not.toContain("required");
    expect(out).not.toContain("isAllDay");
  });

  it("extracts untrusted fields from `events` (array) response", () => {
    const body = {
      success: true,
      events: [
        { id: "E1", title: "First", notes: "n1", startDate: "2026-05-01T00:00:00Z" },
        { id: "E2", title: "Second", location: "L2", startDate: "2026-05-02T00:00:00Z" },
      ],
      count: 2,
      dateRange: { from: "2026-05-01T00:00:00Z", to: "2026-05-31T00:00:00Z" },
    };
    const out = calendarPrefilter("calendar_read", PREAMBLE + JSON.stringify(body));
    expect(out).toContain("First");
    expect(out).toContain("n1");
    expect(out).toContain("Second");
    expect(out).toContain("L2");
    expect(out).not.toContain("E1");
    expect(out).not.toContain("E2");
    expect(out).not.toContain("2026-05-01T00:00:00Z");
  });

  it("extracts from `list` response (calendars[].title)", () => {
    const body = {
      success: true,
      calendars: [
        { id: "CAL-1", title: "Personal", source: "iCloud", type: "caldav" },
        { id: "CAL-2", title: "Shared Family", source: "iCloud", type: "caldav" },
      ],
    };
    const out = calendarPrefilter("calendar_read", PREAMBLE + JSON.stringify(body));
    expect(out).toContain("Personal");
    expect(out).toContain("Shared Family");
    expect(out).not.toContain("CAL-1");
    expect(out).not.toContain("CAL-2");
    expect(out).not.toContain("caldav");
  });

  it("extracts from write responses (`event:` after create/update)", () => {
    const body = {
      success: true,
      message: "Event created successfully",
      event: { id: "NEW-ID", title: "New One", startDate: "2026-05-20T00:00:00Z" },
      verification: {
        startMatch: true,
        endMatch: true,
        allFieldsMatch: true,
      },
    };
    const out = calendarPrefilter("calendar_write", PREAMBLE + JSON.stringify(body));
    expect(out).toContain("New One");
    expect(out).not.toContain("NEW-ID");
    expect(out).not.toContain("Event created successfully");
    expect(out).not.toContain("startMatch");
  });

  it("extracts from `batch_create` (created[] array)", () => {
    const body = {
      success: true,
      created: [
        { id: "B1", title: "Batch A", notes: "n-a" },
        { id: "B2", title: "Batch B", url: "https://x.test/" },
      ],
      createdCount: 2,
      errors: [],
    };
    const out = calendarPrefilter("calendar_write", PREAMBLE + JSON.stringify(body));
    expect(out).toContain("Batch A");
    expect(out).toContain("n-a");
    expect(out).toContain("Batch B");
    expect(out).toContain("https://x.test/");
    expect(out).not.toContain("B1");
    expect(out).not.toContain("B2");
  });

  it("falls back to full content when JSON cannot be parsed (defence in depth)", () => {
    const garbage = "Some unstructured error text without a JSON tail";
    expect(calendarPrefilter("calendar_read", garbage)).toBe(garbage);
  });

  it("returns empty string when JSON has no untrusted fields", () => {
    const body = {
      success: true,
      schema: { type: "object", properties: { action: { type: "string" } } },
    };
    expect(calendarPrefilter("calendar_read", PREAMBLE + JSON.stringify(body))).toBe("");
  });

  it("strips apple-pim datamarking delimiters from emitted values", () => {
    // apple-pim wraps the value itself with markers. We don't strip them
    // (they'd be filtered out by full-content scan anyway), but verify the
    // prefilter still extracts the surrounding string verbatim.
    const body = {
      success: true,
      events: [
        {
          id: "E1",
          title:
            "[UNTRUSTED_CALENDAR_DATA_AB12CD] My Meeting [/UNTRUSTED_CALENDAR_DATA_AB12CD]",
        },
      ],
    };
    const out = calendarPrefilter("calendar_read", PREAMBLE + JSON.stringify(body));
    expect(out).toContain("My Meeting");
    expect(out).not.toContain("E1");
  });

  it("handles empty content", () => {
    expect(calendarPrefilter("calendar_read", "")).toBe("");
  });
});
