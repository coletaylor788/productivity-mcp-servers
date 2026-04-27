import type {
  OpenClawPluginApi,
} from "openclaw/plugin-sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  CopilotLLMClient,
  InjectionGuard,
  SecretRedactor,
  type IngressHook,
} from "mcp-hooks";
import { connectMcpBridge, McpBridge } from "./mcp-bridge.js";
import { wrapMcpTool, type AuditEntry, type AuditLogger } from "./wrap-tool.js";
import type {
  CallToolResult,
  Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpCaller } from "./wrap-tool.js";

/**
 * Subset of OpenClaw's plugin-sdk `OpenClawPluginToolContext` we depend on.
 * Defined structurally because the type isn't re-exported from
 * `openclaw/plugin-sdk`'s public index in 2026.4.x.
 */
export interface PluginToolContext {
  workspaceDir?: string;
  agentId?: string;
}

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
 * Add a `ContactsEgressGuard` (from mcp-hooks) before exposing any tool that
 * could permanently destroy user data (e.g., delete_email) or that emits
 * content to an external recipient (e.g., send_email).
 *
 * Per-tool ingress: only tools whose response surfaces external content
 * (sender-controlled text) get ingress hooks. See INGRESS_TOOLS below.
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
    description:
      "Download attachments from an email into the calling agent's workspace " +
      "under `attachments/`. Returned paths are workspace-relative.",
    // NOTE: `save_to` is intentionally omitted from the schema. The plugin
    // forces attachments into `<callingAgent.workspaceDir>/attachments/` so
    // the agent can read what it downloaded but cannot write outside its
    // sandboxed workspace. See ATTACHMENTS_SUBDIR / wrapAttachmentsCaller.
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

/**
 * Tools whose response carries external/sender-controlled content and
 * therefore warrants ingress hooks (InjectionGuard + SecretRedactor).
 *
 * Excluded:
 *   - `get_attachments`: response is a plugin-generated path list, not
 *     attachment contents. The agent never sees the file bodies through
 *     this tool — they land on disk and are read separately.
 *   - `archive_email`, `add_label`: response is a plugin-generated success
 *     string ("Archived N email(s)."). Nothing sender-controlled to scan.
 *
 * Included:
 *   - `list_emails`: response includes subject/snippet/sender (external).
 *   - `get_email`: full email body, headers — highest injection risk.
 */
const INGRESS_TOOLS = new Set(["list_emails", "get_email"]);

/** Exported for tests. */
export const INGRESS_ENABLED_TOOLS: ReadonlySet<string> = INGRESS_TOOLS;

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
        EXPOSED_TOOLS.map(
          (t) => `${t.name}${INGRESS_TOOLS.has(t.name) ? "*" : ""}`,
        ).join(", ")
      } (* = ingress hooks enabled)`,
    );

    for (const tool of EXPOSED_TOOLS) {
      const toolIngress = INGRESS_TOOLS.has(tool.name) ? ingress : [];
      // Factory form: OpenClaw invokes this per calling agent and provides
      // that agent's resolved context (incl. workspaceDir). Each agent gets
      // its own bound tool instance — that lets get_attachments scope writes
      // to the caller's workspace without trusting tool-arg paths.
      api.registerTool((ctx: PluginToolContext) => {
        const caller =
          tool.name === "get_attachments"
            ? wrapAttachmentsCaller(lazyCaller, ctx, api)
            : lazyCaller;
        return wrapMcpTool(tool, caller, { ingress: toolIngress, audit });
      });
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

/** Subdirectory inside each agent's workspace where attachments land. */
export const ATTACHMENTS_SUBDIR = "attachments";

/**
 * Returns an McpCaller that, for the wrapped tool, forces `save_to` to
 * `<ctx.workspaceDir>/attachments/` and rewrites the returned paths to be
 * workspace-relative (e.g. `attachments/foo.pdf`). Fails closed if the
 * calling agent has no workspaceDir.
 */
export function wrapAttachmentsCaller(
  inner: McpCaller,
  ctx: PluginToolContext,
  api?: Pick<OpenClawPluginApi, "logger">,
): McpCaller {
  return {
    async callTool(
      name: string,
      args: Record<string, unknown>,
    ): Promise<CallToolResult> {
      if (!ctx.workspaceDir) {
        const msg =
          "[secure-gmail] get_attachments unavailable: calling agent has no workspaceDir";
        api?.logger?.warn?.(msg);
        return {
          content: [{ type: "text", text: msg }],
          isError: true,
        };
      }

      const attachmentsDir = join(ctx.workspaceDir, ATTACHMENTS_SUBDIR);
      try {
        mkdirSync(attachmentsDir, { recursive: true });
      } catch (err) {
        const msg = `[secure-gmail] could not create attachments dir ${attachmentsDir}: ${
          err instanceof Error ? err.message : String(err)
        }`;
        api?.logger?.warn?.(msg);
        return { content: [{ type: "text", text: msg }], isError: true };
      }

      // Strip any caller-supplied save_to defensively (schema already hides
      // it, but a misbehaving client could still send it). Force our path.
      const { save_to: _ignored, ...rest } = args as { save_to?: unknown } & Record<
        string,
        unknown
      >;
      const result = await inner.callTool(name, {
        ...rest,
        save_to: attachmentsDir,
      });

      return rewriteAttachmentPaths(result, ctx.workspaceDir);
    },
  };
}

/**
 * Replace absolute host paths under `workspaceDir` with workspace-relative
 * paths in every text block of the result. Inside the sandbox the workspace
 * is bind-mounted at `/home/sandbox/`, so a relative path like
 * `attachments/foo.pdf` works for both bind-mount layouts.
 */
export function rewriteAttachmentPaths(
  result: CallToolResult,
  workspaceDir: string,
): CallToolResult {
  if (!result?.content) return result;
  return {
    ...result,
    content: result.content.map((block) => {
      if (block.type !== "text" || typeof block.text !== "string") return block;
      const parts = block.text.split(workspaceDir);
      if (parts.length === 1) return block;
      // Join parts back together, stripping the leading path separator that
      // followed each occurrence of workspaceDir so we emit clean relative
      // paths like `attachments/foo.pdf` rather than `/attachments/foo.pdf`.
      const rewritten = parts.reduce((acc, p, i) => {
        if (i === 0) return p;
        const stripped =
          p.startsWith("/") || p.startsWith("\\") ? p.slice(1) : p;
        return acc + stripped;
      }, "");
      return { ...block, text: rewritten };
    }),
  };
}
