import { lazy, Suspense, useEffect, useRef, useState, type FormEvent as ReactFormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import type { TerminalWriteLine } from './terminal-view';
import { requestWorkspace } from './workspace-request';

const LazyTerminalView = lazy(() => import('./terminal-view').then((module) => ({ default: module.TerminalView })));

type TerminalLine = TerminalWriteLine;

type TerminalTab = { id: number; title: string };

export function TerminalBuffer({ workspace, getActiveRoot }: { workspace: string | undefined; getActiveRoot: () => string | undefined }): ReactElement {
  const nextId = useRef(2);
  const [tabs, setTabs] = useState<TerminalTab[]>([{ id: 1, title: 'Windows PowerShell' }]);
  const [activeId, setActiveId] = useState(1);
  const addTab = () => {
    const id = nextId.current++;
    setTabs((current) => [...current, { id, title: 'Windows PowerShell' }]);
    setActiveId(id);
  };
  const dragId = useRef<number | null>(null);
  const moveTab = (fromId: number, toId: number) => {
    if (fromId === toId) return;
    setTabs((current) => {
      const from = current.findIndex((tab) => tab.id === fromId);
      const to = current.findIndex((tab) => tab.id === toId);
      if (from < 0 || to < 0) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };
  const closeTab = (id: number) => {
    if (tabs.length === 1) return;
    const index = tabs.findIndex((tab) => tab.id === id);
    const remaining = tabs.filter((tab) => tab.id !== id);
    setTabs(remaining);
    if (id === activeId) setActiveId(remaining[Math.max(0, index - 1)].id);
  };
  return <section className="panel-content terminal-panel">
    <div className="wt-titlebar" role="tablist">
      {tabs.map((tab) => <div key={tab.id} className="wt-tab" role="tab" tabIndex={0} draggable aria-selected={tab.id === activeId} data-active={tab.id === activeId} onClick={() => setActiveId(tab.id)} onKeyDown={(event) => { if (event.key === 'Enter') setActiveId(tab.id); }}
        onDragStart={(event) => { dragId.current = tab.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(tab.id)); }}
        onDragOver={(event) => { if (dragId.current !== null) event.preventDefault(); }}
        onDrop={(event) => { event.preventDefault(); if (dragId.current !== null) moveTab(dragId.current, tab.id); dragId.current = null; }}
        onDragEnd={() => { dragId.current = null; }}>
        <span className="wt-tab-icon">PS</span><span className="wt-tab-title">{tab.title}</span>
        {tabs.length > 1 && <button type="button" className="wt-tab-close" aria-label="关闭标签" onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }}>✕</button>}
      </div>)}
      <button type="button" className="wt-new-tab" onClick={addTab} aria-label="新建标签" title="新建标签">+</button>
    </div>
    {tabs.map((tab) => <TerminalSession key={tab.id} hidden={tab.id !== activeId} workspace={workspace} getActiveRoot={getActiveRoot} />)}
  </section>;
}

function TerminalSession({ hidden, workspace, getActiveRoot }: { hidden: boolean; workspace: string | undefined; getActiveRoot: () => string | undefined }): ReactElement {
  const [command, setCommand] = useState('');
  const [lines, setLines] = useState<TerminalLine[]>([{ kind: 'banner', text: 'Windows PowerShell\n命令在工作区根目录一次性执行（非交互式）。' }]);
  const [running, setRunning] = useState(false);
  const [root, setRoot] = useState('');
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const prompt = `PS ${root}>`;
  useEffect(() => {
    requestWorkspace({ type: 'fs_list', path: '', workspace: getActiveRoot() }).then((payload) => { if (typeof payload.root === 'string') setRoot(payload.root); }).catch(() => undefined);
  }, [workspace]);
  useEffect(() => { if (!hidden) inputRef.current?.focus(); }, [hidden]);
  const run = (event: ReactFormEvent) => {
    event.preventDefault();
    const text = command.trim();
    if (!text || running) return;
    setRunning(true);
    setCommand('');
    setHistoryIndex(null);
    setCommandHistory((current) => [...current, text]);
    requestWorkspace({ type: 'term_exec', command: text, permission: '标准', workspace: getActiveRoot() })
      .then((payload) => {
        if (typeof payload.root === 'string') setRoot(payload.root);
        const body = String(payload.output ?? '').replace(/\s+$/, '');
        const failed = payload.timedOut === true || payload.exitCode !== 0;
        const status = payload.timedOut === true ? '命令已超时并终止' : payload.exitCode === 0 ? '' : `退出代码 ${String(payload.exitCode)}`;
        setLines((current) => [...current, ...(body ? [{ kind: 'output' as const, text: body, failed }] : []), ...(status ? [{ kind: 'output' as const, text: status, failed: true }] : [])]);
      })
      .catch((cause: Error) => setLines((current) => [...current, { kind: 'output', text: cause.message, failed: true }]))
      .finally(() => { setRunning(false); inputRef.current?.focus(); });
    setLines((current) => [...current, { kind: 'command', prompt, text }]);
  };
  const recall = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    if (commandHistory.length === 0) return;
    const next = event.key === 'ArrowUp'
      ? Math.max(0, (historyIndex ?? commandHistory.length) - 1)
      : (historyIndex === null ? null : historyIndex + 1 >= commandHistory.length ? null : historyIndex + 1);
    setHistoryIndex(next);
    setCommand(next === null ? '' : commandHistory[next] ?? '');
  };
  return <div className="terminal-session" hidden={hidden}>
    <Suspense fallback={null}><LazyTerminalView lines={lines} hidden={hidden} onActivate={() => inputRef.current?.focus()} /></Suspense>
    <form className="terminal-input" onSubmit={run}>
      <span className="wt-prompt">{running ? '' : prompt}</span>
      <input ref={inputRef} value={command} onChange={(event) => { setCommand(event.target.value); setHistoryIndex(null); }} onKeyDown={recall} placeholder={running ? '执行中……' : ''} aria-label="终端命令" disabled={running} autoComplete="off" spellCheck={false} />
    </form>
  </div>;
}
