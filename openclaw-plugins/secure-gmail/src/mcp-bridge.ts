import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  CallToolResult,
  Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";

/** Options for spawning a stdio MCP server subprocess. */
export interface McpBridgeOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Logical name surfaced to the MCP server during the handshake. */
  clientName?: string;
  clientVersion?: string;
}

/**
 * Thin wrapper around an MCP stdio client. The plugin owns the lifecycle:
 * call `connect()` once during `register`, then `listTools` / `callTool`
 * as needed. `close()` stops the subprocess.
 */
export class McpBridge {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  constructor(private readonly opts: McpBridgeOptions) {}

  async connect(): Promise<void> {
    if (this.client) return;

    const transport = new StdioClientTransport({
      command: this.opts.command,
      args: this.opts.args ?? [],
      cwd: this.opts.cwd,
      env: this.opts.env,
    });
    const client = new Client(
      {
        name: this.opts.clientName ?? "secure-gmail",
        version: this.opts.clientVersion ?? "0.1.0",
      },
      { capabilities: {} },
    );

    await client.connect(transport);
    this.client = client;
    this.transport = transport;
  }

  async listTools(): Promise<McpTool[]> {
    const client = this.requireClient();
    const { tools } = await client.listTools();
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const client = this.requireClient();
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close().catch(() => undefined);
      this.client = null;
    }
    if (this.transport) {
      await this.transport.close().catch(() => undefined);
      this.transport = null;
    }
  }

  private requireClient(): Client {
    if (!this.client) {
      throw new Error("McpBridge: connect() must be called before use");
    }
    return this.client;
  }
}

/** Convenience: spawn + connect in one call. */
export async function connectMcpBridge(
  opts: McpBridgeOptions,
): Promise<McpBridge> {
  const bridge = new McpBridge(opts);
  await bridge.connect();
  return bridge;
}
