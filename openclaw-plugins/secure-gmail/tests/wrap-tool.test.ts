import { describe, it, expect, vi } from "vitest";
import { wrapMcpTool, extractText, type McpCaller } from "../src/wrap-tool.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { HookResult, IngressHook } from "mcp-hooks";

const tool: McpTool = {
  name: "get_email",
  description: "Fetch a single email by id.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
};

function makeCaller(text = "hello"): McpCaller & { callTool: ReturnType<typeof vi.fn> } {
  return {
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: "text", text }],
    }),
  };
}

function hook(result: HookResult, name = "TestHook"): IngressHook {
  return { name, check: vi.fn().mockResolvedValue(result) };
}

describe("wrapMcpTool", () => {
  it("returns an AnyAgentTool-shaped object", () => {
    const wrapped = wrapMcpTool(tool, makeCaller());
    expect(wrapped.name).toBe("get_email");
    expect(wrapped.label).toBe("get_email");
    expect(wrapped.description).toBe("Fetch a single email by id.");
    expect(typeof wrapped.execute).toBe("function");
  });

  it("calls the MCP server with the correct name and params", async () => {
    const caller = makeCaller();
    const wrapped = wrapMcpTool(tool, caller);
    await wrapped.execute("call-1", { id: "msg-42" });
    expect(caller.callTool).toHaveBeenCalledWith("get_email", { id: "msg-42" });
  });

  it("passes through MCP result when no ingress hooks are configured", async () => {
    const wrapped = wrapMcpTool(tool, makeCaller("body"), { ingress: [] });
    const result = await wrapped.execute("c", { id: "x" });
    expect(result.content).toEqual([{ type: "text", text: "body" }]);
  });

  it("runs ingress hooks in parallel via Promise.all", async () => {
    const order: string[] = [];
    const slow = hook({ action: "allow" });
    (slow.check as any).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("slow");
      return { action: "allow" } as HookResult;
    });
    const fast = hook({ action: "allow" });
    (fast.check as any).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("fast");
      return { action: "allow" } as HookResult;
    });
    const wrapped = wrapMcpTool(tool, makeCaller(), { ingress: [slow, fast] });
    await wrapped.execute("c", { id: "x" });
    // If sequential, order would be slow then fast; parallel means fast finishes first.
    expect(order).toEqual(["fast", "slow"]);
  });

  it("replaces output with a sentinel when an ingress hook blocks", async () => {
    const blocker = hook({ action: "block", reason: "prompt injection detected" });
    const allower = hook({ action: "allow" });
    const wrapped = wrapMcpTool(tool, makeCaller("evil"), {
      ingress: [allower, blocker],
    });
    const result = await wrapped.execute("c", { id: "x" });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("blocked get_email");
    expect(text).toContain("prompt injection detected");
    expect(text).not.toContain("evil");
    expect(result.details).toMatchObject({ blocked: true });
  });

  it("never reveals raw content if any hook blocks (even if another modifies)", async () => {
    const blocker = hook({ action: "block", reason: "danger" });
    const modifier = hook({ action: "modify", content: "modified" });
    const wrapped = wrapMcpTool(tool, makeCaller("raw secret"), {
      ingress: [modifier, blocker],
    });
    const result = await wrapped.execute("c", {});
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).not.toContain("raw secret");
    expect(text).not.toContain("modified");
    expect(text).toContain("blocked");
  });

  it("returns modified content when a hook returns action=modify", async () => {
    const redactor = hook({ action: "modify", content: "the code is [REDACTED]" });
    const wrapped = wrapMcpTool(tool, makeCaller("the code is 123456"), {
      ingress: [redactor],
    });
    const result = await wrapped.execute("c", {});
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toBe("the code is [REDACTED]");
    expect(result.details).toMatchObject({ modified: true });
  });

  it("composes multiple modify verdicts (last write wins)", async () => {
    const a = hook({ action: "modify", content: "first" });
    const b = hook({ action: "modify", content: "second" });
    const wrapped = wrapMcpTool(tool, makeCaller("orig"), { ingress: [a, b] });
    const result = await wrapped.execute("c", {});
    expect((result.content[0] as { type: "text"; text: string }).text).toBe(
      "second",
    );
  });

  it("passes raw result through when all hooks return allow", async () => {
    const wrapped = wrapMcpTool(tool, makeCaller("clean"), {
      ingress: [hook({ action: "allow" }), hook({ action: "allow" })],
    });
    const result = await wrapped.execute("c", {});
    expect((result.content[0] as { type: "text"; text: string }).text).toBe(
      "clean",
    );
    expect(result.details).not.toMatchObject({ blocked: true });
    expect(result.details).not.toMatchObject({ modified: true });
  });

  it("falls back to empty schema when MCP tool has no inputSchema", () => {
    const noSchema = { name: "x", description: "" } as McpTool;
    const wrapped = wrapMcpTool(noSchema, makeCaller());
    expect(wrapped.parameters).toEqual({ type: "object", properties: {} });
  });

  describe("audit logger", () => {
    it("emits one entry per hook with action and content lengths", async () => {
      const audit = vi.fn();
      const wrapped = wrapMcpTool(tool, makeCaller("hello world"), {
        ingress: [
          hook({ action: "allow" }, "InjectionGuard"),
          hook({ action: "allow" }, "SecretRedactor"),
        ],
        audit,
      });
      await wrapped.execute("c", {});
      expect(audit).toHaveBeenCalledTimes(2);
      expect(audit.mock.calls[0][0]).toMatchObject({
        toolName: tool.name,
        hookName: "InjectionGuard",
        action: "allow",
        contentLen: 11,
      });
      expect(audit.mock.calls[1][0]).toMatchObject({
        hookName: "SecretRedactor",
        action: "allow",
      });
    });

    it("includes findingTypes/findingCount when redactor reports findings", async () => {
      const audit = vi.fn();
      const wrapped = wrapMcpTool(tool, makeCaller("body"), {
        ingress: [
          hook(
            {
              action: "modify",
              content: "[REDACTED:api_key]",
              details: { findingTypes: ["api_key"], findingCount: 1 },
            },
            "SecretRedactor",
          ),
        ],
        audit,
      });
      await wrapped.execute("c", {});
      const entry = audit.mock.calls[0][0];
      expect(entry).toMatchObject({
        action: "modify",
        findingTypes: ["api_key"],
        findingCount: 1,
        contentLen: 4,
        modifiedLen: 18,
      });
    });

    it("includes reason and evidence when guard blocks", async () => {
      const audit = vi.fn();
      const wrapped = wrapMcpTool(tool, makeCaller("malicious"), {
        ingress: [
          hook(
            {
              action: "block",
              reason: "Prompt injection detected: imperative override",
              details: { evidence: "imperative override" },
            },
            "InjectionGuard",
          ),
        ],
        audit,
      });
      await wrapped.execute("c", {});
      const entry = audit.mock.calls[0][0];
      expect(entry.action).toBe("block");
      expect(entry.reason).toContain("imperative override");
      expect(entry.evidence).toBe("imperative override");
    });

    it("never propagates exceptions from the audit callback", async () => {
      const audit = vi.fn().mockImplementation(() => {
        throw new Error("disk full");
      });
      const wrapped = wrapMcpTool(tool, makeCaller("body"), {
        ingress: [hook({ action: "allow" })],
        audit,
      });
      await expect(wrapped.execute("c", {})).resolves.toBeDefined();
    });

    it("does not invoke the audit logger when no ingress hooks are configured", async () => {
      const audit = vi.fn();
      const wrapped = wrapMcpTool(tool, makeCaller("body"), {
        ingress: [],
        audit,
      });
      await wrapped.execute("c", {});
      expect(audit).not.toHaveBeenCalled();
    });
  });
});

describe("extractText", () => {
  it("concatenates all text blocks with newlines", () => {
    expect(
      extractText({
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      } as any),
    ).toBe("a\nb");
  });

  it("ignores non-text content blocks", () => {
    expect(
      extractText({
        content: [
          { type: "text", text: "keep" },
          { type: "image", data: "...", mimeType: "image/png" },
        ],
      } as any),
    ).toBe("keep");
  });

  it("returns empty string for missing or empty content", () => {
    expect(extractText({} as any)).toBe("");
    expect(extractText({ content: [] } as any)).toBe("");
  });
});
