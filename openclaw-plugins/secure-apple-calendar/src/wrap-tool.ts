import type { AnyAgentTool } from "openclaw/plugin-sdk";
import type { EgressHook, IngressHook } from "mcp-hooks";
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
  /** Which phase produced this verdict. */
  phase: "ingress" | "egress";
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

export interface HookSelection {
  /** Ingress hooks applied to the tool's result text. */
  ingress?: IngressHook[];
  /** Egress hooks applied to the args BEFORE the delegate is called. */
  egress?: EgressHook[];
  /**
   * Content handed to egress hooks. Defaults to `JSON.stringify(args)`. Use
   * this to focus the hook on a specific field (e.g., the event title +
   * notes for calendar leak checks).
   */
  egressContent?: string;
  /**
   * If true, the egress phase is skipped entirely (used for short-circuiting
   * trusted destinations).
   */
  skipEgress?: boolean;
}

export interface WrapToolOptions {
  /**
   * Decide which hooks to run for a given tool call based on its args. Called
   * fresh on every tool invocation. Return an empty selection to disable all
   * hooks for this call.
   */
  selectHooks: (args: Record<string, unknown>) => HookSelection;
  /**
   * Called once per hook verdict (allow / block / modify). Implementations
   * should write a structured audit record. Never receives raw content.
   */
  audit?: AuditLogger;
  /** String identifier for the wrapping plugin (used in sentinels and result.details). */
  source?: string;
}

/** Minimal subset of McpBridge that wrap-tool depends on (eases testing). */
export interface McpCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

/**
 * Wrap an MCP tool descriptor as an OpenClaw `AnyAgentTool`.
 *
 * Per-call flow:
 *   1. selectHooks(args) returns the egress + ingress hooks for this call.
 *   2. Egress hooks run in parallel against `egressContent` (default:
 *      `JSON.stringify(args)`). On block, return a sentinel WITHOUT calling
 *      the delegate (the whole point of egress).
 *   3. Delegate MCP tool runs.
 *   4. Ingress hooks run in parallel against the result text. Block → sentinel,
 *      modify → text replace.
 *
 * Every hook verdict (allow/block/modify) is surfaced through `opts.audit`.
 */
export function wrapMcpTool(
  tool: McpTool,
  bridge: McpCaller,
  opts: WrapToolOptions,
): AnyAgentTool {
  const audit = opts.audit;
  const source = opts.source ?? "secure-apple-calendar";

  return {
    name: tool.name,
    label: tool.name,
    description: tool.description ?? "",
    parameters: (tool.inputSchema ?? {
      type: "object",
      properties: {},
    }) as never,
    async execute(_toolCallId, params) {
      const args = (params ?? {}) as Record<string, unknown>;
      const selection = opts.selectHooks(args);

      // ---- Egress phase ----
      const egress = selection.skipEgress ? [] : selection.egress ?? [];
      if (egress.length > 0) {
        const content = selection.egressContent ?? safeStringify(args);
        const verdicts = await Promise.all(
          egress.map((hook) =>
            hook.check(tool.name, content, args).then((v) => ({
              hookName: hookCtorName(hook),
              verdict: v,
            })),
          ),
        );
        emitAudits(audit, "egress", tool.name, content.length, verdicts);

        const blocked = verdicts.find(({ verdict }) => verdict.action === "block");
        if (blocked) {
          return blockedResult(source, tool.name, "egress", blocked.verdict.reason);
        }
      }

      // ---- Delegate ----
      const raw = await bridge.callTool(tool.name, args);

      // ---- Ingress phase ----
      const ingress = selection.ingress ?? [];
      if (ingress.length === 0) {
        return toAgentResult(raw, source);
      }

      const text = extractText(raw);
      const verdicts = await Promise.all(
        ingress.map((hook) =>
          hook.check(tool.name, text).then((v) => ({
            hookName: hook.name,
            verdict: v,
          })),
        ),
      );
      emitAudits(audit, "ingress", tool.name, text.length, verdicts);

      const blocked = verdicts.find(({ verdict }) => verdict.action === "block");
      if (blocked) {
        return blockedResult(source, tool.name, "ingress", blocked.verdict.reason);
      }

      let current = text;
      for (const { verdict } of verdicts) {
        if (verdict.action === "modify" && typeof verdict.content === "string") {
          current = verdict.content;
        }
      }

      if (current === text) {
        return toAgentResult(raw, source);
      }

      return {
        content: [{ type: "text" as const, text: current }],
        details: {
          source,
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

function toAgentResult(raw: CallToolResult, source: string) {
  const content = (raw.content ?? []).filter(
    (b): b is { type: "text"; text: string } | { type: "image"; data: string; mimeType: string } =>
      b.type === "text" || b.type === "image",
  );
  return {
    content: content.length > 0 ? content : [{ type: "text" as const, text: "" }],
    details: { source, isError: raw.isError === true },
  };
}

function blockedResult(
  source: string,
  toolName: string,
  phase: "ingress" | "egress",
  reason: string | undefined,
) {
  const text = `[${source}] blocked ${toolName} (${phase}): ${
    reason ?? "hook detected unsafe content"
  }`;
  return {
    content: [{ type: "text" as const, text }],
    details: { source, blocked: true, phase, reason },
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function hookCtorName(hook: EgressHook): string {
  const ctorName = hook.constructor?.name;
  return typeof ctorName === "string" && ctorName.length > 0 ? ctorName : "EgressHook";
}

function emitAudits(
  audit: AuditLogger | undefined,
  phase: "ingress" | "egress",
  toolName: string,
  contentLen: number,
  verdicts: Array<{
    hookName: string;
    verdict: {
      action: "allow" | "block" | "modify";
      content?: string;
      reason?: string;
      details?: { findingTypes?: string[]; findingCount?: number; evidence?: string };
    };
  }>,
): void {
  if (!audit) return;
  const ts = new Date().toISOString();
  for (const { hookName, verdict } of verdicts) {
    const entry: AuditEntry = {
      timestamp: ts,
      toolName,
      hookName,
      phase,
      action: verdict.action,
      contentLen,
    };
    if (verdict.action === "modify" && typeof verdict.content === "string") {
      entry.modifiedLen = verdict.content.length;
    }
    if (verdict.details?.findingTypes && verdict.details.findingTypes.length > 0) {
      entry.findingTypes = verdict.details.findingTypes;
    }
    if (typeof verdict.details?.findingCount === "number") {
      entry.findingCount = verdict.details.findingCount;
    }
    if (typeof verdict.details?.evidence === "string") {
      entry.evidence = verdict.details.evidence;
    }
    if (typeof verdict.reason === "string") {
      entry.reason = verdict.reason;
    }
    try {
      audit(entry);
    } catch {
      // Auditing must never break the tool call.
    }
  }
}
