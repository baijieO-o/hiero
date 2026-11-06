import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface TelemetryEvent {
  name: string;
  [field: string]: unknown;
}

/**
 * Structured JSONL event log with in-memory counters. Logging is best effort:
 * a failed write never affects the agent run.
 */
export class Telemetry {
  private readonly counters = new Map<string, number>();

  public constructor(private readonly file?: string | undefined, private readonly now: () => Date = () => new Date()) {
    if (file) {
      try {
        mkdirSync(dirname(file), { recursive: true });
      } catch {
        // Surfaced on the first failed append instead.
      }
    }
  }

  public record(event: TelemetryEvent): void {
    this.counters.set(event.name, (this.counters.get(event.name) ?? 0) + 1);
    if (!this.file) return;
    try {
      appendFileSync(this.file, JSON.stringify({ ts: this.now().toISOString(), ...event }) + '\n', 'utf8');
    } catch {
      // Logging must not break the run.
    }
  }

  public snapshot(): Record<string, number> {
    return Object.fromEntries([...this.counters.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
}
