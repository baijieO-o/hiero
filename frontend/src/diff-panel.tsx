import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { RUNTIME_WS_URL } from './runtime-url';
import { runtimeSocketFor } from './runtime-socket';
import { diffLines, diffStats } from './diff-model';
import { PanelHeader } from './panel-header';

interface FileDiffPayload { path: string; original: string; modified: string; workspace: string }

/** Reverts one file through the backend. Files a human edited since are kept and reported back. */
function revertFile(file: FileDiffPayload): Promise<string> {
  return new Promise((resolve) => {
    const socket = new WebSocket(RUNTIME_WS_URL);
    const finish = (text: string) => { resolve(text); socket.close(); };
    socket.onopen = () => socket.send(JSON.stringify({ type: 'file_revert', workspace: file.workspace, path: file.path }));
    socket.onerror = () => finish('还原失败：无法连接后端。');
    socket.onmessage = (event) => {
      let message: { type?: string; payload?: { path?: string; ok?: boolean; status?: string; message?: string } };
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.type !== 'FILE_REVERT_RESULT' || message.payload?.path !== file.path) return;
      if (!message.payload.ok) finish(`还原失败：${message.payload.message ?? '未知错误'}`);
      else if (message.payload.status === 'skipped') finish('已保留：该文件在 agent 写入后被人工修改过。');
      else finish('已还原。');
    };
  });
}

/** Keeps the earliest original and latest modified text per path, so repeated edits in one task read as one change. */
function mergeDiff(current: FileDiffPayload[], next: FileDiffPayload): FileDiffPayload[] {
  const existing = current.find((item) => item.path === next.path);
  if (!existing) return [...current, next];
  return current.map((item) => (item.path === next.path ? { ...item, modified: next.modified } : item));
}

/** Sends a worktree merge or remove request and resolves with the backend's reply. */
export function requestWorktreeAction(type: 'worktree_merge' | 'worktree_remove', workspace: string, conversationId: string, force = false): Promise<{ ok: boolean; message?: string; outcome?: MergeOutcomePayload }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(RUNTIME_WS_URL);
    const finish = (value: { ok: boolean; message?: string; outcome?: MergeOutcomePayload }) => { resolve(value); socket.close(); };
    socket.onopen = () => socket.send(JSON.stringify({ type, workspace, conversation_id: conversationId, ...(force ? { force: true } : {}) }));
    socket.onerror = () => finish({ ok: false, message: '无法连接后端。' });
    socket.onmessage = (event) => {
      let message: { type?: string; payload?: { action?: string; conversation_id?: string; ok?: boolean; message?: string; outcome?: MergeOutcomePayload } };
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.type !== 'WORKTREE_RESULT' || message.payload?.conversation_id !== conversationId || message.payload.action !== type) return;
      finish({ ok: message.payload.ok === true, ...(message.payload.message ? { message: message.payload.message } : {}), ...(message.payload.outcome ? { outcome: message.payload.outcome } : {}) });
    };
  });
}

type MergeOutcomePayload = { status: 'merged' } | { status: 'nothing' } | { status: 'conflict'; files: string[] };

function mergeNotice(result: { ok: boolean; message?: string; outcome?: MergeOutcomePayload }): string {
  if (!result.ok) return `合并失败：${result.message ?? '未知错误'}`;
  if (result.outcome?.status === 'merged') return '已合并到主分支。';
  if (result.outcome?.status === 'nothing') return '没有需要合并的改动。';
  if (result.outcome?.status === 'conflict') return `存在冲突，已取消合并。冲突文件：${result.outcome.files.join('、')}`;
  return '合并完成。';
}

export function DiffPanel(): ReactElement {
  const [files, setFiles] = useState<FileDiffPayload[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [worktree, setWorktree] = useState<{ conversationId: string; workspace: string; path: string } | null>(null);

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
    const unsubscribeWorktree = socket.subscribe('WORKTREE_STATE', (message) => {
      const payload = message.payload as unknown as { conversation_id?: string; workspace?: string; path?: string } | undefined;
      if (!payload?.conversation_id || !payload.workspace || !payload.path) return;
      setWorktree({ conversationId: payload.conversation_id, workspace: payload.workspace, path: payload.path });
    });
    return () => { unsubscribe(); unsubscribeReset(); unsubscribeWorktree(); };
  }, []);

  const merge = async () => {
    if (!worktree) return;
    setBusy(true);
    setNotice(null);
    const result = await requestWorktreeAction('worktree_merge', worktree.workspace, worktree.conversationId);
    setBusy(false);
    setNotice(mergeNotice(result));
  };

  const activePath = selected && files.some((file) => file.path === selected) ? selected : files[0]?.path ?? null;
  const active = files.find((file) => file.path === activePath) ?? null;
  const lines = useMemo(() => (active ? diffLines(active.original, active.modified) : []), [active]);
  const stats = diffStats(lines);

  const revert = async () => {
    if (!active) return;
    setBusy(true);
    setNotice(null);
    const text = await revertFile(active);
    setBusy(false);
    setNotice(text);
    if (text === '已还原。') setFiles((current) => current.filter((file) => file.path !== active.path));
  };

  return (
    <section className="panel-content diff-panel">
      <PanelHeader eyebrow="变更" title="变更审阅" />
      {worktree ? (
        <div className="diff-worktree-bar">
          <span>隔离工作树：{worktree.path === worktree.workspace ? '（未隔离，直接修改主目录）' : worktree.path}</span>
          {worktree.path !== worktree.workspace ? <button type="button" className="diff-revert" onClick={merge} disabled={busy}>{busy ? '合并中…' : '合并到主分支'}</button> : null}
        </div>
      ) : null}
      {notice && files.length === 0 ? <p className="diff-notice" role="status">{notice}</p> : null}
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
              <div className="diff-title">
                {active.path} <span className="diff-add">+{stats.added}</span> <span className="diff-del">-{stats.removed}</span>
                <button type="button" className="diff-revert" onClick={revert} disabled={busy}>{busy ? '还原中…' : '还原此文件'}</button>
              </div>
              {notice ? <p className="diff-notice" role="status">{notice}</p> : null}
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
