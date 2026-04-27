import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("keytar", () => ({
  default: { getPassword: vi.fn() },
}));

vi.mock("openai", () => {
  const MockOpenAI = vi.fn();
  return { default: MockOpenAI };
});

import { CopilotLLMClient } from "../src/copilot-llm.js";

function mockTokenFetch() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        token: "tok",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
  });
}

describe("CopilotLLMClient timeout/abort", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("aborts a hung chat completion within requestTimeoutMs", async () => {
    globalThis.fetch = mockTokenFetch();

    const { default: OpenAI } = await import("openai");

    // Simulate the OpenAI SDK honoring AbortSignal: reject when signal aborts.
    const mockCreate = vi.fn(
      (_body: unknown, opts?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => {
            const err = new Error("Request was aborted.");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );
    vi.mocked(OpenAI).mockImplementation(
      () => ({ chat: { completions: { create: mockCreate } } }) as any,
    );

    const client = new CopilotLLMClient({
      githubToken: "ghp_test",
      requestTimeoutMs: 50,
    });

    const start = Date.now();
    await expect(client.classify("hi", "sys", { label: "test" })).rejects.toThrow();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    // SDK options should include timeout + maxRetries:0 + signal
    const callOpts = mockCreate.mock.calls[0]![1] as {
      signal?: AbortSignal;
      timeout?: number;
      maxRetries?: number;
    };
    expect(callOpts.maxRetries).toBe(0);
    expect(callOpts.timeout).toBe(50);
    expect(callOpts.signal).toBeInstanceOf(AbortSignal);

    client.destroy();
  });

  it("passes label through chat completion options (via classify)", async () => {
    globalThis.fetch = mockTokenFetch();
    const { default: OpenAI } = await import("openai");
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '{"detected":false,"evidence":""}' } }],
    });
    vi.mocked(OpenAI).mockImplementation(
      () => ({ chat: { completions: { create: mockCreate } } }) as any,
    );

    const client = new CopilotLLMClient({ githubToken: "ghp_test" });
    const stderrWrites: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((chunk: string | Uint8Array) => {
        stderrWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
        return true;
      }) as never);

    await client.classify("hi", "sys", { label: "leak.secrets" });

    const startLine = stderrWrites.find((l) => l.includes("llm_call_start"));
    const doneLine = stderrWrites.find((l) => l.includes("llm_call_done"));
    expect(startLine).toBeDefined();
    expect(doneLine).toBeDefined();
    expect(startLine).toContain('"label":"leak.secrets"');
    expect(doneLine).toContain('"outcome":"ok"');

    spy.mockRestore();
    client.destroy();
  });
});
