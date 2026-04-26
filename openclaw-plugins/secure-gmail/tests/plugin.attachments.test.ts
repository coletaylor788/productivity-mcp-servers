import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  wrapAttachmentsCaller,
  rewriteAttachmentPaths,
  ATTACHMENTS_SUBDIR,
} from "../src/plugin.js";
import type { McpCaller } from "../src/wrap-tool.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function makeCaller(result: CallToolResult): McpCaller & { callTool: ReturnType<typeof vi.fn> } {
  return { callTool: vi.fn().mockResolvedValue(result) };
}

const successResult = (workspaceDir: string): CallToolResult => ({
  content: [
    {
      type: "text",
      text:
        `Downloaded 2 attachment(s):\n` +
        `  - ${workspaceDir}/${ATTACHMENTS_SUBDIR}/invoice.pdf\n` +
        `  - ${workspaceDir}/${ATTACHMENTS_SUBDIR}/photo.jpg`,
    },
  ],
});

describe("wrapAttachmentsCaller", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "secure-gmail-test-"));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("forces save_to to <workspaceDir>/attachments and creates the dir", async () => {
    const inner = makeCaller(successResult(workspaceDir));
    const wrapped = wrapAttachmentsCaller(inner, { workspaceDir });

    await wrapped.callTool("get_attachments", { email_id: "abc" });

    expect(inner.callTool).toHaveBeenCalledWith("get_attachments", {
      email_id: "abc",
      save_to: join(workspaceDir, ATTACHMENTS_SUBDIR),
    });
    expect(existsSync(join(workspaceDir, ATTACHMENTS_SUBDIR))).toBe(true);
  });

  it("strips any caller-supplied save_to before forwarding", async () => {
    const inner = makeCaller(successResult(workspaceDir));
    const wrapped = wrapAttachmentsCaller(inner, { workspaceDir });

    await wrapped.callTool("get_attachments", {
      email_id: "abc",
      save_to: "/Users/puddles/.ssh",
    });

    const args = inner.callTool.mock.calls[0][1] as Record<string, unknown>;
    expect(args.save_to).toBe(join(workspaceDir, ATTACHMENTS_SUBDIR));
    expect(args.save_to).not.toBe("/Users/puddles/.ssh");
  });

  it("rewrites returned host paths to workspace-relative paths", async () => {
    const inner = makeCaller(successResult(workspaceDir));
    const wrapped = wrapAttachmentsCaller(inner, { workspaceDir });

    const result = await wrapped.callTool("get_attachments", { email_id: "abc" });
    const text = (result.content[0] as { type: "text"; text: string }).text;

    expect(text).toContain(`${ATTACHMENTS_SUBDIR}/invoice.pdf`);
    expect(text).toContain(`${ATTACHMENTS_SUBDIR}/photo.jpg`);
    expect(text).not.toContain(workspaceDir);
  });

  it("fails closed when workspaceDir is missing", async () => {
    const inner = makeCaller(successResult(workspaceDir));
    const wrapped = wrapAttachmentsCaller(inner, {});

    const result = await wrapped.callTool("get_attachments", { email_id: "abc" });

    expect(inner.callTool).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toMatch(/no workspaceDir/i);
  });
});

describe("rewriteAttachmentPaths", () => {
  it("is a no-op for results without text blocks", () => {
    const result: CallToolResult = { content: [] };
    expect(rewriteAttachmentPaths(result, "/ws")).toEqual(result);
  });

  it("leaves text untouched when workspaceDir does not appear", () => {
    const result: CallToolResult = {
      content: [{ type: "text", text: "no attachments" }],
    };
    expect(rewriteAttachmentPaths(result, "/ws")).toEqual(result);
  });

  it("rewrites multiple absolute paths under workspaceDir", () => {
    const ws = "/Users/puddles/.openclaw/workspace-reader";
    const result: CallToolResult = {
      content: [
        {
          type: "text",
          text: `saved to ${ws}/attachments/a.pdf and ${ws}/attachments/b.jpg`,
        },
      ],
    };
    const out = rewriteAttachmentPaths(result, ws);
    expect((out.content[0] as { text: string }).text).toBe(
      "saved to attachments/a.pdf and attachments/b.jpg",
    );
  });

  it("preserves isError and other top-level fields", () => {
    const result: CallToolResult = {
      content: [{ type: "text", text: "/ws/attachments/x" }],
      isError: true,
    };
    const out = rewriteAttachmentPaths(result, "/ws");
    expect(out.isError).toBe(true);
  });
});
