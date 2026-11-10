import type { TaskContract } from './contracts.js';
import type { ModelMessage } from './model-gateway.js';

export type Summarizer = (task: TaskContract, transcript: string) => Promise<string>;

export const COMPACT_SUMMARY_PREFIX = '[Compacted history]';

/** Recent turns kept verbatim. Manual and automatic compaction share this so both ends agree. */
export const DEFAULT_KEEP_RECENT = 6;

const SUMMARY_INSTRUCTION = [
  'Summarize the earlier conversation for an agent that will continue the task.',
  'Use these headings: 目标 (goal), 已完成 (done), 未完成或失败 (open or failed), 关键决定与原因 (decisions), 下一步 (next steps).',
  'List every open TODO and every file path, id, and error message still in play under 未完成或失败, copied exactly.',
  'If the conversation starts with an earlier summary, merge it into the new one so the result is a single rolling summary.',
  'Keep file paths, identifiers, and error messages exact. Do not invent facts.',
].join('\n');

function renderTranscript(messages: readonly ModelMessage[]): string {
  return messages.map((message) => `${message.role}${message.name ? `(${message.name})` : ''}: ${message.content}`).join('\n');
}

/**
 * Replaces older turns with one structured summary while keeping the system prompt and the most recent turns verbatim.
 * Returns the input unchanged when there is nothing old enough to compact.
 */
export class ContextCompactor {
  public constructor(private readonly summarize: Summarizer, private readonly keepRecent = DEFAULT_KEEP_RECENT) {}

  public async compact(task: TaskContract, messages: readonly ModelMessage[]): Promise<ModelMessage[]> {
    const head = messages[0]?.role === 'system' ? [messages[0]] : [];
    const body = messages.slice(head.length);
    // The first user turn carries the goal. Keep it verbatim so a summary never rewrites the task itself.
    const anchor = body[0]?.role === 'user' ? [body[0]] : [];
    const rest = body.slice(anchor.length);
    let split = Math.max(0, rest.length - this.keepRecent);
    // Never start the kept window with a tool result; move back so its assistant tool_calls message stays with it.
    while (split > 0 && rest[split]?.role === 'tool') split -= 1;
    if (split === 0) return [...messages];
    const older = rest.slice(0, split);
    const recent = rest.slice(split);
    const summary = (await this.summarize(task, `${SUMMARY_INSTRUCTION}\n\n${renderTranscript(older)}`)).trim();
    if (!summary) return [...messages];
    return [...head, ...anchor, { role: 'user', content: `${COMPACT_SUMMARY_PREFIX}\n${summary}` }, ...recent];
  }
}
