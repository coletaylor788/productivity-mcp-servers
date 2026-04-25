import type { AnyAgentTool } from "openclaw/plugin-sdk";
import type { IngressHook } from "mcp-hooks";
import type {
  CallToolResult,
  Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";

export interface AuditEntry {
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** MCP tool that produced the content. */
  toolName: string;
  /** Hook that produced the verdict. */
  hookName: string;
  action: "allow" | "block" | "modify";
  /** Length of the content given to the hook. */
  contentLen: number;
  /** Length of the content after modification (only for action=modify). */
  modifiedLen?: number;
  /** Categorical labels of findings, e.g. ["api_key"]. */
  findingTypes?: string[];
  findingCount?: number;
  /** Reason returned for blocks. */
  reason?: string;
  /** Short, non-sensitive evidence summary. */
  evidence?: string;
}

export type AuditLogger = (entry: AuditEntry) => void;

export interface WrapToolOptions {
  ingress?: IngressHook[];
  /**
   * Called once per hook verdict (allow / block / modify). Implementations
   * should write a structured audit record. Never receives raw content.
   */
  audit?: AuditLogger;
}

/** Minimal subset of McpBridge that wrap-tool depends on (eases testing). */
export interface McpCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

/**
 * Wrap an MCP tool descriptor as an OpenClaw `AnyAgentTool`. The returned
 * tool's `execute()` calls the MCP server, then runs ingress hooks (in
 * parallel) on the result text. Block verdicts replace the result with a
 * sentinel; modify verdicts replace the text content. Each verdict is
 * also surfaced through `opts.audit` for security audit trails.
 */
export function wrapMcpTool(
  tool: McpTool,
  bridge: McpCaller,
  opts: WrapToolOptions = {},
): AnyAgentTool {
  const ingress = opts.ingress ?? [];
  const audit = opts.audit;

  return {
    name: tool.name,
    label: tool.name,
    description: tool.description ?? "",
    parameters: (tool.inputSchema ?? {
      type: "object",
      properties: {},
    }) as never,
    async execute(_toolCallId, params) {
      const raw = await bridge.callTool(
        tool.name,
        (params ?? {}) as Record<string, unknown>,
      );

      if (ingress.length === 0) {
        return toAgentResult(raw);
      }

      const text = extractText(raw);
      const verdicts = await Promise.all(
        ingress.map((hook) => hook.check(tool.name, text)),
      );

      if (audit) {
        const ts = new Date().toISOString();
        for (let i = 0; i < verdicts.length; i++) {
          const v = verdicts[i];
          const hook = ingress[i];
          const entry: AuditEntry = {
            timestamp: ts,
            toolName: tool.name,
            hookName: hook.name,
            action: v.action,
            contentLen: text.length,
          };
          if (v.action === "modify" && typeof v.content === "string") {
            entry.modifiedLen = v.content.length;
          }
          if (v.details?.findingTypes && v.details.findingTypes.length > 0) {
            entry.findingTypes = v.details.findingTypes;
          }
          if (typeof v.details?.findingCount === "number") {
            entry.findingCount = v.details.findingCount;
          }
          if (typeof v.details?.evidence === "string") {
            entry.evidence = v.details.evidence;
          }
          if (typeof v.reason === "string") {
            entry.reason = v.reason;
          }
          try {
            audit(entry);
          } catch {
            // Auditing must never break the tool call.
          }
        }
      }

      const blocked = verdicts.find((v) => v.action === "block");
      if (blocked) {
        return blockedResult(tool.name, blocked.reason);
      }

      let current = text;
      for (const v of verdicts) {
        if (v.action === "modify" && typeof v.content === "string") {
          current = v.content;
        }
      }

      if (current === text) {
        return toAgentResult(raw);
      }

      return {
        content: [{ type: "text", text: current }],
        details: {
          source: "secure-gmail",
          modified: true,
          original: raw,
        },
      };
    },
  } as AnyAgentTool;
}

/** Concatenate all `text` blocks from an MCP CallToolResult. */
export function extractText(result: CallToolResult): string {
  if (!result?.content) return "";
  return result.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function toAgentResult(raw: CallToolResult) {
  const content = (raw.content ?? []).filter(
    (b): b is { type: "text"; text: string } | { type: "image"; data: string; mimeType: string } =>
      b.type === "text" || b.type === "image",
  );
  return {
    content: content.length > 0 ? content : [{ type: "text" as const, text: "" }],
    details: { source: "secure-gmail", isError: raw.isError === true },
  };
}

function blockedResult(toolName: string, reason: string | undefined) {
  const text = `[secure-gmail] blocked ${toolName}: ${
    reason ?? "ingress hook detected unsafe content"
  }`;
  return {
    content: [{ type: "text" as const, text }],
    details: { source: "secure-gmail", blocked: true, reason },
  };
}
