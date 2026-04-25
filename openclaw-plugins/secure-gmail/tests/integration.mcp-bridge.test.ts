/**
 * Integration test: spawn the real gmail-mcp subprocess via stdio and
 * verify our McpBridge can complete the MCP handshake + listTools call.
 *
 * Catches SDK version mismatches, transport wiring bugs, and Python venv
 * issues. Does NOT require Gmail OAuth — gmail-mcp's listTools handler
 * does not touch Google APIs.
 *
 * Skipped automatically if the gmail-mcp venv isn't present.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { connectMcpBridge } from "../src/mcp-bridge.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const gmailMcpVenv = resolve(repoRoot, "servers/gmail-mcp/.venv/bin/python");
const gmailMcpCwd = resolve(repoRoot, "servers/gmail-mcp");

const hasVenv = existsSync(gmailMcpVenv);
const describeIfVenv = hasVenv ? describe : describe.skip;

describeIfVenv("integration: real gmail-mcp via stdio", () => {
  it("connects, lists tools, and disconnects cleanly", async () => {
    const bridge = await connectMcpBridge({
      command: gmailMcpVenv,
      args: ["-m", "gmail_mcp"],
      cwd: gmailMcpCwd,
    });
    try {
      const tools = await bridge.listTools();
      const names = tools.map((t) => t.name).sort();

      // Sanity: gmail-mcp exposes a stable surface. Don't pin the exact
      // list (it may grow), but assert the core tools exist.
      expect(names).toContain("authenticate");
      expect(names).toContain("list_emails");
      expect(names).toContain("get_email");
      expect(names.length).toBeGreaterThanOrEqual(4);

      // Each tool must have an inputSchema we can pass through to OpenClaw.
      for (const t of tools) {
        expect(t.inputSchema).toBeDefined();
        expect(typeof t.inputSchema).toBe("object");
      }
    } finally {
      await bridge.close();
    }
  }, 30_000);

  it("returns isError=true when calling a non-existent tool", async () => {
    const bridge = await connectMcpBridge({
      command: gmailMcpVenv,
      args: ["-m", "gmail_mcp"],
      cwd: gmailMcpCwd,
    });
    try {
      // MCP spec: server-side errors are returned in the result with
      // isError=true rather than thrown as protocol errors.
      const result = await bridge.callTool("definitely_does_not_exist", {});
      expect(result.isError).toBe(true);
    } finally {
      await bridge.close();
    }
  }, 30_000);
});
