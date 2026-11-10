import { randomUUID } from 'node:crypto';

export type AskUserFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'multi';

export interface AskUserField {
  key: string;
  type: AskUserFieldType;
  title: string;
  description?: string;
  options?: { value: string; label: string }[];
}

export type AskUserRequest = {
  ask_id: string;
  message: string;
  fields: AskUserField[];
};

export type AskUserResult =
  | { status: 'submitted'; values: Record<string, unknown> }
  | { status: 'declined' }
  | { status: 'cancelled' };

interface PendingAsk {
  resolve: (result: AskUserResult) => void;
  timer: NodeJS.Timeout;
}

/** Holds ask_user questions until the operator answers, declines, or they time out (treated as cancelled). */
export class AskUserBroker {
  private readonly pending = new Map<string, PendingAsk>();

  public constructor(
    private readonly notify: (request: AskUserRequest) => void,
    private readonly timeoutMs = 120_000,
  ) {}

  public ask(message: string, fields: AskUserField[]): Promise<AskUserResult> {
    const request: AskUserRequest = { ask_id: randomUUID(), message, fields };
    return new Promise<AskUserResult>((resolve) => {
      const timer = setTimeout(() => this.settle(request.ask_id, { status: 'cancelled' }), this.timeoutMs);
      this.pending.set(request.ask_id, { resolve, timer });
      this.notify(request);
    });
  }

  /** Returns false for unknown or already-settled ids, so duplicate replies are ignored. */
  public respond(askId: string, result: AskUserResult): boolean {
    return this.settle(askId, result);
  }

  private settle(askId: string, result: AskUserResult): boolean {
    const entry = this.pending.get(askId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(askId);
    entry.resolve(result);
    return true;
  }
}
