import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';

export interface ScheduledTaskView {
  id: string;
  name: string;
  goal: string;
  interval_minutes: number;
  enabled: boolean;
  last_run_at?: string;
  last_task_id?: string;
  last_status?: 'completed' | 'failed';
  last_summary?: string;
  next_run_at: string;
}

interface ScheduleState {
  status: 'idle' | 'error';
  message?: string;
  tasks: ScheduledTaskView[];
}

function formatScheduleTime(iso: string | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function ScheduleForm({ onCreate }: { onCreate: (input: { name: string; goal: string; interval_minutes: number; run_now: boolean }) => void }): ReactElement {
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [interval, setInterval] = useState('60');
  const [runNow, setRunNow] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!goal.trim()) return;
    onCreate({ name: name.trim(), goal: goal.trim(), interval_minutes: Number(interval), run_now: runNow });
    setName('');
    setGoal('');
  };
  return <form className="settings-schedule-form" onSubmit={submit}>
    <label className="settings-row">
      <span><strong>名称</strong><small>可选，留空则使用 prompt 前 40 个字</small></span>
      <input value={name} onChange={(event) => setName(event.target.value)} aria-label="定时任务名称" />
    </label>
    <label className="settings-row">
      <span><strong>Prompt</strong><small>每次触发时发送给 agent 的内容</small></span>
      <textarea value={goal} onChange={(event) => setGoal(event.target.value)} rows={3} required aria-label="定时任务 prompt" />
    </label>
    <label className="settings-row">
      <span><strong>间隔（分钟）</strong><small>1–43200 之间的整数</small></span>
      <input type="number" value={interval} min={1} max={43200} onChange={(event) => setInterval(event.target.value)} aria-label="定时任务间隔" />
    </label>
    <label className="settings-row">
      <span><strong>添加时立即执行一次</strong><small>勾选后马上运行一次，之后按间隔继续</small></span>
      <input type="checkbox" checked={runNow} onChange={(event) => setRunNow(event.target.checked)} aria-label="添加时立即执行一次" />
    </label>
    <button type="submit" className="primary-button" disabled={!goal.trim()}>添加定时任务</button>
  </form>;
}

export function SchedulesPanel({ wsUrl }: { wsUrl: string }): ReactElement {
  const [state, setState] = useState<ScheduleState>({ status: 'idle', tasks: [] });
  const socketRef = useRef<WebSocket | null>(null);

  const send = (request: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setState((current) => ({ ...current, status: 'error', message: '未连接到后端（localhost:8080），请先启动后端。' }));
      return;
    }
    socket.send(JSON.stringify({ type: 'SCHEDULE', ...request }));
  };

  useEffect(() => {
    let active = true;
    const socket = new WebSocket(wsUrl);
    socketRef.current = socket;
    socket.onopen = () => {
      if (active) socket.send(JSON.stringify({ type: 'SCHEDULE', action: 'list' }));
    };
    socket.onmessage = (event) => {
      if (!active) return;
      try {
        const message = JSON.parse(String(event.data)) as { type: string; payload?: unknown };
        if (message.type === 'SCHEDULES') {
          const result = message.payload as { ok: boolean; message?: string; tasks: ScheduledTaskView[] };
          setState({ status: result.ok ? 'idle' : 'error', message: result.message, tasks: result.tasks });
        }
      } catch { /* Ignore non-JSON runtime messages. */ }
    };
    socket.onerror = () => {
      if (active) setState((current) => ({ ...current, status: 'error', message: '未连接到后端（localhost:8080），请先启动后端。' }));
    };
    return () => {
      active = false;
      socketRef.current = null;
      socket.close();
    };
  }, [wsUrl]);

  return <section className="panel-content">
    <div className="settings-domain">
      <h3>定时任务</h3>
      <p className="settings-hint">按固定间隔自动发送 prompt 给 agent，运行结果写入任务历史。任务保存在 ~/.hiero/schedules.json，重启后保留。</p>
      <ScheduleForm onCreate={(input) => send({ action: 'create', payload: input })} />
      {state.status === 'error' && <p className="settings-error">{state.message}</p>}
      {state.tasks.length === 0 && <p className="chat-empty">还没有定时任务。</p>}
      <ul className="settings-schedule-list">
        {state.tasks.map((task) => <li key={task.id} className="settings-row">
          <span>
            <strong>{task.name}</strong>
            <small>每 {task.interval_minutes} 分钟 · {task.enabled ? `下次 ${formatScheduleTime(task.next_run_at)}` : '已暂停'} · 上次 {formatScheduleTime(task.last_run_at)}</small>
            <small>{task.goal}</small>
            {task.last_status && <small>上次结果：{task.last_status === 'completed' ? '完成' : '失败'}{task.last_task_id ? ` · 任务 ${task.last_task_id.slice(0, 8)}` : ''}</small>}
            {task.last_summary && <details className="settings-schedule-report">
              <summary>查看汇报</summary>
              <pre>{task.last_summary}</pre>
            </details>}
          </span>
          <span className="settings-schedule-actions">
            <button type="button" className="ghost-button" onClick={() => send({ action: 'toggle', id: task.id })}>{task.enabled ? '暂停' : '启用'}</button>
            <button type="button" className="ghost-button" onClick={() => send({ action: 'delete', id: task.id })}>删除</button>
          </span>
        </li>)}
      </ul>
    </div>
  </section>;
}
