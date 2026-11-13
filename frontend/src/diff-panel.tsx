import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { RUNTIME_WS_URL } from './runtime-url';
import { runtimeSocketFor } from './runtime-socket';
import { diffLines, diffStats } from './diff-model';
import { PanelHeader } from './panel-header';

interface FileDiffPayload { path: string; original: string; modified: string }

/** Keeps the earliest original and latest modified text per path, so repeated edits in one task read as one change. */
function mergeDiff(current: FileDiffPayload[], next: FileDiffPayload): FileDiffPayload[] {
  const existing = current.find((item) => item.path === next.path);
  if (!existing) return [...current, next];
  return current.map((item) => (item.path === next.path ? { ...item, modified: next.modified } : item));
}

export function DiffPanel(): ReactElement {
  const [files, setFiles] = useState<FileDiffPayload[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const socket = runtimeSocketFor(RUNTIME_WS_URL);
    // A new task starts with a clean list, so earlier changes do not pile up.
    const unsubscribeReset = socket.subscribe('FILE_DIFF_RESET', () => { setFiles([]); setSelected(null); });
    const unsubscribe = socket.subscribe('FILE_DIFF', (message) => {
      const payload = message.payload as unknown as FileDiffPayload | undefined;
      if (!payload?.path) return;
      setFiles((current) => mergeDiff(current, payload));
      setSelected((current) => current ?? payload.path);
    });
    return () => { unsubscribe(); unsubscribeReset(); };
  }, []);

  const activePath = selected && files.some((file) => file.path === selected) ? selected : files[0]?.path ?? null;
  const active = files.find((file) => file.path === activePath) ?? null;
  const lines = useMemo(() => (active ? diffLines(active.original, active.modified) : []), [active]);
  const stats = diffStats(lines);

  return (
    <section className="panel-content diff-panel">
      <PanelHeader eyebrow="变更" title="变更审阅" />
      {files.length === 0 ? (
        <p className="diff-empty">本次任务还没有文件改动。Agent 写入文件后会显示在这里。</p>
      ) : (
        <div className="diff-body">
          <ul className="diff-files" aria-label="改动文件">
            {files.map((file) => (
              <li key={file.path}>
                <button type="button" className={file.path === activePath ? 'active' : ''} onClick={() => setSelected(file.path)}>
                  {file.path}
                </button>
              </li>
            ))}
          </ul>
          {active ? (
            <div className="diff-view">
              <div className="diff-title">{active.path} <span className="diff-add">+{stats.added}</span> <span className="diff-del">-{stats.removed}</span></div>
              <pre className="diff-lines">
                {lines.map((line, index) => (
                  <div key={index} className={`diff-line diff-${line.kind}`}>
                    <span className="diff-mark">{line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}</span>
                    <span>{line.text}</span>
                  </div>
                ))}
              </pre>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
