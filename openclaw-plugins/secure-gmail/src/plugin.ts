import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  CopilotLLMClient,
  InjectionGuard,
  SecretRedactor,
  type IngressHook,
} from "mcp-hooks";
import { connectMcpBridge, McpBridge } from "./mcp-bridge.js";
import { wrapMcpTool } from "./wrap-tool.js";

interface SecureGmailConfig {
  gmailMcpCommand: string;
  gmailMcpArgs?: string[];
  gmailMcpCwd?: string;
  model?: string;
  skipTools?: string[];
}

const DEFAULT_SKIP = ["authenticate", "archive_email", "add_label"];
const DEFAULT_ARGS = ["-m", "gmail_mcp"];

const secureGmailPlugin = {
  id: "secure-gmail",
  name: "Secure Gmail",
  description:
    "Wraps gmail-mcp tools with prompt-injection + secret-redaction hooks.",

  async register(api: OpenClawPluginApi) {
    const config = (api.pluginConfig ?? {}) as Partial<SecureGmailConfig>;

    if (!config.gmailMcpCommand) {
      api.logger.error?.(
        "[secure-gmail] missing required config: gmailMcpCommand",
      );
      return;
    }

    const llm = new CopilotLLMClient({
      model: config.model ?? "claude-haiku-4.5",
    });
    const ingress: IngressHook[] = [
      new InjectionGuard({ llm }),
      new SecretRedactor({ llm }),
    ];
    const skip = new Set(config.skipTools ?? DEFAULT_SKIP);

    let bridge: McpBridge;
    try {
      bridge = await connectMcpBridge({
        command: api.resolvePath(config.gmailMcpCommand),
        args: config.gmailMcpArgs ?? DEFAULT_ARGS,
        cwd: config.gmailMcpCwd
          ? api.resolvePath(config.gmailMcpCwd)
          : undefined,
      });
    } catch (err) {
      api.logger.error?.(
        `[secure-gmail] failed to spawn gmail-mcp: ${String(err)}`,
      );
      return;
    }

    let tools;
    try {
      tools = await bridge.listTools();
    } catch (err) {
      api.logger.error?.(
        `[secure-gmail] failed to list tools from gmail-mcp: ${String(err)}`,
      );
      await bridge.close();
      return;
    }

    api.logger.info?.(
      `[secure-gmail] registering ${tools.length} gmail tools (skip: ${
        [...skip].join(", ") || "<none>"
      })`,
    );

    for (const tool of tools) {
      const hooks = skip.has(tool.name) ? [] : ingress;
      api.registerTool(wrapMcpTool(tool, bridge, { ingress: hooks }));
    }

    api.on("session_end", async () => {
      await bridge.close();
    });
  },
};

export default secureGmailPlugin;
