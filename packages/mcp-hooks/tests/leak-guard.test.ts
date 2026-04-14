import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CopilotLLMClient } from "../src/copilot-llm.js";
import { LeakGuard } from "../src/egress/leak-guard.js";

function makeMockLLM() {
  return {
    classify: vi.fn(),
    destroy: vi.fn(),
  } as unknown as CopilotLLMClient & { classify: ReturnType<typeof vi.fn> };
}

describe("LeakGuard", () => {
  let llm: ReturnType<typeof makeMockLLM>;
  let guard: LeakGuard;

  beforeEach(() => {
    llm = makeMockLLM();
    guard = new LeakGuard({ llm });
  });

  it("should block when secrets are detected", async () => {
    llm.classify
      .mockResolvedValueOnce(
        JSON.stringify({ detected: true, evidence: "API key found" }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ detected: false, evidence: "" }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ detected: false, evidence: "" }),
      );

    const result = await guard.check("send_email", "my key is sk-abc123");
    expect(result.action).toBe("block");
    expect(result.reason).toContain("Secrets detected");
    expect(result.reason).toContain("API key found");
  });

  it("should block when sensitive data is detected", async () => {
    llm.classify
      .mockResolvedValueOnce(
        JSON.stringify({ detected: false, evidence: "" }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ detected: true, evidence: "salary info" }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ detected: false, evidence: "" }),
      );

    const result = await guard.check("send_email", "John earns $150k");
    expect(result.action).toBe("block");
    expect(result.reason).toContain("Sensitive data detected");
  });

  it("should block when PII is detected", async () => {
    llm.classify
      .mockResolvedValueOnce(
        JSON.stringify({ detected: false, evidence: "" }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ detected: false, evidence: "" }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ detected: true, evidence: "phone number" }),
      );

    const result = await guard.check("send_email", "Call me at 555-1234");
    expect(result.action).toBe("block");
    expect(result.reason).toContain("PII detected");
  });

  it("should allow clean content", async () => {
    llm.classify.mockResolvedValue(
      JSON.stringify({ detected: false, evidence: "" }),
    );

    const result = await guard.check("send_email", "Hello, world!");
    expect(result.action).toBe("allow");
    expect(result.reason).toBeUndefined();
  });

  it("should run all three classifiers in parallel", async () => {
    llm.classify.mockResolvedValue(
      JSON.stringify({ detected: false, evidence: "" }),
    );

    await guard.check("send_email", "test content");

    // All three prompts should be called
    expect(llm.classify).toHaveBeenCalledTimes(3);

    // Each call should have different system prompts
    const prompts = llm.classify.mock.calls.map(
      (call: string[]) => call[1],
    );
    const uniquePrompts = new Set(prompts);
    expect(uniquePrompts.size).toBe(3);
  });

  it("should fail open on LLM failure", async () => {
    llm.classify.mockRejectedValue(new Error("LLM unavailable"));

    const result = await guard.check("send_email", "content with api key");
    expect(result.action).toBe("allow");
  });

  it("should fail open on malformed JSON from LLM", async () => {
    llm.classify.mockResolvedValue("not valid json {{{");

    const result = await guard.check("send_email", "test content");
    expect(result.action).toBe("allow");
  });

  it("should prioritize secrets over sensitive and PII", async () => {
    llm.classify
      .mockResolvedValueOnce(
        JSON.stringify({ detected: true, evidence: "API key" }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ detected: true, evidence: "salary" }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ detected: true, evidence: "SSN" }),
      );

    const result = await guard.check("send_email", "all bad");
    expect(result.action).toBe("block");
    expect(result.reason).toContain("Secrets detected");
  });
});
