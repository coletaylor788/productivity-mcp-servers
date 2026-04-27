import { describe, it, expect, vi, afterEach } from "vitest";
import { classifyBoolean } from "../src/classify.js";
import type { CopilotLLMClient } from "../src/copilot-llm.js";

function fakeLLM(impl: (content: string, prompt: string) => Promise<string>): CopilotLLMClient {
  return { classify: vi.fn(impl) } as unknown as CopilotLLMClient;
}

describe("classifyBoolean labels", () => {
  afterEach(() => vi.restoreAllMocks());

  it("forwards label to llm.classify and emits classify_done with outcome", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as never);

    const llm = fakeLLM(async () => '{"detected":true,"evidence":"e"}');
    const result = await classifyBoolean(llm, "x", "p", "leak.secrets");
    expect(result.outcome).toBe("ok");
    expect(result.detected).toBe(true);

    const classifyMock = (llm.classify as unknown as ReturnType<typeof vi.fn>).mock;
    expect(classifyMock.calls[0]![2]).toEqual({ label: "leak.secrets" });

    const doneLine = writes.find((l) => l.includes("classify_done"));
    expect(doneLine).toBeDefined();
    expect(doneLine).toContain('"label":"leak.secrets"');
    expect(doneLine).toContain('"outcome":"ok"');
  });

  it("logs api_error when llm throws", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as never);

    const llm = fakeLLM(async () => {
      throw new Error("boom");
    });
    const result = await classifyBoolean(llm, "x", "p", "injection");
    expect(result.outcome).toBe("api_error");
    expect(result.detected).toBe(false);

    const doneLine = writes.find((l) => l.includes("classify_done"));
    expect(doneLine).toContain('"label":"injection"');
    expect(doneLine).toContain('"outcome":"api_error"');
  });

  it("defaults label to 'unlabeled'", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as never);

    const llm = fakeLLM(async () => '{"detected":false,"evidence":""}');
    await classifyBoolean(llm, "x", "p");

    const startLine = writes.find((l) => l.includes("classify_start"));
    expect(startLine).toContain('"label":"unlabeled"');
  });
});
