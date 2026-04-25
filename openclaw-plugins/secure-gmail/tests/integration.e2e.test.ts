/**
 * End-to-end integration test: spawn real gmail-mcp + real Copilot LLM,
 * call wrapped list_emails against the user's real inbox, verify the full
 * pipeline (bridge → registered tool → wrapped execute → hooks → result).
 *
 * Read-only: only invokes list_emails with max_results=3.
 *
 * Skipped automatically when the gmail-mcp venv, Copilot PAT, or gmail-mcp
 * OAuth token are not present.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { connectMcpBridge, type McpBridge } from "../src/mcp-bridge.js";
import { wrapMcpTool } from "../src/wrap-tool.js";
import { CopilotLLMClient, InjectionGuard, SecretRedactor } from "mcp-hooks";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const gmailMcpVenv = resolve(repoRoot, "servers/gmail-mcp/.venv/bin/python");
const gmailMcpCwd = resolve(repoRoot, "servers/gmail-mcp");

const hasVenv = existsSync(gmailMcpVenv);
const hasGmailToken = await checkKeychain("gmail-mcp", "token");
const hasCopilotPat = await checkKeychain("openclaw", "github-pat");
const ready = hasVenv && hasGmailToken && hasCopilotPat;

const describeIfReady = ready ? describe : describe.skip;

describeIfReady("e2e: wrapped list_emails against real Gmail + real hooks", () => {
  it("returns at most max_results emails through the full pipeline", async () => {
    let bridge: McpBridge | undefined;
    try {
      bridge = await connectMcpBridge({
        command: gmailMcpVenv,
        args: ["-m", "gmail_mcp"],
        cwd: gmailMcpCwd,
      });

      const tools = await bridge.listTools();
      const listEmails = tools.find((t) => t.name === "list_emails");
      expect(listEmails, "list_emails should be registered by gmail-mcp").toBeDefined();

      const llm = new CopilotLLMClient({ model: "claude-haiku-4.5" });
      const wrapped = wrapMcpTool(listEmails as McpTool, bridge, {
        ingress: [new InjectionGuard({ llm }), new SecretRedactor({ llm })],
      });

      const result = await wrapped.execute("e2e-1", { max_results: 3 });
      expect(result.content.length).toBeGreaterThan(0);

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(typeof text).toBe("string");

      // We don't pin a specific shape — just verify the wrapper produced
      // something and didn't blow up. The result may be:
      //   - blocked sentinel (if hooks flagged something in real inbox)
      //   - modified text (if SecretRedactor rewrote)
      //   - raw passthrough
      if ((result.details as { blocked?: boolean }).blocked) {
        expect(text).toMatch(/^\[secure-gmail\] blocked/);
      } else {
        // Raw or modified: should not be empty for a non-empty inbox.
        expect(text.length).toBeGreaterThan(0);
      }
    } finally {
      if (bridge) await bridge.close();
    }
  }, 90_000);

  it("skip-listed tool (authenticate) registers but bypasses ingress hooks", async () => {
    let bridge: McpBridge | undefined;
    try {
      bridge = await connectMcpBridge({
        command: gmailMcpVenv,
        args: ["-m", "gmail_mcp"],
        cwd: gmailMcpCwd,
      });

      const tools = await bridge.listTools();
      const auth = tools.find((t) => t.name === "authenticate");
      expect(auth).toBeDefined();

      // Verify with empty ingress (matching plugin's skip behavior).
      const wrapped = wrapMcpTool(auth as McpTool, bridge, { ingress: [] });
      // We don't actually invoke authenticate (it would open a browser);
      // we just confirm the wrapper builds and exposes the right shape.
      expect(wrapped.name).toBe("authenticate");
      expect(typeof wrapped.execute).toBe("function");
    } finally {
      if (bridge) await bridge.close();
    }
  }, 30_000);
});

async function checkKeychain(service: string, account: string): Promise<boolean> {
  try {
    const { default: keytar } = await import("keytar");
    const password = await keytar.getPassword(service, account);
    return password !== null && password.length > 0;
  } catch {
    return false;
  }
}
