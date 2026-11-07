import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type MemoryScope = 'global' | 'project';

export const MEMORY_LIMIT_CHARS = 4000;
const MEMORY_FILE = 'memory.md';

export interface MemoryRecord {
  scope: MemoryScope;
  path: string;
  content: string;
  limit: number;
}

export function memoryPath(scope: MemoryScope, workspacePath: string): string {
  if (scope === 'project') return join(workspacePath, '.agent', MEMORY_FILE);
  return join(homedir(), '.hiero', MEMORY_FILE);
}

function assertScope(scope: unknown): asserts scope is MemoryScope {
  if (scope !== 'global' && scope !== 'project') throw new Error(`未知记忆范围：${String(scope)}`);
}

export async function readMemory(workspacePath: string, scope: MemoryScope): Promise<MemoryRecord> {
  assertScope(scope);
  const path = memoryPath(scope, workspacePath);
  const content = await readFile(path, 'utf8').catch(() => '');
  return { scope, path, content, limit: MEMORY_LIMIT_CHARS };
}

export async function saveMemory(workspacePath: string, scope: MemoryScope, content: string): Promise<MemoryRecord> {
  assertScope(scope);
  if (content.length > MEMORY_LIMIT_CHARS) throw new Error(`记忆超过上限 ${MEMORY_LIMIT_CHARS} 字符（MEM-001）`);
  const path = memoryPath(scope, workspacePath);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
  return readMemory(workspacePath, scope);
}

// Appends only: the model may add to layers 0 and 1 but never rewrites them (principle 2).
export async function appendMemory(workspacePath: string, scope: MemoryScope, text: string): Promise<MemoryRecord> {
  const addition = text.trim();
  if (!addition) throw new Error('记忆内容不能为空。');
  const current = await readMemory(workspacePath, scope);
  const next = current.content.trim() ? `${current.content.trimEnd()}\n${addition}\n` : `${addition}\n`;
  return saveMemory(workspacePath, scope, next);
}

// Global rules come first so project-specific memory can refine them.
export async function memoryContext(workspacePath: string): Promise<string> {
  const sections: string[] = [];
  for (const scope of ['global', 'project'] as const) {
    const { content } = await readMemory(workspacePath, scope);
    const trimmed = content.trim();
    if (trimmed) sections.push(`[${scope === 'global' ? '全局准则' : '项目记忆'}]\n${trimmed.slice(0, MEMORY_LIMIT_CHARS)}`);
  }
  return sections.join('\n\n');
}
