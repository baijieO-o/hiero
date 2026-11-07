import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type SkillScope = 'project' | 'user' | 'agents' | 'codex';

// Priority order: earlier scopes win when the same skill name appears in several directories.
const SCOPES: readonly SkillScope[] = ['project', 'user', 'agents', 'codex'];

export interface SkillRecord {
  id: string;
  name: string;
  scope: SkillScope;
  description: string;
  path: string;
  size: number;
}

const SKILL_FILE = 'SKILL.md';
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function scopeRoot(scope: SkillScope, workspacePath: string): string {
  if (scope === 'project') return join(workspacePath, '.agent', 'skills');
  if (scope === 'agents') return join(homedir(), '.agents', 'skills');
  if (scope === 'codex') return join(homedir(), '.codex', 'skills');
  return join(homedir(), '.copilot', 'skills');
}

function assertName(name: string): void {
  if (!NAME_PATTERN.test(name)) throw new Error(`非法技能名：${name}`);
}

function assertScope(scope: unknown): asserts scope is SkillScope {
  if (!SCOPES.includes(scope as SkillScope)) throw new Error(`未知技能范围：${String(scope)}`);
}

function extractDescription(content: string): string {
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const lines = frontmatter?.[1]?.split(/\r?\n/) ?? [];
  const index = lines.findIndex((line) => /^description:/.test(line));
  if (index >= 0) {
    const inline = (lines[index] ?? '').replace(/^description:\s*/, '').trim();
    if (inline && !/^[>|]/.test(inline)) return inline;
    const block: string[] = [];
    for (const line of lines.slice(index + 1)) {
      if (!/^\s+/.test(line)) break;
      block.push(line.trim());
    }
    if (block.length) return block.join(' ');
  }
  return content.split(/\r?\n/).find((line) => line.trim() && !line.startsWith('#'))?.trim() ?? '';
}

export async function listSkills(workspacePath: string, options: { dedupe?: boolean } = {}): Promise<SkillRecord[]> {
  const records: SkillRecord[] = [];
  for (const scope of SCOPES) {
    const root = scopeRoot(scope, workspacePath);
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !NAME_PATTERN.test(entry.name)) continue;
      const path = join(root, entry.name, SKILL_FILE);
      try {
        const [content, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
        records.push({ id: `${scope}:${entry.name}`, name: entry.name, scope, description: extractDescription(content), path, size: info.size });
      } catch { /* Skip directories without a readable SKILL.md. */ }
    }
  }
  if (options.dedupe) {
    const seen = new Set<string>();
    const unique = records.filter((record) => {
      if (seen.has(record.name)) return false;
      seen.add(record.name);
      return true;
    });
    return unique.sort((a, b) => a.name.localeCompare(b.name));
  }
  return records.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSkill(workspacePath: string, scope: SkillScope, name: string): Promise<{ record: SkillRecord; content: string }> {
  assertScope(scope);
  assertName(name);
  const path = join(scopeRoot(scope, workspacePath), name, SKILL_FILE);
  const content = await readFile(path, 'utf8');
  const info = await stat(path);
  return { record: { id: `${scope}:${name}`, name, scope, description: extractDescription(content), path, size: info.size }, content };
}

export async function saveSkill(workspacePath: string, scope: SkillScope, name: string, content: string): Promise<SkillRecord> {
  assertScope(scope);
  assertName(name);
  const dir = join(scopeRoot(scope, workspacePath), name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, SKILL_FILE), content, 'utf8');
  return (await readSkill(workspacePath, scope, name)).record;
}

export async function deleteSkill(workspacePath: string, scope: SkillScope, name: string): Promise<void> {
  assertScope(scope);
  assertName(name);
  await rm(join(scopeRoot(scope, workspacePath), name), { recursive: true, force: true });
}
