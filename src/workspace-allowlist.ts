import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Per-machine list of folders the runtime may use as a workspace.
 * Stored in ~/.hiero so it is never committed to the repository.
 * When the file is missing, only the runtime's start directory is allowed, which keeps existing behavior.
 */
export function defaultAllowlistPath(): string {
  return join(homedir(), '.hiero', 'workspace-allowlist.json');
}

export function loadAllowlist(path: string, fallbackRoot: string): string[] {
  if (!existsSync(path)) return [resolve(fallbackRoot)];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { roots?: unknown };
    const roots = Array.isArray(parsed.roots) ? parsed.roots.filter((root): root is string => typeof root === 'string' && root.trim() !== '') : [];
    return roots.map((root) => resolve(root));
  } catch {
    return [resolve(fallbackRoot)];
  }
}

export function saveAllowlist(path: string, roots: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  const unique = [...new Set(roots.map((root) => resolve(root)))];
  writeFileSync(temp, `${JSON.stringify({ roots: unique }, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
}

/** True when `candidate` equals an allowed root or sits under one. Both sides are normalized first. */
export function isAllowedWorkspace(roots: string[], candidate: string): boolean {
  const target = resolve(candidate);
  return roots.some((root) => {
    const base = resolve(root);
    return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
  });
}
