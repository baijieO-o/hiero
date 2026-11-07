import type { PermissionMode } from './contracts.js';

const LABEL_TO_MODE: Record<string, PermissionMode> = { 严格: 'strict', 标准: 'standard', 自动: 'auto' };

/** Accepts either the internal enum or the Chinese labels used by the chat selector. */
export function parsePermissionMode(value: unknown, fallback: PermissionMode): PermissionMode {
  if (value === 'strict' || value === 'standard' || value === 'auto') return value;
  if (typeof value === 'string' && value in LABEL_TO_MODE) return LABEL_TO_MODE[value] as PermissionMode;
  return fallback;
}

const READ_ONLY_COMMANDS = new Set(['ls', 'dir', 'pwd', 'cat', 'type', 'echo', 'git', 'head', 'tail', 'wc', 'where', 'which']);
const GIT_READ_ONLY_SUBCOMMANDS = new Set(['status', 'log', 'diff', 'show', 'branch', 'rev-parse']);
/** Git flags that write files or run external programs even on read-only subcommands. */
const GIT_UNSAFE_FLAGS = /^(--output(=|$)|-o$|--ext-diff|--textconv|--exec|-c$|--upload-pack|--git-dir|--work-tree)/i;
const PATH_COMMANDS = new Set(['ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc']);
const SHELL_CONTROL = /[;&|`<>$()\n\r]/;

/** Conservative check: absolute, drive-relative, home, or parent-directory paths are treated as outside the workspace. */
function escapesWorkspace(arg: string): boolean {
  if (arg.startsWith('-')) return false;
  if (/^[a-zA-Z]:/.test(arg) || arg.startsWith('/') || arg.startsWith('\\') || arg.startsWith('~')) return true;
  return arg.split(/[\\/]/).includes('..');
}

/**
 * Decides whether a shell command may run under the given mode.
 * - strict: never runs shell commands.
 * - standard: only read-only commands, no shell control operators, no unsafe git flags,
 *   and no path arguments that point outside the workspace.
 * - auto: runs anything.
 */
export function checkCommandPolicy(command: string, mode: PermissionMode): { allowed: true } | { allowed: false; reason: string } {
  if (mode === 'auto') return { allowed: true };
  if (mode === 'strict') return { allowed: false, reason: '严格模式下不允许执行终端命令。' };
  const trimmed = command.trim();
  if (trimmed.length === 0) return { allowed: false, reason: '命令为空。' };
  if (SHELL_CONTROL.test(trimmed)) return { allowed: false, reason: '标准模式下不允许使用管道、重定向或命令拼接。' };
  const [head = '', sub = '', ...rest] = trimmed.split(/\s+/);
  const name = head.toLowerCase();
  if (!READ_ONLY_COMMANDS.has(name)) return { allowed: false, reason: `标准模式下不允许执行命令 '${head}'。` };
  if (name === 'git') {
    if (!GIT_READ_ONLY_SUBCOMMANDS.has(sub)) return { allowed: false, reason: '标准模式下只允许只读 git 子命令。' };
    const flagged = [sub, ...rest].find((arg) => GIT_UNSAFE_FLAGS.test(arg));
    if (flagged) return { allowed: false, reason: `标准模式下不允许 git 参数 '${flagged}'。` };
  }
  if (PATH_COMMANDS.has(name)) {
    const outside = [sub, ...rest].find((arg) => escapesWorkspace(arg));
    if (outside) return { allowed: false, reason: `标准模式下不允许访问工作区之外的路径 '${outside}'。` };
  }
  return { allowed: true };
}
