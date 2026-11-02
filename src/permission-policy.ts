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
const SHELL_CONTROL = /[;&|`<>$()\n\r]/;

/**
 * Decides whether a shell command may run under the given mode.
 * - strict: never runs shell commands.
 * - standard: only read-only commands with no shell control operators.
 * - auto: runs anything.
 */
export function checkCommandPolicy(command: string, mode: PermissionMode): { allowed: true } | { allowed: false; reason: string } {
  if (mode === 'auto') return { allowed: true };
  if (mode === 'strict') return { allowed: false, reason: '严格模式下不允许执行终端命令。' };
  const trimmed = command.trim();
  if (trimmed.length === 0) return { allowed: false, reason: '命令为空。' };
  if (SHELL_CONTROL.test(trimmed)) return { allowed: false, reason: '标准模式下不允许使用管道、重定向或命令拼接。' };
  const [head = '', sub = ''] = trimmed.split(/\s+/);
  const name = head.toLowerCase();
  if (!READ_ONLY_COMMANDS.has(name)) return { allowed: false, reason: `标准模式下不允许执行命令 '${head}'。` };
  if (name === 'git' && !GIT_READ_ONLY_SUBCOMMANDS.has(sub)) return { allowed: false, reason: `标准模式下只允许只读 git 子命令。` };
  return { allowed: true };
}
