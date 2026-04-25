import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import {
  CopilotLLMClient,
  InjectionGuard,
  SecretRedactor,
  type IngressHook,
} from "mcp-hooks";
import { connectMcpBridge, McpBridge } from "./mcp-bridge.js";
import { wrapMcpTool, type AuditEntry, type AuditLogger } from "./wrap-tool.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";

interface SecureGmailConfig {
  gmailMcpCommand: string;
  gmailMcpArgs?: string[];
  gmailMcpCwd?: string;
  model?: string;
  /** Override path for the audit log file. */
  auditLogPath?: string;
}

const DEFAULT_ARGS = ["-m", "gmail_mcp"];

const DEFAULT_AUDIT_LOG_PATH = `${homedir()}/.openclaw/logs/secure-gmail-audit.jsonl`;

function createAuditLogger(
  api: OpenClawPluginApi,
  filePath: string,
): AuditLogger {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
  } catch (err) {
    api.logger.warn?.(
      `[secure-gmail] could not create audit log directory ${dirname(filePath)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return (entry: AuditEntry) => {
    // Inline summary in gateway.log so audits are visible in the main stream.
    const findings =
      entry.findingTypes && entry.findingTypes.length > 0
        ? ` types=${entry.findingTypes.join(",")}`
        : "";
    api.logger.info?.(
      `[secure-gmail][audit] tool=${entry.toolName} hook=${entry.hookName} action=${entry.action} contentLen=${entry.contentLen}${findings}${
        entry.reason ? ` reason="${entry.reason}"` : ""
      }`,
    );
    try {
      appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch (err) {
      api.logger.warn?.(
        `[secure-gmail] failed to append audit entry: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };
}

/**
 * Static manifest of gmail-mcp tools we expose to agents. Kept in sync with
 * `servers/gmail-mcp/src/gmail_mcp/server.py` by hand. `authenticate` is
 * deliberately omitted — it is a user-facing OAuth flow that should never
 * be agent-driven.
 *
 * Mutating tools (`archive_email`, `add_label`) are exposed but currently
 * have no human-in-the-loop / approval gate. Ingress hooks only run on the
 * tool *response*, so destructive params are not vetted before execution.
 * Add a SendApproval-style egress hook before exposing any tool that
 * could permanently destroy user data (e.g., delete_email).
 *
 * Why static? OpenClaw's plugin loader snapshots `api.registerTool(...)`
 * calls synchronously at the end of `register()`. Spawning the gmail-mcp
 * subprocess and calling `listTools()` is async, so any `registerTool`
 * call deferred to a later tick is silently dropped.
 */
const EXPOSED_TOOLS: McpTool[] = [
  {
    name: "list_emails",
    description:
      "List emails from Gmail with optional filters. " +
      "Use 'query' for advanced Gmail search syntax.",
    inputSchema: {
      type: "object",
      properties: {
        max_results: {
          type: "integer",
          description:
            "Maximum number of emails to return (default: 10, max: 50)",
          default: 10,
        },
        label: {
          type: "string",
          description:
            "Filter by Gmail label: INBOX, SENT, DRAFTS, SPAM, TRASH, " +
            "STARRED, IMPORTANT, or custom label name",
        },
        category: {
          type: "string",
          enum: ["primary", "social", "promotions", "updates", "forums"],
          description: "Filter by Gmail category tab",
        },
        unread_only: {
          type: "boolean",
          description: "Only return unread emails",
          default: false,
        },
        query: {
          type: "string",
          description:
            "Raw Gmail search query. Examples: 'from:sender@example.com', " +
            "'subject:meeting', 'has:attachment', 'newer_than:7d'",
        },
      },
    },
  },
  {
    name: "get_email",
    description: "Get the full contents of an email by ID.",
    inputSchema: {
      type: "object",
      properties: {
        email_id: {
          type: "string",
          description: "The email ID (from list_emails)",
        },
        format: {
          type: "string",
          enum: ["full", "text_only", "html_only"],
          description: "Response format (default: full)",
          default: "full",
        },
      },
      required: ["email_id"],
    },
  },
  {
    name: "get_attachments",
    description: "Download attachments from an email.",
    inputSchema: {
      type: "object",
      properties: {
        email_id: {
          type: "string",
          description: "The email ID (from list_emails)",
        },
        filename: {
          type: "string",
          description:
            "Specific attachment filename to download " +
            "(downloads all if omitted)",
        },
        save_to: {
          type: "string",
          description: "Directory to save files (default: ~/Downloads)",
        },
      },
      required: ["email_id"],
    },
  },
  {
    name: "archive_email",
    description:
      "Archive one or more emails (remove from inbox, keep in All Mail).",
    inputSchema: {
      type: "object",
      properties: {
        email_ids: {
          type: "array",
          items: { type: "string" },
          description: "Array of email IDs to archive",
        },
      },
      required: ["email_ids"],
    },
  },
  {
    name: "add_label",
    description: "Add a label to one or more emails.",
    inputSchema: {
      type: "object",
      properties: {
        email_ids: {
          type: "array",
          items: { type: "string" },
          description: "Array of email IDs to label",
        },
        label: {
          type: "string",
          description:
            "Label name to apply (e.g., 'STARRED', 'IMPORTANT', " +
            "or a custom label name)",
        },
      },
      required: ["email_ids", "label"],
    },
  },
];

const secureGmailPlugin = {
  id: "secure-gmail",
  name: "Secure Gmail",
  description:
    "Wraps gmail-mcp tools with prompt-injection + secret-redaction hooks.",

  register(api: OpenClawPluginApi) {
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

    // Lazy MCP bridge: only spawn the gmail-mcp subprocess on first tool
    // invocation. The bridge is shared across tool calls.
    let bridgePromise: Promise<McpBridge> | null = null;
    const getBridge = (): Promise<McpBridge> => {
      if (!bridgePromise) {
        const command = config.gmailMcpCommand!;
        const cwd = config.gmailMcpCwd;
        api.logger.info?.(
          `[secure-gmail] spawning bridge: command=${command} cwd=${cwd ?? "<none>"} args=${
            JSON.stringify(config.gmailMcpArgs ?? DEFAULT_ARGS)
          }`,
        );
        bridgePromise = connectMcpBridge({
          command,
          args: config.gmailMcpArgs ?? DEFAULT_ARGS,
          cwd,
        }).catch((err) => {
          api.logger.error?.(
            `[secure-gmail] bridge connect failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          // Reset so a later invocation can retry.
          bridgePromise = null;
          throw err;
        });
      }
      return bridgePromise;
    };

    const lazyCaller = {
      callTool: async (name: string, args: Record<string, unknown>) =>
        (await getBridge()).callTool(name, args),
    };

    const auditLogPath = config.auditLogPath ?? DEFAULT_AUDIT_LOG_PATH;
    const audit = createAuditLogger(api, auditLogPath);

    api.logger.info?.(
      `[secure-gmail] registering ${EXPOSED_TOOLS.length} gmail tools (audit log: ${auditLogPath}): ${
        EXPOSED_TOOLS.map((t) => t.name).join(", ")
      }`,
    );

    for (const tool of EXPOSED_TOOLS) {
      api.registerTool(wrapMcpTool(tool, lazyCaller, { ingress, audit }));
    }

    api.on("session_end", async () => {
      if (bridgePromise) {
        const bridge = await bridgePromise.catch(() => null);
        bridgePromise = null;
        if (bridge) await bridge.close();
      }
    });
  },
};

export default secureGmailPlugin;
