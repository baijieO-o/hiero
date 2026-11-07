import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MemoryScope } from './memory-store.js';
import { cosineSimilarity, type Embedder } from './embedding.js';

export const DEEP_MEMORY_ENTRY_LIMIT_CHARS = 500;
export const DEEP_RECALL_MIN_SCORE = 0.15;
export const DEEP_VECTOR_MIN_SIMILARITY = 0.5;
const DEEP_FILE = 'deep-memory.jsonl';

export interface DeepMemoryEntry {
  id: string;
  scope: MemoryScope;
  content: string;
  tags: string[];
  created_at: string;
  embedding?: number[];
}

export interface DeepMemoryHit extends DeepMemoryEntry {
  score: number;
  keyword_score: number;
  vector_score?: number;
}

let activeEmbedder: Embedder | undefined;

/** Enables vector recall for later reads and writes. Pass undefined to fall back to keyword-only recall. */
export function setDeepMemoryEmbedder(embedder: Embedder | undefined): void {
  activeEmbedder = embedder;
}

export function deepMemoryPath(scope: MemoryScope, workspacePath: string): string {
  if (scope === 'project') return join(workspacePath, '.agent', DEEP_FILE);
  return join(homedir(), '.hiero', DEEP_FILE);
}

async function readEntries(scope: MemoryScope, workspacePath: string): Promise<DeepMemoryEntry[]> {
  const raw = await readFile(deepMemoryPath(scope, workspacePath), 'utf8').catch(() => '');
  const entries: DeepMemoryEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push({ ...(JSON.parse(line) as DeepMemoryEntry), scope }); } catch { /* skip corrupt line */ }
  }
  return entries;
}

async function writeEntries(scope: MemoryScope, workspacePath: string, entries: DeepMemoryEntry[]): Promise<void> {
  const path = deepMemoryPath(scope, workspacePath);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''), 'utf8');
}

export async function listDeepMemory(workspacePath: string): Promise<DeepMemoryEntry[]> {
  const entries = [...await readEntries('global', workspacePath), ...await readEntries('project', workspacePath)];
  return entries.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function addDeepMemory(workspacePath: string, scope: MemoryScope, content: string, tags: string[] = []): Promise<DeepMemoryEntry> {
  const text = content.trim();
  if (!text) throw new Error('记忆内容不能为空。');
  if (text.length > DEEP_MEMORY_ENTRY_LIMIT_CHARS) throw new Error(`单条记忆超过上限 ${DEEP_MEMORY_ENTRY_LIMIT_CHARS} 字符（MEM-001）。`);
  const entry: DeepMemoryEntry = { id: randomUUID(), scope, content: text, tags: tags.map((tag) => tag.trim()).filter(Boolean).slice(0, 8), created_at: new Date().toISOString() };
  const vector = await embedSafely([entryText(entry)]);
  if (vector?.[0]) entry.embedding = vector[0];
  const entries = await readEntries(scope, workspacePath);
  await writeEntries(scope, workspacePath, [...entries, entry]);
  return entry;
}

export async function deleteDeepMemory(workspacePath: string, scope: MemoryScope, id: string): Promise<void> {
  const entries = await readEntries(scope, workspacePath);
  await writeEntries(scope, workspacePath, entries.filter((entry) => entry.id !== id));
}

// Latin words plus character bigrams for CJK runs, so Chinese queries match without a segmenter.
function tokenize(text: string): Set<string> {
  const lower = text.toLowerCase();
  const tokens = new Set<string>(lower.match(/[a-z0-9_]+/g) ?? []);
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) tokens.add(run);
    for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2));
  }
  return tokens;
}

export async function deepRecallContext(workspacePath: string, query: string): Promise<string> {
  const hits = await searchDeepMemory(workspacePath, query, 5);
  return hits.map((hit) => `- [${hit.scope === 'global' ? '全局' : '项目'}] ${hit.content}`).join('\n');
}

function entryText(entry: Pick<DeepMemoryEntry, 'content' | 'tags'>): string {
  return `${entry.content} ${entry.tags.join(' ')}`;
}

async function embedSafely(texts: string[]): Promise<number[][] | undefined> {
  if (!activeEmbedder) return undefined;
  try {
    return await activeEmbedder(texts);
  } catch (cause) {
    console.warn('[hiero] Vector recall unavailable, using keyword recall:', cause instanceof Error ? cause.message : cause);
    return undefined;
  }
}

/** Hybrid recall: keyword overlap always applies; when an embedder is configured, cosine similarity can also surface an entry. */
export async function searchDeepMemory(workspacePath: string, query: string, limit = 5): Promise<DeepMemoryHit[]> {
  const queryTokens = [...tokenize(query)];
  if (queryTokens.length === 0) return [];
  const entries = await listDeepMemory(workspacePath);
  const queryVector = entries.some((entry) => entry.embedding) ? (await embedSafely([query]))?.[0] : undefined;
  return entries
    .map((entry) => {
      const entryTokens = tokenize(entryText(entry));
      const matched = queryTokens.filter((token) => entryTokens.has(token)).length;
      const keywordScore = matched / queryTokens.length;
      const vectorScore = queryVector && entry.embedding ? cosineSimilarity(queryVector, entry.embedding) : undefined;
      const score = Math.max(keywordScore, vectorScore !== undefined && vectorScore >= DEEP_VECTOR_MIN_SIMILARITY ? vectorScore : 0);
      return { ...entry, score, keyword_score: keywordScore, ...(vectorScore !== undefined ? { vector_score: vectorScore } : {}) };
    })
    .filter((hit) => hit.score >= DEEP_RECALL_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
