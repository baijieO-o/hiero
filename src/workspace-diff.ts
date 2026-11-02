import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

export interface FileDiff { path: string; original: string; modified: string }

const ignored = new Set(['.git', 'node_modules', 'dist', '.hiero']);

export async function snapshotTextFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  await walk(root, root, files);
  return files;
}

export async function diffSnapshots(before: Map<string, string>, after: Map<string, string>): Promise<FileDiff[]> {
  const diffs: FileDiff[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of paths) {
    const original = before.get(path) ?? '';
    const modified = after.get(path) ?? '';
    if (original !== modified) diffs.push({ path, original, modified });
  }
  return diffs;
}

async function walk(root: string, current: string, files: Map<string, string>): Promise<void> {
  let entries;
  try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
  await Promise.all(entries.map(async (entry) => {
    if (ignored.has(entry.name)) return;
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) return walk(root, fullPath, files);
    if (!entry.isFile()) return;
    try {
      const fileStat = await stat(fullPath);
      if (fileStat.size > 1_000_000) return;
      const content = await readFile(fullPath, 'utf8');
      files.set(relative(root, fullPath), content);
    } catch { /* Binary/unreadable files are not suitable for a text diff panel. */ }
  }));
}
