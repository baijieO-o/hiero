import { useEffect, useState } from 'react';
import { RUNTIME_WS_URL } from './runtime-url';
import { runtimeSocketFor } from './runtime-socket';

type Stats = { cpuPercent: number; memPercent: number; gpuPercent: number | null };

function formatPercent(value: number | null | undefined): string {
  return typeof value === 'number' ? `${Math.round(value)}%` : '—';
}

/** Footer widget: CPU / memory / GPU utilization from the backend, plus a live local clock. */
export function SystemStatus() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const unsubscribe = runtimeSocketFor(RUNTIME_WS_URL).subscribe('SYSTEM_STATS', (message) => {
      const payload = message.payload as Partial<Stats> | undefined;
      if (!payload || typeof payload.cpuPercent !== 'number') return;
      setStats({
        cpuPercent: payload.cpuPercent,
        memPercent: typeof payload.memPercent === 'number' ? payload.memPercent : 0,
        gpuPercent: typeof payload.gpuPercent === 'number' ? payload.gpuPercent : null,
      });
    });
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="system-status" title="CPU / 内存 / GPU 占用率">
      <span>CPU {formatPercent(stats?.cpuPercent)}</span>
      <span>MEM {formatPercent(stats?.memPercent)}</span>
      <span>GPU {formatPercent(stats?.gpuPercent)}</span>
      <time dateTime={now.toISOString()}>{now.toLocaleTimeString()}</time>
    </div>
  );
}
