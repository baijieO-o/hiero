import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { error } from './contracts.js';
import type { ModelToolDefinition } from './model-gateway.js';

export interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

type McpTransport = StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;

interface ConnectedMcpServer { config: McpServerConfig; client: Client; transport: McpTransport; tools: Tool[]; }

export interface McpServerStatus { name: string; connected: boolean; tool_count: number; error?: string; }

export class McpToolClient {
  private readonly servers = new Map<string, ConnectedMcpServer>();
  private readonly failures = new Map<string, string>();

  /** Connects one server and caches its tool list. A failed connection is recorded instead of thrown, so other servers still work. */
  public async connect(config: McpServerConfig): Promise<void> {
    if (this.servers.has(config.name)) return;
    const client = new Client({ name: 'hiero', version: '0.1.0' });
    const transport = createTransport(config);
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      this.servers.set(config.name, { config, client, transport, tools });
      this.failures.delete(config.name);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.failures.set(config.name, message);
      await transport.close().catch(() => undefined);
      throw error('MCP-001', 'blocker', `MCP server '${config.name}' discovery failed.`, 'Check the command, args and cwd of this server in the settings panel.', message);
    }
  }

  public async listTools(): Promise<Tool[]> {
    return [...this.servers.values()].flatMap((server) => server.tools);
  }

  public async callTool(name: string, args: unknown): Promise<unknown> {
    for (const server of this.servers.values()) {
      if (server.tools.some((tool) => tool.name === name)) return server.client.callTool({ name, arguments: args as Record<string, unknown> });
    }
    throw error('MCP-003', 'blocker', `MCP tool '${name}' was not found.`, 'Search connected MCP servers before execution.');
  }

  public statuses(configuredNames: readonly string[]): McpServerStatus[] {
    return configuredNames.map((name) => {
      const server = this.servers.get(name);
      if (server) return { name, connected: true, tool_count: server.tools.length };
      const failure = this.failures.get(name);
      return { name, connected: false, tool_count: 0, ...(failure ? { error: failure } : {}) };
    });
  }

  public async close(): Promise<void> {
    await Promise.all([...this.servers.values()].map(async ({ client, transport }) => { await client.close().catch(() => undefined); await transport.close().catch(() => undefined); }));
    this.servers.clear();
    this.failures.clear();
  }
}

function createTransport(config: McpServerConfig): McpTransport {
  if (config.transport === 'stdio') {
    return new StdioClientTransport({ command: config.command ?? '', ...(config.args ? { args: config.args } : {}), ...(config.cwd ? { cwd: config.cwd } : {}), ...(config.env ? { env: config.env } : {}) });
  }
  const url = new URL(config.url ?? '');
  const requestInit = config.headers ? { headers: config.headers } : undefined;
  if (config.transport === 'sse') return new SSEClientTransport(url, requestInit ? { requestInit } : undefined);
  return new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined);
}

export function mcpToolDefinition(tool: Tool): ModelToolDefinition {
  return { type: 'function', function: { name: tool.name, ...(tool.description ? { description: tool.description } : {}), parameters: tool.inputSchema } };
}
