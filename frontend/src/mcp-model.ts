export type McpTransport = 'stdio' | 'sse' | 'http';

/** Loose shape of a server entry as stored in .hiero/mcp.json. Mirrors the backend schema in src/mcp-config.ts. */
export interface McpServerDraft {
  name: string;
  transport?: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
}

export interface CustomServerInput {
  name: string;
  transport: McpTransport;
  command: string;
  args: string;
  url: string;
  /** One `KEY=VALUE` per line, used as env (stdio) or headers (sse/http). */
  secrets: string;
}

const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
/** A value that looks like a literal secret rather than a ${VAR} placeholder. */
const SECRET_KEY_PATTERN = /(token|secret|password|passwd|api[_-]?key|authorization|credential)/i;
const PLACEHOLDER_PATTERN = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;
const URL_CREDENTIALS_PATTERN = /^https?:\/\/[^/\s:@]+:[^/\s@]+@/i;

/** Parses `KEY=VALUE` lines. Blank lines are ignored; a line without `=` is an error. */
export function parseKeyValueLines(text: string): { ok: true; record: Record<string, string> } | { ok: false; message: string } {
  const record: Record<string, string> = {};
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) return { ok: false, message: `第 ${index + 1} 行需要 KEY=VALUE 格式` };
    record[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return { ok: true, record };
}

/** Returns the reason a secret value would be stored in plaintext, or null when it is safe (a ${VAR} placeholder). */
export function plaintextSecretProblem(key: string, value: string): string | null {
  if (!SECRET_KEY_PATTERN.test(key)) return null;
  // Strip placeholders first: a value that still contains literal text beside them (e.g. "ghp_x${VAR}") is plaintext.
  const literal = value.replace(new RegExp(PLACEHOLDER_PATTERN.source, 'g'), '').replace(/^(bearer|basic)\s+/i, '').trim();
  if (literal === '' && PLACEHOLDER_PATTERN.test(value)) return null;
  if (literal !== '') return `${key} 看起来是凭据，请改用 \${环境变量名} 占位符，避免明文写入 mcp.json`;
  return null;
}

/** Builds a validated server draft from the custom form. Returns a message for the first problem found. */
export function buildCustomServer(input: CustomServerInput, existingNames: string[]): { ok: true; server: McpServerDraft } | { ok: false; message: string } {
  const name = input.name.trim();
  if (!NAME_PATTERN.test(name)) return { ok: false, message: '名称只能包含字母、数字、下划线和连字符' };
  if (existingNames.includes(name)) return { ok: false, message: `名称已存在：${name}` };
  const parsed = parseKeyValueLines(input.secrets);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  for (const [key, value] of Object.entries(parsed.record)) {
    const problem = plaintextSecretProblem(key, value);
    if (problem) return { ok: false, message: problem };
  }

  if (input.transport === 'stdio') {
    const command = input.command.trim();
    if (!command) return { ok: false, message: '本地命令不能为空' };
    const args = input.args.split(/\r?\n/).map((arg) => arg.trim()).filter(Boolean);
    const hasEnv = Object.keys(parsed.record).length > 0;
    return { ok: true, server: { name, transport: 'stdio', command, args, ...(hasEnv ? { env: parsed.record } : {}), enabled: false } };
  }

  const url = input.url.trim();
  if (!/^https?:\/\/\S+$/.test(url)) return { ok: false, message: 'URL 必须以 http:// 或 https:// 开头' };
  if (URL_CREDENTIALS_PATTERN.test(url)) return { ok: false, message: 'URL 中不能包含用户名和密码，请把凭据放到请求头并使用 ${环境变量名}' };
  const hasHeaders = Object.keys(parsed.record).length > 0;
  return { ok: true, server: { name, transport: input.transport, url, ...(hasHeaders ? { headers: parsed.record } : {}), enabled: false } };
}

/** Every server can run code (stdio) or send data off the machine (sse/http), so enabling one always needs explicit confirmation. */
export function needsEnableConfirmation(_server: McpServerDraft): boolean {
  return true;
}

export function describeServer(server: McpServerDraft): string {
  if (!server.transport || server.transport === 'stdio') return `本地命令：${[server.command, ...(server.args ?? [])].join(' ')}`;
  return `远程地址：${server.url ?? ''}`;
}
