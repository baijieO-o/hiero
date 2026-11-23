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
  /** 'user' when the user stated it; 'inferred' when the model wrote it on its own. Missing on entries saved before this field existed. */
  source?: MemorySource;
  /** Set for session-only memories; they are recalled only inside that conversation. */
  session_id?: string;
  /** Disabled entries are kept but never recalled. Missing means enabled. */
  enabled?: boolean;
  updated_at?: string;
}

export type MemorySource = 'user' | 'inferred';

export interface AddDeepMemoryOptions {
  tags?: string[];
  source?: MemorySource;
  sessionId?: string;
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

function checkContent(content: string): string {
  const text = content.trim();
  if (!text) throw new Error('记忆内容不能为空。');
  if (text.length > DEEP_MEMORY_ENTRY_LIMIT_CHARS) throw new Error(`单条记忆超过上限 ${DEEP_MEMORY_ENTRY_LIMIT_CHARS} 字符（MEM-001）。`);
  return text;
}

export async function addDeepMemory(workspacePath: string, scope: MemoryScope, content: string, options: AddDeepMemoryOptions = {}): Promise<DeepMemoryEntry> {
  const text = checkContent(content);
  const entry: DeepMemoryEntry = {
    id: randomUUID(),
    scope,
    content: text,
    tags: (options.tags ?? []).map((tag) => tag.trim()).filter(Boolean).slice(0, 8),
    created_at: new Date().toISOString(),
    source: options.source ?? 'user',
    enabled: true,
    ...(options.sessionId ? { session_id: options.sessionId } : {}),
  };
  const vector = await embedSafely([entryText(entry)]);
  if (vector?.[0]) entry.embedding = vector[0];
  const entries = await readEntries(scope, workspacePath);
  await writeEntries(scope, workspacePath, [...entries, entry]);
  return entry;
}

/** Replaces an entry's text. The id, source, and scope are kept; the vector is recomputed. */
export async function updateDeepMemory(workspacePath: string, scope: MemoryScope, id: string, content: string): Promise<DeepMemoryEntry> {
  const text = checkContent(content);
  const entries = await readEntries(scope, workspacePath);
  const target = entries.find((entry) => entry.id === id);
  if (!target) throw new Error('找不到这条记忆。');
  const updated: DeepMemoryEntry = { ...target, content: text, updated_at: new Date().toISOString() };
  delete updated.embedding;
  const vector = await embedSafely([entryText(updated)]);
  if (vector?.[0]) updated.embedding = vector[0];
  await writeEntries(scope, workspacePath, entries.map((entry) => (entry.id === id ? updated : entry)));
  return updated;
}

export async function setDeepMemoryEnabled(workspacePath: string, scope: MemoryScope, id: string, enabled: boolean): Promise<void> {
  const entries = await readEntries(scope, workspacePath);
  if (!entries.some((entry) => entry.id === id)) throw new Error('找不到这条记忆。');
  await writeEntries(scope, workspacePath, entries.map((entry) => (entry.id === id ? { ...entry, enabled } : entry)));
}

/** Removes the stored copy from the memory file. It does not touch copies in backups, git history, or chat transcripts. */
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

export async function deepRecallContext(workspacePath: string, query: string, sessionId?: string): Promise<string> {
  const hits = await searchDeepMemory(workspacePath, query, 5, sessionId);
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
/** Recalls enabled entries. Session-only entries are visible only when `sessionId` matches their session. */
export async function searchDeepMemory(workspacePath: string, query: string, limit = 5, sessionId?: string): Promise<DeepMemoryHit[]> {
  const queryTokens = [...tokenize(query)];
  if (queryTokens.length === 0) return [];
  const entries = (await listDeepMemory(workspacePath)).filter((entry) => entry.enabled !== false && (!entry.session_id || entry.session_id === sessionId));
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
