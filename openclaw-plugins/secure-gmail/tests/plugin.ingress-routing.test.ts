import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Mock the MCP bridge so register() doesn't try to spawn gmail-mcp.
vi.mock("../src/mcp-bridge.js", () => {
  const callTool = vi.fn(async (name: string): Promise<CallToolResult> => ({
    content: [{ type: "text", text: `RESULT_FROM_${name}` }],
  }));
  return {
    connectMcpBridge: vi.fn(async () => ({ callTool, close: vi.fn() })),
    McpBridge: class {},
  };
});

// Mock mcp-hooks so we can assert which tool calls reach the hooks.
const checkSpy = vi.fn(async (_toolName: string, text: string) => ({
  action: "modify" as const,
  content: `[REDACTED] ${text}`,
}));
vi.mock("mcp-hooks", () => {
  class FakeHook {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
    async check(toolName: string, text: string) {
      return checkSpy(toolName, text);
    }
  }
  return {
    CopilotLLMClient: class {
      constructor(_opts: unknown) {}
    },
    InjectionGuard: class extends FakeHook {
      constructor(_opts: unknown) {
        super("InjectionGuard");
      }
    },
    SecretRedactor: class extends FakeHook {
      constructor(_opts: unknown) {
        super("SecretRedactor");
      }
    },
  };
});

import secureGmailPlugin, {
  INGRESS_ENABLED_TOOLS,
  type PluginToolContext,
} from "../src/plugin.js";

interface RegisteredFactory {
  (ctx: PluginToolContext): {
    name: string;
    execute: (
      id: string,
      params: Record<string, unknown>,
    ) => Promise<{
      content: Array<{ type: string; text?: string }>;
      details?: Record<string, unknown>;
    }>;
  };
}

function makeApi(workspaceDir: string) {
  const factories: RegisteredFactory[] = [];
  const logs: string[] = [];
  const api = {
    pluginConfig: {
      gmailMcpCommand: "/bin/true",
      gmailMcpArgs: [],
      auditLogPath: join(workspaceDir, "audit.jsonl"),
    },
    logger: {
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
    },
    registerTool: (factory: unknown) => {
      factories.push(factory as RegisteredFactory);
    },
    on: vi.fn(),
  };
  return { api, factories, logs };
}

describe("secure-gmail per-tool ingress routing", () => {
  let workspaceDir: string;

  beforeEach(() => {
    checkSpy.mockClear();
    workspaceDir = mkdtempSync(join(tmpdir(), "secure-gmail-routing-"));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("INGRESS_ENABLED_TOOLS contains exactly the externally-sourced tools", () => {
    expect(new Set(INGRESS_ENABLED_TOOLS)).toEqual(
      new Set(["list_emails", "get_email"]),
    );
  });

  it("hooks run on INGRESS tools (list_emails, get_email)", async () => {
    const { api, factories } = makeApi(workspaceDir);
    secureGmailPlugin.register(api as never);

    for (const name of ["list_emails", "get_email"]) {
      const factory = factories.find((f) => f({ workspaceDir }).name === name);
      expect(factory, `missing factory for ${name}`).toBeDefined();
      const tool = factory!({ workspaceDir });
      const result = await tool.execute("call-1", { email_id: "x" });
      const text = result.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("");
      expect(text).toContain("[REDACTED]");
      expect(text).toContain(`RESULT_FROM_${name}`);
    }

    // Two hooks (InjectionGuard + SecretRedactor) × two tools = 4 calls.
    expect(checkSpy).toHaveBeenCalledTimes(4);
  });

  it("hooks do NOT run on non-INGRESS tools (get_attachments, archive_email, add_label)", async () => {
    const { api, factories } = makeApi(workspaceDir);
    secureGmailPlugin.register(api as never);

    for (const name of ["get_attachments", "archive_email", "add_label"]) {
      const factory = factories.find((f) => f({ workspaceDir }).name === name);
      expect(factory, `missing factory for ${name}`).toBeDefined();
      const tool = factory!({ workspaceDir });
      const result = await tool.execute("call-1", {
        email_id: "x",
        email_ids: ["x"],
        label: "STARRED",
      });
      const text = result.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("");
      // Raw response passed through unmodified; no [REDACTED] prefix.
      expect(text).not.toContain("[REDACTED]");
      expect(text).toContain(`RESULT_FROM_${name}`);
    }

    expect(checkSpy).not.toHaveBeenCalled();
  });
});
