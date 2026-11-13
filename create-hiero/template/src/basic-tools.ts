import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { RegisteredTool } from './tool-gateway.js';
import type { WriteSnapshotStore } from './write-snapshots.js';

export const writeFileInput = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export const readFileInput = z.object({
  path: z.string().min(1),
  /** 1-based first line to return. Use with limit to page through large files. */
  offset: z.number().int().min(1).optional(),
  /** Maximum number of lines to return. */
  limit: z.number().int().min(1).max(2_000).optional(),
});
export const listDirInput = z.object({ path: z.string().default('.') });

export function resolveWorkspacePath(workspacePath: string, path: string): string {
  const target = resolve(workspacePath, path);
  const workspace = resolve(workspacePath);
  if (isAbsolute(path) || !isInside(workspace, target)) {
    throw new Error('Path must stay inside the configured workspace.');
  }
  const realWorkspace = realpathSync(workspace);
  const realTarget = realpathOfExisting(target);
  if (!isInside(realWorkspace, realTarget)) {
    throw new Error('Path must stay inside the configured workspace.');
  }
  return target;
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`) || candidate.startsWith(`${root}\\`);
}

/** Resolves symlinks for the longest existing prefix of a path, so links cannot escape the workspace. */
function realpathOfExisting(target: string): string {
  let current = target;
  const missing: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync(current), ...missing);
}

/** Page size for read_file. Kept below the executor's tool-result cap so the continuation hint at the end is never clipped. */
const PAGE_CHARS = 12_000;

export function createReadFileTool(workspacePath: string): RegisteredTool<z.infer<typeof readFileInput>, { path: string; content: string }> {
  return {
    name: 'read_file',
    inputSchema: readFileInput,
    effect: 'read',
    execute: async ({ path, offset, limit }) => {
      const target = resolveWorkspacePath(workspacePath, path);
      const info = await stat(target);
      if (info.isDirectory()) throw new Error(`"${path}" is a directory; use list_dir to list its entries.`);
      const text = await readFile(target, 'utf8');
      if (offset === undefined && limit === undefined) {
        if (text.length <= PAGE_CHARS) return { path: target, content: text };
        const totalLines = text.split('\n').length;
        const page = text.slice(0, PAGE_CHARS);
        const shownLines = page.split('\n').length - 1;
        return {
          path: target,
          content: `${page}\n[truncated: showing about the first ${shownLines} of ${totalLines} lines; call read_file again with offset=${shownLines + 1} and limit to read the rest]`,
        };
      }
      const lines = text.split('\n');
      const start = (offset ?? 1) - 1;
      const count = limit ?? 500;
      const slice = lines.slice(start, start + count).join('\n').slice(0, PAGE_CHARS);
      const next = start + count < lines.length ? start + count + 1 : undefined;
      const hint = next ? `\n[lines ${start + 1}-${Math.min(start + count, lines.length)} of ${lines.length}; continue with offset=${next}]` : `\n[end of file, ${lines.length} lines]`;
      return { path: target, content: slice + hint };
    },
  };
}

export function createListDirTool(workspacePath: string): RegisteredTool<z.infer<typeof listDirInput>, { path: string; entries: { name: string; type: 'file' | 'directory' }[] }> {
  return {
    name: 'list_dir',
    inputSchema: listDirInput,
    effect: 'read',
    execute: async ({ path }) => {
      const target = resolveWorkspacePath(workspacePath, path);
      const dirents = await readdir(target, { withFileTypes: true });
      const entries = dirents
        .slice(0, 500)
        .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' as const : 'file' as const }))
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
      return { path: target, entries };
    },
  };
}

export const editFileInput = z.object({
  path: z.string().min(1),
  /** Exact text to replace. Must occur exactly once in the file, so the edit is unambiguous. */
  old_string: z.string().min(1),
  new_string: z.string(),
});

/** Applies one exact, unique string replacement. Unlike write_file, it never rewrites unrelated content. */
export function createEditFileTool(workspacePath: string, snapshots?: WriteSnapshotStore): RegisteredTool<z.infer<typeof editFileInput>, { path: string; replacements: number }> {
  return {
    name: 'edit_file',
    inputSchema: editFileInput,
    irreversible: true,
    effect: 'workspace',
    execute: async ({ path, old_string, new_string }) => {
      const target = resolveWorkspacePath(workspacePath, path);
      const current = await readFile(target, 'utf8');
      const occurrences = current.split(old_string).length - 1;
      if (occurrences === 0) throw new Error(`old_string was not found in "${path}". Read the file and copy the exact text.`);
      if (occurrences > 1) throw new Error(`old_string matches ${occurrences} places in "${path}". Include more surrounding context so it is unique.`);
      const next = current.replace(old_string, () => new_string);
      await writeFile(target, next, 'utf8');
      snapshots?.recordWrite(target, current, next);
      return { path: target, replacements: 1 };
    },
  };
}

export function createWriteFileTool(workspacePath: string, snapshots?: WriteSnapshotStore): RegisteredTool<z.infer<typeof writeFileInput>, { path: string; bytes: number }> {
  return {
    name: 'write_file',
    inputSchema: writeFileInput,
    irreversible: true,
    effect: 'workspace',
    execute: async ({ path, content }) => {
      const target = resolveWorkspacePath(workspacePath, path);
      const { previous } = snapshots ? await snapshots.captureBeforeWrite(target) : { previous: null };
      await writeFile(target, content, 'utf8');
      snapshots?.recordWrite(target, previous, content);
      return { path: target, bytes: Buffer.byteLength(content, 'utf8') };
    },
  };
}
