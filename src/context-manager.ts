import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HandoffDocument } from './contracts.js';
import { error } from './contracts.js';

export class ContextManager {
  public constructor(private readonly workspacePath: string, private readonly threshold = 0.8) {
    if (threshold <= 0 || threshold > 1) throw error('CTX-003', 'blocker', 'Invalid context threshold.', 'Use a threshold in the range (0, 1].');
  }

  public shouldHandoff(usedTokens: number, maxTokens: number): boolean {
    if (maxTokens <= 0 || usedTokens < 0) throw error('CTX-004', 'blocker', 'Invalid context budget.', 'Provide positive maxTokens and non-negative usedTokens.');
    return usedTokens / maxTokens >= this.threshold;
  }

  public async save(document: HandoffDocument): Promise<string> {
    const directory = join(this.workspacePath, '.hiero');
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'handoff.json');
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    return path;
  }

  public async load(): Promise<HandoffDocument> {
    try {
      const raw: unknown = JSON.parse(await readFile(join(this.workspacePath, '.hiero', 'handoff.json'), 'utf8'));
      if (!isHandoffDocument(raw)) throw new Error('schema validation failed');
      return raw;
    } catch (cause) {
      throw error('CTX-002', 'blocker', 'Handoff document schema validation failed or file is unreadable.', 'Regenerate the handoff document.', cause instanceof Error ? cause.message : undefined);
    }
  }
}

function isHandoffDocument(value: unknown): value is HandoffDocument {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.checkpoint_id === 'string' && typeof candidate.task_goal === 'string' && typeof candidate.current_state === 'string'
    && Array.isArray(candidate.completed_steps) && Array.isArray(candidate.next_steps)
    && Array.isArray(candidate.active_mcp_servers) && Array.isArray(candidate.deferred_tool_subset)
    && typeof candidate.mrtr_pending === 'boolean' && Array.isArray(candidate.human_modified_files)
    && Array.isArray(candidate.decisions_and_rationale);
}
