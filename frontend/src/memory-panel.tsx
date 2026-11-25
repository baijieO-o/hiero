import { useEffect, useState, type ReactElement } from 'react';
import { requestWorkspace, type MemoryScope } from './workspace-request';

const MEMORY_SCOPE_LABELS: Record<MemoryScope, string> = { global: '全局准则', project: '项目记忆' };

type DeepMemoryEntry = { id: string; scope: MemoryScope; content: string; tags: string[]; created_at: string; source?: 'user' | 'inferred'; session_id?: string; enabled?: boolean };

function DeepMemoryBuffer({ workspaceRoot }: { workspaceRoot: string | undefined }): ReactElement {
  const [entries, setEntries] = useState<DeepMemoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    requestWorkspace({ type: 'deep_memory_list', workspace: workspaceRoot })
      .then((payload) => { setEntries(payload.entries as DeepMemoryEntry[]); setError(null); })
      .catch((cause: Error) => setError(cause.message));
  };

  useEffect(refresh, [workspaceRoot]);

  const act = (request: Parameters<typeof requestWorkspace>[0]) => {
    requestWorkspace({ ...request, workspace: workspaceRoot }).then(refresh).catch((cause: Error) => setError(cause.message));
  };

  const remove = (entry: DeepMemoryEntry) => {
    if (!window.confirm('删除会移除这条记忆在记忆文件中的副本，不会清除备份、Git 历史或聊天记录中的内容。确定删除？')) return;
    act({ type: 'deep_memory_delete', scope: entry.scope, id: entry.id });
  };

  const edit = (entry: DeepMemoryEntry) => {
    const next = window.prompt('修改这条记忆的内容：', entry.content);
    if (next === null || !next.trim() || next.trim() === entry.content) return;
    act({ type: 'deep_memory_update', scope: entry.scope, id: entry.id, content: next.trim() });
  };

  return (
    <div className="skills-panel">
      <div className="skills-main">
        <div className="skills-editor">
          <div className="skills-editor-head">
            <span>深层记忆（第 2 层）· {entries.length} 条</span>
            <button type="button" onClick={refresh}>刷新</button>
          </div>
          <ul aria-label="深层记忆列表">
            {entries.map((entry) => {
              const enabled = entry.enabled !== false;
              return (
                <li key={entry.id}>
                  <small>
                    {entry.scope === 'global' ? '全局' : '项目'} · {entry.source === 'inferred' ? '系统推断' : '用户告知'}
                    {entry.session_id ? ' · 仅本次会话' : ''}
                    {!enabled ? ' · 已停用' : ''}
                    {' · '}{entry.created_at.slice(0, 16).replace('T', ' ')}{entry.tags.length ? ` · ${entry.tags.join(', ')}` : ''}
                  </small>
                  <p>{entry.content}</p>
                  <button type="button" onClick={() => act({ type: 'deep_memory_set_enabled', scope: entry.scope, id: entry.id, enabled: !enabled })}>{enabled ? '停用' : '启用'}</button>
                  <button type="button" onClick={() => edit(entry)}>编辑</button>
                  <button type="button" onClick={() => remove(entry)}>删除</button>
                </li>
              );
            })}
          </ul>
          {entries.length === 0 && <p className="skills-status">还没有深层记忆。模型可通过 memory_remember 写入，或在对话中让它记住事情。</p>}
          {error && <p className="skills-error">{error}</p>}
        </div>
      </div>
    </div>
  );
}

export function MemoryBuffer({ workspaceRoot }: { workspaceRoot: string | undefined }): ReactElement {
  const [scope, setScope] = useState<MemoryScope | 'deep'>('global');
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState('');
  const [path, setPath] = useState('');
  const [limit, setLimit] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (scope === 'deep') return;
    setError(null);
    setStatus(null);
    requestWorkspace({ type: 'memory_read', scope })
      .then((payload) => {
        const memory = payload.memory as { content: string; path: string; limit: number };
        setDraft(memory.content);
        setSaved(memory.content);
        setPath(memory.path);
        setLimit(memory.limit);
      })
      .catch((cause: Error) => setError(cause.message));
  }, [scope]);

  const dirty = draft !== saved;
  const overLimit = draft.length > limit;

  const save = () => {
    if (scope === 'deep') return;
    requestWorkspace({ type: 'memory_save', scope, content: draft })
      .then(() => { setSaved(draft); setError(null); setStatus('已保存'); })
      .catch((cause: Error) => setError(cause.message));
  };

  return (
    <div className="skills-panel">
      <nav className="skills-categories" aria-label="记忆范围">
        {(Object.keys(MEMORY_SCOPE_LABELS) as MemoryScope[]).map((item) => (
          <button key={item} type="button" className={item === scope ? 'active' : ''} onClick={() => setScope(item)}>
            <span>{MEMORY_SCOPE_LABELS[item]}</span>
          </button>
        ))}
        <button type="button" className={scope === 'deep' ? 'active' : ''} onClick={() => setScope('deep')}>
          <span>深层记忆</span>
        </button>
      </nav>
      {scope === 'deep' ? <DeepMemoryBuffer workspaceRoot={workspaceRoot} /> : <div className="skills-main">
        <div className="skills-editor">
          <div className="skills-editor-head">
            <span>{path}</span>
            <span>{draft.length}/{limit} 字符</span>
            <button type="button" onClick={save} disabled={!dirty || overLimit}>保存</button>
          </div>
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} aria-label="记忆内容" placeholder="写入后会在每次规划时注入给模型。" />
          {overLimit && <p className="skills-error">超过上限，请精简（MEM-001）。</p>}
          {status && <p className="skills-status">{status}</p>}
          {error && <p className="skills-error">{error}</p>}
        </div>
      </div>}
    </div>
  );
}
