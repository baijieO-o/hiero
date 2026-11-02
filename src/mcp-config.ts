import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { McpServerConfig } from './mcp-client.js';

export const MCP_CONFIG_FILE = join('.hiero', 'mcp.json');

const serverNameSchema = z.string().trim().min(1).regex(/^[A-Za-z0-9_-]+$/, '名称只能包含字母、数字、下划线和连字符');
const commonFields = { name: serverNameSchema, enabled: z.boolean().default(true) };

const stdioServerSchema = z.object({
  ...commonFields,
  transport: z.literal('stdio').default('stdio'),
  command: z.string().trim().min(1, 'command 不能为空'),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const remoteServerSchema = z.object({
  ...commonFields,
  transport: z.enum(['sse', 'http']),
  url: z.string().trim().url('url 必须是合法的 http(s) 地址').refine((value) => /^https?:/.test(value), 'url 必须使用 http 或 https'),
  headers: z.record(z.string(), z.string()).optional(),
});

const mcpServerSchema = z.union([stdioServerSchema, remoteServerSchema]);

export const mcpConfigSchema = z.object({ servers: z.array(mcpServerSchema) });

export type McpStdioServerEntry = z.infer<typeof stdioServerSchema>;
export type McpRemoteServerEntry = z.infer<typeof remoteServerSchema>;
export type McpServerEntry = z.infer<typeof mcpServerSchema>;
export type McpConfigFile = z.infer<typeof mcpConfigSchema>;

export function mcpConfigPath(root = process.cwd()): string {
  return join(root, MCP_CONFIG_FILE);
}

/** Official filesystem server, scoped to the workspace root. Written to disk on first run so the user can edit or remove it. */
export function defaultMcpConfig(root = process.cwd()): McpConfigFile {
  return {
    servers: [{ name: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', root], enabled: true }],
  };
}

/** Reads the MCP config. A missing file writes and returns the default config. Invalid content throws with a readable message. */
export function readMcpConfig(root = process.cwd()): McpConfigFile {
  const path = mcpConfigPath(root);
  if (!existsSync(path)) return saveMcpConfig(defaultMcpConfig(root), root);
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

/** Expands ${NAME} from the runtime environment at connect time, so secrets never need to be written to mcp.json. */
export function expandEnvPlaceholders(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined || resolved === '') throw new Error(`环境变量 ${name} 未设置`);
    return resolved;
  });
}

const expandRecord = (record: Record<string, string> | undefined): Record<string, string> | undefined =>
  record ? Object.fromEntries(Object.entries(record).map(([key, value]) => [key, expandEnvPlaceholders(value)])) : undefined;

export function toClientConfig(server: McpServerEntry): McpServerConfig {
  if (server.transport === 'stdio') {
    const env = expandRecord(server.env);
    return {
      name: server.name,
      transport: 'stdio',
      command: server.command,
      args: server.args.map((arg) => expandEnvPlaceholders(arg)),
      ...(server.cwd ? { cwd: server.cwd } : {}),
      ...(env ? { env } : {}),
    };
  }
  const headers = expandRecord(server.headers);
  return { name: server.name, transport: server.transport, url: expandEnvPlaceholders(server.url), ...(headers ? { headers } : {}) };
}
