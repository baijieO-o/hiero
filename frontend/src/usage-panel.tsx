import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { RUNTIME_WS_URL } from './runtime-url';
import { estimateCostUsd, formatCost } from './token-cost';
import { PanelHeader } from './panel-header';

export interface UsageMessageLike {
  usage?: { input_tokens: number; output_tokens: number; calls: number };
  model?: string;
  completedAt?: number;
}

export interface UsageConversationLike {
  messages: UsageMessageLike[];
}

export interface ModelRow {
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  costUsd: number | undefined;
}

export interface RangeSummary {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  costUsd: number | undefined;
  models: ModelRow[];
}

export type UsageRange = 'today' | '7d' | 'all';

const RANGE_MS: Record<Exclude<UsageRange, 'all'>, number> = { today: 0, '7d': 7 * 24 * 60 * 60 * 1000 };

/** Start of the window. "today" means local midnight, so it matches the user's calendar day. */
export function rangeStart(range: UsageRange, now: number): number {
  if (range === 'all') return 0;
  if (range === 'today') {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return midnight.getTime();
  }
  return now - RANGE_MS[range];
}

/** Aggregates per-reply usage from local conversations within a time window, grouped by model. */
export function summarizeConversations(conversations: UsageConversationLike[], start: number): RangeSummary {
  const byModel = new Map<string, { calls: number; input_tokens: number; output_tokens: number }>();
  for (const conversation of conversations) {
    for (const message of conversation.messages) {
      if (!message.usage || message.completedAt === undefined || message.completedAt < start) continue;
      const model = message.model || 'unknown';
      const row = byModel.get(model) ?? { calls: 0, input_tokens: 0, output_tokens: 0 };
      row.calls += message.usage.calls;
      row.input_tokens += message.usage.input_tokens;
      row.output_tokens += message.usage.output_tokens;
      byModel.set(model, row);
    }
  }
  const models: ModelRow[] = [...byModel.entries()]
    .map(([model, row]) => ({ model, ...row, costUsd: estimateCostUsd(row, model === 'unknown' ? undefined : model) }))
    .sort((a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens));
  const costs = models.map((row) => row.costUsd);
  const costUsd = costs.some((cost) => cost === undefined) ? undefined : costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
  return {
    calls: models.reduce((sum, row) => sum + row.calls, 0),
    input_tokens: models.reduce((sum, row) => sum + row.input_tokens, 0),
    output_tokens: models.reduce((sum, row) => sum + row.output_tokens, 0),
    costUsd: models.length === 0 ? 0 : costUsd,
    models,
  };
}

interface BackendStats {
  total: { calls: number; failed: number; input_tokens: number; output_tokens: number };
  models: Array<{ model: string; calls: number; failed: number; input_tokens: number; output_tokens: number }>;
}

/** Asks the backend for telemetry totals. Resolves null when the backend is unreachable or has no log. */
function requestBackendStats(): Promise<BackendStats | null> {
  return new Promise((resolve) => {
    const socket = new WebSocket(RUNTIME_WS_URL);
    const requestId = `usage-stats-${Date.now()}`;
    const finish = (value: BackendStats | null) => { resolve(value); socket.close(); };
    socket.onopen = () => socket.send(JSON.stringify({ type: 'usage_stats', request_id: requestId }));
    socket.onerror = () => finish(null);
    socket.onmessage = (event) => {
      let message: { type?: string; payload?: BackendStats & { request_id?: string } };
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.type !== 'USAGE_STATS' || message.payload?.request_id !== requestId) return;
      finish(message.payload);
    };
  });
}

function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

const RANGE_LABELS: Record<UsageRange, string> = { today: '今天', '7d': '近 7 天', all: '全部' };

export function UsagePanel({ conversations }: { conversations: UsageConversationLike[] }): ReactElement {
  const [range, setRange] = useState<UsageRange>('7d');
  const [backend, setBackend] = useState<BackendStats | null | 'loading'>('loading');
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    requestBackendStats().then((stats) => { if (active) setBackend(stats); });
    return () => { active = false; };
  }, []);

  const summary = useMemo(() => summarizeConversations(conversations, rangeStart(range, now)), [conversations, range, now]);

  return (
    <div className="usage-panel">
      <PanelHeader eyebrow="用量" title="成本 / 用量" />
      <div className="usage-range" role="group" aria-label="时间范围">
        {(Object.keys(RANGE_LABELS) as UsageRange[]).map((key) => (
          <button key={key} type="button" className={range === key ? 'is-active' : ''} onClick={() => setRange(key)}>{RANGE_LABELS[key]}</button>
        ))}
      </div>
      <section className="usage-summary">
        <div><span>模型调用</span><strong>{summary.calls}</strong></div>
        <div><span>输入 tokens</span><strong>{formatTokens(summary.input_tokens)}</strong></div>
        <div><span>输出 tokens</span><strong>{formatTokens(summary.output_tokens)}</strong></div>
        <div><span>估算成本</span><strong>{formatCost(summary.costUsd)}</strong></div>
      </section>
      <h3>按模型（对话记录）</h3>
      {summary.models.length === 0
        ? <p className="usage-empty">该时间范围内没有对话用量。</p>
        : (
          <table className="usage-table">
            <thead><tr><th>模型</th><th>调用</th><th>输入</th><th>输出</th><th>成本</th></tr></thead>
            <tbody>
              {summary.models.map((row) => (
                <tr key={row.model}><td>{row.model}</td><td>{row.calls}</td><td>{formatTokens(row.input_tokens)}</td><td>{formatTokens(row.output_tokens)}</td><td>{formatCost(row.costUsd)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      <h3>后端全量（遥测日志）</h3>
      {backend === 'loading' && <p className="usage-empty">读取中…</p>}
      {backend === null && <p className="usage-empty">无法读取后端统计：后端未运行，或未配置遥测日志（logging.file）。</p>}
      {backend && backend !== 'loading' && (
        backend.models.length === 0
          ? <p className="usage-empty">遥测日志中还没有模型调用记录。</p>
          : (
            <table className="usage-table">
              <thead><tr><th>模型</th><th>调用</th><th>失败</th><th>输入</th><th>输出</th></tr></thead>
              <tbody>
                {backend.models.map((row) => (
                  <tr key={row.model}><td>{row.model}</td><td>{row.calls}</td><td>{row.failed}</td><td>{formatTokens(row.input_tokens)}</td><td>{formatTokens(row.output_tokens)}</td></tr>
                ))}
              </tbody>
            </table>
          )
      )}
      <p className="usage-note">成本为按公开单价的估算，不代表实际账单。</p>
    </div>
  );
}
