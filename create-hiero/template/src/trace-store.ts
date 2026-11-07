import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatTraceEvent } from './chat-trace.js';

const TRACE_FILE = 'traces.jsonl';
export const TRACE_HISTORY_LIMIT = 50;

export interface StoredChatTrace {
  request_id: string;
  saved_at: string;
  events: ChatTraceEvent[];
}

function tracePath(workspacePath: string): string {
  return join(workspacePath, '.hiero', TRACE_FILE);
}

/** Appends one finished request's timeline to the workspace's `.hiero/traces.jsonl`. */
export async function appendChatTrace(workspacePath: string, requestId: string, events: ChatTraceEvent[]): Promise<void> {
  if (events.length === 0) return;
  const path = tracePath(workspacePath);
  await mkdir(join(path, '..'), { recursive: true });
  const record: StoredChatTrace = { request_id: requestId, saved_at: new Date().toISOString(), events };
  await appendFile(path, JSON.stringify(record) + '\n', 'utf8');
}

/** Returns the most recent stored traces, oldest first. Corrupt lines are skipped. */
export async function listChatTraces(workspacePath: string, limit = TRACE_HISTORY_LIMIT): Promise<StoredChatTrace[]> {
  const raw = (await readFile(tracePath(workspacePath), 'utf8').catch(() => '')).replace(/^\uFEFF/, '');
  const traces: StoredChatTrace[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { traces.push(JSON.parse(line) as StoredChatTrace); } catch { /* skip corrupt line */ }
  }
  return traces.slice(-limit);
}
