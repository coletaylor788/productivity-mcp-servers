import { describe, it, expect, vi } from "vitest";

// We mock the SDK at the module boundary so the bridge under test never
// spawns a real subprocess.
const clientInstances: Array<{
  connect: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}> = [];
const transportInstances: Array<{
  close: ReturnType<typeof vi.fn>;
  ctorArgs: unknown;
}> = [];

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => {
    const inst = {
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [{ name: "ping" }] }),
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "pong" }] }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    clientInstances.push(inst);
    return inst;
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation((args: unknown) => {
    const inst = {
      close: vi.fn().mockResolvedValue(undefined),
      ctorArgs: args,
    };
    transportInstances.push(inst);
    return inst;
  }),
}));

const { McpBridge, connectMcpBridge } = await import("../src/mcp-bridge.js");

describe("McpBridge", () => {
  it("connect() spawns a stdio transport with the given command/args/cwd", async () => {
    transportInstances.length = 0;
    clientInstances.length = 0;
    const bridge = new McpBridge({
      command: "/usr/bin/python",
      args: ["-m", "gmail_mcp"],
      cwd: "/tmp",
    });
    await bridge.connect();
    expect(transportInstances).toHaveLength(1);
    expect(transportInstances[0].ctorArgs).toMatchObject({
      command: "/usr/bin/python",
      args: ["-m", "gmail_mcp"],
      cwd: "/tmp",
    });
    expect(clientInstances[0].connect).toHaveBeenCalledTimes(1);
  });

  it("connect() is idempotent", async () => {
    clientInstances.length = 0;
    const bridge = new McpBridge({ command: "x" });
    await bridge.connect();
    await bridge.connect();
    expect(clientInstances).toHaveLength(1);
  });

  it("listTools() returns tools from the underlying client", async () => {
    const bridge = await connectMcpBridge({ command: "x" });
    const tools = await bridge.listTools();
    expect(tools).toEqual([{ name: "ping" }]);
  });

  it("callTool() forwards to client.callTool with name + args", async () => {
    clientInstances.length = 0;
    const bridge = await connectMcpBridge({ command: "x" });
    await bridge.callTool("get_email", { id: "msg-1" });
    expect(clientInstances[0].callTool).toHaveBeenCalledWith({
      name: "get_email",
      arguments: { id: "msg-1" },
    });
  });

  it("listTools()/callTool() throw if connect() was never called", async () => {
    const bridge = new McpBridge({ command: "x" });
    await expect(bridge.listTools()).rejects.toThrow(/connect\(\)/);
    await expect(bridge.callTool("x", {})).rejects.toThrow(/connect\(\)/);
  });

  it("close() shuts down both client and transport", async () => {
    clientInstances.length = 0;
    transportInstances.length = 0;
    const bridge = await connectMcpBridge({ command: "x" });
    await bridge.close();
    expect(clientInstances[0].close).toHaveBeenCalled();
    expect(transportInstances[0].close).toHaveBeenCalled();
  });

  it("close() is safe to call repeatedly", async () => {
    const bridge = await connectMcpBridge({ command: "x" });
    await bridge.close();
    await expect(bridge.close()).resolves.toBeUndefined();
  });
});
