export type ChatTraceKind = 'model_call' | 'tool_call' | 'subagent_call' | 'reply' | 'error';

/** One step of a chat request. Times are epoch milliseconds; `durationMs` is set when the step finishes. */
export interface ChatTraceEvent {
  seq: number;
  kind: ChatTraceKind;
  label: string;
  startedAt: number;
  durationMs?: number;
  ok?: boolean;
  detail?: string;
}

/** Collects the timeline of one chat request. Events are kept in order and never reordered. */
export class ChatTrace {
  private readonly events: ChatTraceEvent[] = [];

  /** Starts a step and returns a function that closes it. Closing twice is a no-op. */
  public begin(kind: ChatTraceKind, label: string, detail?: string): (outcome?: { ok?: boolean; detail?: string | undefined }) => ChatTraceEvent {
    const event: ChatTraceEvent = { seq: this.events.length + 1, kind, label, startedAt: Date.now(), ...(detail ? { detail } : {}) };
    this.events.push(event);
    let closed = false;
    return (outcome) => {
      if (!closed) {
        closed = true;
        event.durationMs = Date.now() - event.startedAt;
        if (outcome?.ok !== undefined) event.ok = outcome.ok;
        if (outcome?.detail) event.detail = outcome.detail;
      }
      return { ...event };
    };
  }

  /** Records a step that has no duration, such as a final reply or an error. */
  public mark(kind: ChatTraceKind, label: string, ok?: boolean, detail?: string): ChatTraceEvent {
    const event: ChatTraceEvent = { seq: this.events.length + 1, kind, label, startedAt: Date.now(), ...(ok !== undefined ? { ok } : {}), ...(detail ? { detail } : {}) };
    this.events.push(event);
    return { ...event };
  }

  /** Marks any step still open as failed, for example when a request throws mid-step. */
  public closeOpen(): void {
    const now = Date.now();
    for (const event of this.events) {
      if (event.durationMs === undefined && (event.kind === 'model_call' || event.kind === 'tool_call' || event.kind === 'subagent_call')) {
        event.durationMs = now - event.startedAt;
        event.ok = false;
      }
    }
  }

  public snapshot(): ChatTraceEvent[] {
    return this.events.map((event) => ({ ...event }));
  }
}

/** Tool results signal failure as a JSON object with an `error` field, or a sub-agent limit message. */
export function isToolErrorResult(result: string): boolean {
  if (result.startsWith('子代理调用被限制')) return true;
  try {
    const parsed = JSON.parse(result) as unknown;
    return typeof parsed === 'object' && parsed !== null && 'error' in parsed;
  } catch {
    return false;
  }
}

/** Trims long tool output so the trace stays small enough to send over the socket. */
export function summarizeForTrace(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
