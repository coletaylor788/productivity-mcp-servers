import { describe, it, expect, vi } from "vitest";
import secureAppleCalendarPlugin from "../src/plugin.js";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * End-to-end style test that exercises the plugin's `register()` against
 * a stub OpenClawPluginApi. We capture the registered tools and drive their
 * `execute()` directly to verify the read/write split behaviour.
 *
 * The MCP bridge is mocked at the spawn layer via the connectMcpBridge
 * import — but `register()` doesn't spawn it eagerly (lazy bridge), so we
 * stub by intercepting the first tool call's args via a fake bridge that
 * we inject. The lazy bridge only spawns on the first call, so by failing
 * the spawn we confirm rejected calls never reach the bridge.
 *
 * To avoid mocking node-spawn, we go a step further: we make the lazy
 * bridge-connect throw, then verify rejected calls return their gating
 * error WITHOUT triggering the throw.
 */

vi.mock("../src/mcp-bridge.js", () => ({
  connectMcpBridge: vi.fn(async () => {
    throw new Error("BRIDGE-SHOULD-NOT-BE-SPAWNED");
  }),
  McpBridge: class {},
}));

// Hooks make real LLM calls in normal use. Mock CopilotLLMClient and the
// hook constructors to be no-ops so we test ONLY the registration/gating
// surface.
vi.mock("mcp-hooks", async () => {
  const actual = await vi.importActual<typeof import("mcp-hooks")>("mcp-hooks");
  return {
    ...actual,
    CopilotLLMClient: class {
      constructor(_opts: unknown) {}
    },
    InjectionGuard: class {
      name = "InjectionGuard";
      async check() {
        return { action: "allow" as const };
      }
    },
    SecretRedactor: class {
      name = "SecretRedactor";
      async check() {
        return { action: "allow" as const };
      }
    },
    SendApproval: class {
      name = "SendApproval";
      async check() {
        return { action: "allow" as const };
      }
    },
  };
});

function makeStubApi(
  config: Record<string, unknown>,
): OpenClawPluginApi & { tools: AnyAgentTool[] } {
  const tools: AnyAgentTool[] = [];
  const api = {
    pluginConfig: config,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerTool: (tool: AnyAgentTool) => {
      tools.push(tool);
    },
    on: vi.fn(),
  } as unknown as OpenClawPluginApi & { tools: AnyAgentTool[] };
  (api as { tools: AnyAgentTool[] }).tools = tools;
  return api;
}

describe("secure-apple-calendar plugin: read/write split", () => {
  function loadPlugin(): { api: ReturnType<typeof makeStubApi> } {
    const api = makeStubApi({
      applePimMcpCommand: "node",
      applePimMcpArgs: ["/dev/null"],
      auditLogPath: "/tmp/secure-apple-calendar-test.jsonl",
    });
    secureAppleCalendarPlugin.register(api);
    return { api };
  }

  it("registers exactly two tools: calendar_read and calendar_write", () => {
    const { api } = loadPlugin();
    const names = api.tools.map((t) => t.name);
    expect(names).toEqual(["calendar_read", "calendar_write"]);
  });

  it("calendar_read advertises only read actions in its schema", () => {
    const { api } = loadPlugin();
    const read = api.tools.find((t) => t.name === "calendar_read")!;
    const schema = read.parameters as {
      properties: { action: { enum: string[] } };
    };
    expect(schema.properties.action.enum).toEqual([
      "list",
      "events",
      "get",
      "search",
      "schema",
    ]);
  });

  it("calendar_write advertises only write actions in its schema", () => {
    const { api } = loadPlugin();
    const write = api.tools.find((t) => t.name === "calendar_write")!;
    const schema = write.parameters as {
      properties: { action: { enum: string[] } };
    };
    expect(schema.properties.action.enum).toEqual([
      "create",
      "update",
      "delete",
      "batch_create",
    ]);
  });

  it("calendar_read rejects mutating actions WITHOUT spawning the bridge", async () => {
    const { api } = loadPlugin();
    const read = api.tools.find((t) => t.name === "calendar_read")!;

    const result = (await read.execute("c1", {
      action: "create",
      title: "x",
    })) as CallToolResult & { details?: { isError?: boolean } };

    expect(result.details?.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/calendar_read does not allow action="create"/);
    expect(api.logger.warn).toHaveBeenCalled();
  });

  it("calendar_write rejects read actions WITHOUT spawning the bridge", async () => {
    const { api } = loadPlugin();
    const write = api.tools.find((t) => t.name === "calendar_write")!;

    const result = (await write.execute("c1", {
      action: "events",
      from: "2026-01-01",
    })) as CallToolResult & { details?: { isError?: boolean } };

    expect(result.details?.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/calendar_write does not allow action="events"/);
  });

  it("calendar_read rejects unknown actions", async () => {
    const { api } = loadPlugin();
    const read = api.tools.find((t) => t.name === "calendar_read")!;

    const result = (await read.execute("c1", {
      action: "exfiltrate",
    })) as CallToolResult & { details?: { isError?: boolean } };

    expect(result.details?.isError).toBe(true);
  });

  it("calendar_read forwards in-set actions through the bridge as 'calendar'", async () => {
    // Override the mock so the bridge succeeds and records what it received.
    const { connectMcpBridge } = await import("../src/mcp-bridge.js");
    const recordedCalls: Array<{ name: string; args: unknown }> = [];
    (connectMcpBridge as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      callTool: async (name: string, args: Record<string, unknown>) => {
        recordedCalls.push({ name, args });
        return { content: [{ type: "text", text: "ok" }] } as CallToolResult;
      },
      close: async () => {},
    });

    const { api } = loadPlugin();
    const read = api.tools.find((t) => t.name === "calendar_read")!;

    const result = (await read.execute("c1", {
      action: "events",
      from: "2026-01-01",
    })) as CallToolResult & { details?: { isError?: boolean } };

    expect(result.details?.isError).toBeFalsy();
    expect(recordedCalls).toHaveLength(1);
    // The OpenClaw-facing name is calendar_read but the underlying MCP tool
    // is always "calendar".
    expect(recordedCalls[0].name).toBe("calendar");
    expect(recordedCalls[0].args).toMatchObject({
      action: "events",
      from: "2026-01-01",
    });
  });

  it("calendar_write forwards in-set actions through the bridge as 'calendar'", async () => {
    const { connectMcpBridge } = await import("../src/mcp-bridge.js");
    const recordedCalls: Array<{ name: string; args: unknown }> = [];
    (connectMcpBridge as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      callTool: async (name: string, args: Record<string, unknown>) => {
        recordedCalls.push({ name, args });
        return { content: [{ type: "text", text: "created" }] } as CallToolResult;
      },
      close: async () => {},
    });

    const { api } = loadPlugin();
    const write = api.tools.find((t) => t.name === "calendar_write")!;

    const result = (await write.execute("c1", {
      action: "create",
      title: "Test event",
    })) as CallToolResult & { details?: { isError?: boolean } };

    expect(result.details?.isError).toBeFalsy();
    expect(recordedCalls).toHaveLength(1);
    expect(recordedCalls[0].name).toBe("calendar");
  });
});
