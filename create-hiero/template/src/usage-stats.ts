import { readFileSync } from 'node:fs';

export interface ModelUsageTotals {
  model: string;
  calls: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
}

export interface DailyUsage {
  date: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
}

export interface UsageStats {
  total: Omit<ModelUsageTotals, 'model'>;
  models: ModelUsageTotals[];
  daily: DailyUsage[];
}

/** Summarizes `model.call` telemetry lines. Malformed lines are skipped, since the log is best effort. */
export function summarizeModelCalls(lines: readonly string[], sinceMs = 0): UsageStats {
  const byModel = new Map<string, ModelUsageTotals>();
  const byDay = new Map<string, DailyUsage>();
  for (const line of lines) {
    let event: { name?: unknown; ts?: unknown; model?: unknown; ok?: unknown; inputTokens?: unknown; outputTokens?: unknown };
    try { event = JSON.parse(line) as typeof event; } catch { continue; }
    if (event.name !== 'model.call' || typeof event.ts !== 'string') continue;
    const at = Date.parse(event.ts);
    if (Number.isNaN(at) || at < sinceMs) continue;
    const model = typeof event.model === 'string' && event.model ? event.model : 'unknown';
    const input = typeof event.inputTokens === 'number' ? event.inputTokens : 0;
    const output = typeof event.outputTokens === 'number' ? event.outputTokens : 0;
    const failed = event.ok === false ? 1 : 0;
    const row = byModel.get(model) ?? { model, calls: 0, failed: 0, input_tokens: 0, output_tokens: 0 };
    row.calls += 1; row.failed += failed; row.input_tokens += input; row.output_tokens += output;
    byModel.set(model, row);
    const date = event.ts.slice(0, 10);
    const day = byDay.get(date) ?? { date, calls: 0, input_tokens: 0, output_tokens: 0 };
    day.calls += 1; day.input_tokens += input; day.output_tokens += output;
    byDay.set(date, day);
  }
  const models = [...byModel.values()].sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model));
  const total = models.reduce((sum, row) => ({
    calls: sum.calls + row.calls, failed: sum.failed + row.failed,
    input_tokens: sum.input_tokens + row.input_tokens, output_tokens: sum.output_tokens + row.output_tokens,
  }), { calls: 0, failed: 0, input_tokens: 0, output_tokens: 0 });
  const daily = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { total, models, daily };
}

/** Reads the telemetry file. A missing or unreadable file yields empty stats rather than an error. */
export function readUsageStats(file: string | undefined, sinceMs = 0): UsageStats {
  if (!file) return summarizeModelCalls([], sinceMs);
  try {
    return summarizeModelCalls(readFileSync(file, 'utf8').split('\n'), sinceMs);
  } catch {
    return summarizeModelCalls([], sinceMs);
  }
}
