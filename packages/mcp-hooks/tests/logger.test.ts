import { describe, it, expect, vi, afterEach } from "vitest";
import { log, sanitize } from "../src/logger.js";

describe("logger.sanitize", () => {
  it("redacts sensitive keys regardless of value", () => {
    const out = sanitize({
      token: "abc123",
      api_key: "k",
      Authorization: "Bearer xyz",
      cookie: "session=...",
      label: "ok",
    });
    expect(out.token).toBe("<redacted>");
    expect(out.api_key).toBe("<redacted>");
    expect(out.Authorization).toBe("<redacted>");
    expect(out.cookie).toBe("<redacted>");
    expect(out.label).toBe("ok");
  });

  it("truncates long string values", () => {
    const long = "a".repeat(500);
    const out = sanitize({ raw: long });
    expect(typeof out.raw).toBe("string");
    expect((out.raw as string).length).toBeLessThan(500);
    expect(out.raw).toContain("…(+300)");
  });

  it("passes numbers, booleans, and short strings unchanged", () => {
    const out = sanitize({ elapsed_ms: 42, ok: true, label: "x" });
    expect(out).toEqual({ elapsed_ms: 42, ok: true, label: "x" });
  });
});

describe("logger.log", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes one JSON line to stderr with ts/src/event fields", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as never);

    log("test_event", { label: "demo", elapsed_ms: 12 });

    expect(writes).toHaveLength(1);
    const line = writes[0]!;
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line);
    expect(parsed.event).toBe("test_event");
    expect(parsed.src).toBe("mcp-hooks");
    expect(parsed.label).toBe("demo");
    expect(parsed.elapsed_ms).toBe(12);
    expect(typeof parsed.ts).toBe("string");
  });

  it("never throws even if stderr write fails", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => {
      throw new Error("nope");
    });
    expect(() => log("x")).not.toThrow();
  });
});
