import { describe, it, expect, vi } from "vitest";
import { wrapMcpTool, extractText, type McpCaller } from "../src/wrap-tool.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { EgressHook, HookResult, IngressHook } from "mcp-hooks";

const tool: McpTool = {
  name: "calendar",
  description: "Apple calendar operations.",
  inputSchema: {
    type: "object",
    properties: { action: { type: "string" } },
    required: ["action"],
  },
};

function makeCaller(text = "hello"): McpCaller & { callTool: ReturnType<typeof vi.fn> } {
  return {
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: "text", text }],
    }),
  };
}

function ingressHook(result: HookResult, name = "TestIngress"): IngressHook {
  return { name, check: vi.fn().mockResolvedValue(result) };
}

class TestEgress implements EgressHook {
  constructor(private result: HookResult) {}
  check = vi.fn(async () => this.result);
}

describe("wrapMcpTool", () => {
  it("returns an AnyAgentTool-shaped object", () => {
    const wrapped = wrapMcpTool(tool, makeCaller(), { selectHooks: () => ({}) });
    expect(wrapped.name).toBe("calendar");
    expect(wrapped.label).toBe("calendar");
    expect(wrapped.description).toBe("Apple calendar operations.");
    expect(typeof wrapped.execute).toBe("function");
  });

  it("calls the MCP server with the correct args when no hooks block", async () => {
    const caller = makeCaller();
    const wrapped = wrapMcpTool(tool, caller, { selectHooks: () => ({}) });
    await wrapped.execute("call-1", { action: "events", from: "2026-01-01" });
    expect(caller.callTool).toHaveBeenCalledWith("calendar", {
      action: "events",
      from: "2026-01-01",
    });
  });

  it("passes through MCP result when selectHooks returns nothing", async () => {
    const wrapped = wrapMcpTool(tool, makeCaller("body"), { selectHooks: () => ({}) });
    const result = await wrapped.execute("c", { action: "list" });
    expect(result.content).toEqual([{ type: "text", text: "body" }]);
  });

  it("runs ingress hooks in parallel via Promise.all", async () => {
    const order: string[] = [];
    const slow = ingressHook({ action: "allow" }, "Slow");
    (slow.check as any).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("slow");
      return { action: "allow" } as HookResult;
    });
    const fast = ingressHook({ action: "allow" }, "Fast");
    (fast.check as any).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("fast");
      return { action: "allow" } as HookResult;
    });
    const wrapped = wrapMcpTool(tool, makeCaller(), {
      selectHooks: () => ({ ingress: [slow, fast] }),
    });
    await wrapped.execute("c", { action: "events" });
    expect(order).toEqual(["fast", "slow"]);
  });

  it("ingress block returns sentinel and includes the reason", async () => {
    const block = ingressHook({ action: "block", reason: "injection detected" });
    const wrapped = wrapMcpTool(tool, makeCaller("bad"), {
      selectHooks: () => ({ ingress: [block] }),
    });
    const result = await wrapped.execute("c", { action: "events" });
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain(
      "[secure-apple-calendar] blocked calendar (ingress)",
    );
    expect((result.content[0] as { text: string }).text).toContain("injection detected");
  });

  it("ingress modify replaces the text content", async () => {
    const modify = ingressHook({
      action: "modify",
      content: "REDACTED",
    });
    const wrapped = wrapMcpTool(tool, makeCaller("orig"), {
      selectHooks: () => ({ ingress: [modify] }),
    });
    const result = await wrapped.execute("c", { action: "events" });
    expect((result.content[0] as { text: string }).text).toBe("REDACTED");
    expect(result.details).toMatchObject({ modified: true });
  });

  it("egress block does NOT call the delegate (the whole point of egress)", async () => {
    const caller = makeCaller();
    const block = new TestEgress({
      action: "block",
      reason: "Unknown destination",
    });
    const wrapped = wrapMcpTool(tool, caller, {
      selectHooks: () => ({ egress: [block], egressContent: "title: x" }),
    });
    const result = await wrapped.execute("c", {
      action: "create",
      title: "x",
      attendees: [{ email: "a@x.com" }],
    });
    expect(caller.callTool).not.toHaveBeenCalled();
    expect((result.content[0] as { text: string }).text).toContain(
      "[secure-apple-calendar] blocked calendar (egress)",
    );
    expect((result.content[0] as { text: string }).text).toContain("Unknown destination");
  });

  it("egress allow then ingress allow proceeds normally", async () => {
    const caller = makeCaller("calendar result");
    const allowEgress = new TestEgress({
      action: "allow",
    } as HookResult);
    const wrapped = wrapMcpTool(tool, caller, {
      selectHooks: () => ({
        egress: [allowEgress],
        egressContent: "title: x",
        ingress: [ingressHook({ action: "allow" })],
      }),
    });
    const result = await wrapped.execute("c", {
      action: "create",
      title: "x",
      attendees: [{ email: "a@x.com" }],
    });
    expect(allowEgress.check).toHaveBeenCalledWith(
      "calendar",
      "title: x",
      expect.objectContaining({ action: "create" }),
    );
    expect(caller.callTool).toHaveBeenCalledOnce();
    expect((result.content[0] as { text: string }).text).toBe("calendar result");
  });

  it("audit logger receives one entry per hook verdict with phase tag", async () => {
    const audits: any[] = [];
    const block = new TestEgress({
      action: "block",
      reason: "leak",
    } as HookResult);
    const wrapped = wrapMcpTool(tool, makeCaller(), {
      selectHooks: () => ({ egress: [block] }),
      audit: (e) => audits.push(e),
    });
    await wrapped.execute("c", { action: "create", title: "secret pwd" });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      toolName: "calendar",
      phase: "egress",
      action: "block",
      hookName: "TestEgress",
      reason: "leak",
    });
  });

  it("skipEgress=true bypasses egress hooks entirely", async () => {
    const caller = makeCaller("ok");
    const block = new TestEgress({
      action: "block",
      reason: "should not run",
    });
    const wrapped = wrapMcpTool(tool, caller, {
      selectHooks: () => ({ egress: [block], skipEgress: true }),
    });
    await wrapped.execute("c", { action: "create" });
    expect(block.check).not.toHaveBeenCalled();
    expect(caller.callTool).toHaveBeenCalledOnce();
  });
});

describe("extractText", () => {
  it("concatenates text blocks and skips non-text blocks", () => {
    expect(
      extractText({
        content: [
          { type: "text", text: "a" },
          { type: "image", data: "...", mimeType: "image/png" } as never,
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("a\nb");
  });

  it("returns empty string for missing content", () => {
    expect(extractText({} as never)).toBe("");
  });
});
