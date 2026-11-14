import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { RUNTIME_WS_URL } from './runtime-url';
import { PanelHeader } from './panel-header';

export interface ManagedProcessInfo {
  id: string;
  command: string;
  cwd: string;
  origin: 'agent' | 'manual';
  status: 'running' | 'exited' | 'stopped';
  exitCode: number | null;
  startedAt: string;
  errorLines: number;
}

export interface ManagedProcessLine {
  stream: 'stdout' | 'stderr';
  text: string;
  error: boolean;
}

const STATUS_LABELS: Record<ManagedProcessInfo['status'], string> = { running: '运行中', exited: '已退出', stopped: '已停止' };
const ORIGIN_LABELS: Record<ManagedProcessInfo['origin'], string> = { agent: 'Agent', manual: '手动' };

/** Keeps one WebSocket open for the panel's lifetime and forwards process events to it. */
function useProcessSocket(onState: (processes: ManagedProcessInfo[]) => void, onOutput: (id: string, lines: ManagedProcessLine[]) => void) {
  const socketRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<string[]>([]);
  const handlers = useRef({ onState, onOutput });
  handlers.current = { onState, onOutput };

  useEffect(() => {
    const socket = new WebSocket(RUNTIME_WS_URL);
    socketRef.current = socket;
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'process_list' }));
      for (const message of pendingRef.current.splice(0)) socket.send(message);
    };
    socket.onmessage = (event) => {
      let message: { type?: string; payload?: { processes?: ManagedProcessInfo[]; id?: string; lines?: ManagedProcessLine[] } };
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.type === 'PROCESS_STATE' && message.payload?.processes) handlers.current.onState(message.payload.processes);
      if (message.type === 'PROCESS_OUTPUT' && message.payload?.lines) handlers.current.onOutput(message.payload.id ?? '', message.payload.lines);
    };
    return () => { socket.close(); socketRef.current = null; };
  }, []);

  return useCallback((message: object) => {
    const payload = JSON.stringify(message);
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(payload);
    else pendingRef.current.push(payload);
  }, []);
}

export function ProcessPanel(): ReactElement {
  const [processes, setProcesses] = useState<ManagedProcessInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [output, setOutput] = useState<ManagedProcessLine[]>([]);
  const [command, setCommand] = useState('');
  const [startError, setStartError] = useState<string | null>(null);

  const send = useProcessSocket(
    (next) => setProcesses(next),
    (id, lines) => {
      if (id === '') { setStartError(lines[0]?.text ?? '启动失败'); return; }
      setOutput(lines);
    },
  );

  // Output is pulled on demand: a status change only refreshes the list, and the open process is refreshed when it changes.
  useEffect(() => {
    if (!selected) { setOutput([]); return; }
    send({ type: 'process_output', id: selected });
    const timer = window.setInterval(() => send({ type: 'process_output', id: selected }), 1000);
    return () => window.clearInterval(timer);
  }, [selected, send]);

  const start = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = command.trim();
    if (!trimmed) return;
    setStartError(null);
    send({ type: 'process_start', command: trimmed, workspace: '' });
    setCommand('');
  };

  const current = processes.find((process) => process.id === selected) ?? null;

  return (
    <div className="process-panel">
      <PanelHeader eyebrow="进程" title="后台进程" />
      <form className="process-start" onSubmit={start}>
        <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="例如 npm run dev" aria-label="启动命令" />
        <button type="submit" disabled={!command.trim()}>启动</button>
      </form>
      {startError ? <p className="process-error">{startError}</p> : null}
      <div className="process-list">
        {processes.length === 0 ? <p className="process-empty">暂无进程。Agent 启动的命令和手动启动的命令都会显示在这里。</p> : null}
        {processes.map((process) => (
          <button
            key={process.id}
            type="button"
            className={`process-row${process.id === selected ? ' is-selected' : ''}`}
            onClick={() => setSelected(process.id)}
          >
            <span className={`process-status process-status-${process.status}`}>{STATUS_LABELS[process.status]}</span>
            <span className="process-command">{process.command}</span>
            <span className="process-origin">{ORIGIN_LABELS[process.origin]}</span>
            {process.errorLines > 0 ? <span className="process-errors">{process.errorLines} 个报错</span> : null}
          </button>
        ))}
      </div>
      {current ? (
        <div className="process-detail">
          <div className="process-detail-head">
            <code>{current.command}</code>
            {current.status === 'running' ? <button type="button" className="process-stop" onClick={() => send({ type: 'process_stop', id: current.id })}>停止</button> : null}
          </div>
          <pre className="process-output">
            {output.map((line, index) => (
              <span key={index} className={line.error ? 'process-line-error' : undefined}>{line.text}{'\n'}</span>
            ))}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
