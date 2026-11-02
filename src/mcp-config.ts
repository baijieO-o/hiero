import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { McpServerConfig } from './mcp-client.js';

export const MCP_CONFIG_FILE = join('.hiero', 'mcp.json');

const stdioServerSchema = z.object({
  name: z.string().trim().min(1).regex(/^[A-Za-z0-9_-]+$/, '名称只能包含字母、数字、下划线和连字符'),
  transport: z.literal('stdio').default('stdio'),
  command: z.string().trim().min(1, 'command 不能为空'),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().default(true),
});

export const mcpConfigSchema = z.object({ servers: z.array(stdioServerSchema) });

export type McpStdioServerEntry = z.infer<typeof stdioServerSchema>;
export type McpConfigFile = z.infer<typeof mcpConfigSchema>;

export function mcpConfigPath(root = process.cwd()): string {
  return join(root, MCP_CONFIG_FILE);
}

/** Official filesystem server, scoped to the workspace root. Written to disk on first run so the user can edit or remove it. */
export const DEFAULT_MCP_CONFIG: McpConfigFile = {
  servers: [{ name: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:\\new'], enabled: true }],
};

/** Reads the MCP config. A missing file writes and returns the default config. Invalid content throws with a readable message. */
export function readMcpConfig(root = process.cwd()): McpConfigFile {
  const path = mcpConfigPath(root);
  if (!existsSync(path)) return saveMcpConfig(DEFAULT_MCP_CONFIG, root);
  const parsed = mcpConfigSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  return parsed.data;
}

/** Validates the input, rejects duplicate names, writes the file, and returns the normalized config. */
export function saveMcpConfig(input: unknown, root = process.cwd()): McpConfigFile {
  const parsed = mcpConfigSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  const names = new Set<string>();
  for (const server of parsed.data.servers) {
    if (names.has(server.name)) throw new Error(`MCP 服务器名称重复：${server.name}`);
    names.add(server.name);
  }
  const path = mcpConfigPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(parsed.data, null, 2) + '\n', 'utf8');
  return parsed.data;
}

export function toClientConfig(server: McpStdioServerEntry): McpServerConfig {
  return {
    name: server.name,
    transport: 'stdio',
    command: server.command,
    args: server.args,
    ...(server.cwd ? { cwd: server.cwd } : {}),
    ...(server.env ? { env: server.env } : {}),
  };
}
