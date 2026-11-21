/** Backoff settings for a plug that fails to start. Failures are retried until the plug is disabled. */
export interface RetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  /** How long `enable` waits for the first attempt before returning a 'starting' status. */
  firstAttemptWaitMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { baseDelayMs: 1_000, maxDelayMs: 60_000, firstAttemptWaitMs: 20_000 };

export type PlugState = 'starting' | 'online' | 'retrying';

/** Delay before retry number `attempt` (1-based): base * 2^(attempt-1), capped at maxDelayMs. */
export function retryDelayMs(attempt: number, policy: RetryPolicy): number {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Resolves after `ms`, or as soon as the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Drives one plug's lifecycle: attempt start, back off on failure, stop retrying once online.
 * Dispose aborts any pending backoff and runs the teardown exactly once.
 * An attempt that finishes after dispose is torn down again, because it may have connected late.
 */
export class PlugRunner {
  public state: PlugState = 'starting';
  public error?: string;
  public attempts = 0;
  public nextRetryAt: number | undefined;

  private readonly abort = new AbortController();
  private readonly firstAttempt: Promise<void>;
  private markFirstAttempt!: () => void;
  private disposing?: Promise<void>;
  private tearingDown?: Promise<void>;

  public constructor(
    private readonly attempt: () => Promise<void>,
    private readonly stopOnce: () => Promise<void>,
    private readonly policy: RetryPolicy,
  ) {
    this.firstAttempt = new Promise((resolve) => { this.markFirstAttempt = resolve; });
  }

  /** Runs the teardown once, however many paths ask for it. */
  private teardown(): Promise<void> {
    this.tearingDown ??= this.stopOnce().catch(() => undefined);
    return this.tearingDown;
  }

  public start(): void {
    void this.loop();
  }

  /** Resolves when the first attempt succeeds or fails, or after firstAttemptWaitMs, whichever comes first. */
  public async waitForFirstAttempt(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, this.policy.firstAttemptWaitMs); });
    await Promise.race([this.firstAttempt, timeout]);
    clearTimeout(timer);
  }

  public dispose(): Promise<void> {
    this.disposing ??= (async () => {
      this.abort.abort();
      this.nextRetryAt = undefined;
      await this.teardown();
    })();
    return this.disposing;
  }

  private async loop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      this.state = 'starting';
      this.nextRetryAt = undefined;
      this.attempts += 1;
      try {
        await this.attempt();
        if (this.abort.signal.aborted) {
          await this.teardown();
          return;
        }
        this.state = 'online';
        delete this.error;
        this.markFirstAttempt();
        return;
      } catch (cause) {
        this.error = errorMessage(cause);
        this.markFirstAttempt();
        if (this.abort.signal.aborted) return;
        this.state = 'retrying';
        const delay = retryDelayMs(this.attempts, this.policy);
        this.nextRetryAt = Date.now() + delay;
        await sleep(delay, this.abort.signal);
      }
    }
  }
}
