import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import { requestWorkspace } from './workspace-request';

interface WorkspaceEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  size: number;
  modified: number;
}

let openPanelHandler: ((kind: 'files') => void) | null = null;
let pendingFileOpen: string | null = null;
export function setOpenPanelHandler(handler: ((kind: 'files') => void) | null): void {
  openPanelHandler = handler;
}

const fileOpenListeners = new Set<(path: string) => void>();

export function requestOpenFile(path: string): void {
  pendingFileOpen = path;
  if (fileOpenListeners.size > 0) {
    fileOpenListeners.forEach((listener) => listener(path));
    pendingFileOpen = null;
    return;
  }
  openPanelHandler?.('files');
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatModified(ms: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

type FileSortKey = 'name' | 'size' | 'modified';

export function FileManagerBuffer({ workspaceRoot }: { workspaceRoot: string | undefined }): ReactElement {
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [selected, setSelected] = useState<WorkspaceEntry | null>(null);
  const [content, setContent] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [binary, setBinary] = useState(false);
  const [previewSize, setPreviewSize] = useState(0);
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<FileSortKey>('name');
  const [sortDesc, setSortDesc] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const previewRequest = useRef(0);
  const listRequest = useRef(0);
  const tableRef = useRef<HTMLDivElement>(null);

  const readFile = (entry: WorkspaceEntry) => {
    const requestId = ++previewRequest.current;
    setSelected(entry);
    setError(null);
    setContent('');
    setTruncated(false);
    setBinary(false);
    setPreviewLoading(true);
    requestWorkspace({ type: 'fs_read', path: entry.path })
      .then((payload) => {
        if (requestId !== previewRequest.current) return;
        setContent(String(payload.content ?? ''));
        setTruncated(payload.truncated === true);
        setBinary(payload.binary === true);
        setPreviewSize(Number(payload.size ?? entry.size));
      })
      .catch((cause: Error) => { if (requestId === previewRequest.current) setError(cause.message); })
      .finally(() => { if (requestId === previewRequest.current) setPreviewLoading(false); });
  };

  const load = (nextPath: string, thenRead?: string) => {
    const requestId = ++listRequest.current;
    setError(null);
    setLoading(true);
    requestWorkspace({ type: 'fs_list', path: nextPath, workspace: workspaceRoot })
      .then((payload) => {
        if (requestId !== listRequest.current) return;
        const nextEntries = (payload.entries as WorkspaceEntry[]) ?? [];
        setPath(String(payload.path ?? ''));
        setEntries(nextEntries);
        setSelected(null);
        setContent('');
        setBinary(false);
        setFilter('');
        if (thenRead) {
          const target = nextEntries.find((entry) => entry.path === thenRead);
          if (target) readFile(target);
        }
      })
      .catch((cause: Error) => { if (requestId === listRequest.current) setError(cause.message); })
      .finally(() => { if (requestId === listRequest.current) setLoading(false); });
  };

  useEffect(() => {
    const jumpTo = (target: string) => {
      const slash = target.lastIndexOf('/');
      load(slash >= 0 ? target.slice(0, slash) : '', target);
    };
    fileOpenListeners.add(jumpTo);
    const target = pendingFileOpen;
    setTimeout(() => { pendingFileOpen = null; }, 0);
    if (target) jumpTo(target);
    else load('');
    return () => { fileOpenListeners.delete(jumpTo); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const crumbs = path ? path.split('/').map((name, index, all) => ({ name, path: all.slice(0, index + 1).join('/') })) : [];

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const filtered = entries.filter((entry) => (showHidden || !entry.name.startsWith('.')) && (!needle || entry.name.toLowerCase().includes(needle)));
    const direction = sortDesc ? -1 : 1;
    return [...filtered].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      const compare = sortKey === 'name'
        ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
        : sortKey === 'size' ? a.size - b.size : a.modified - b.modified;
      return compare * direction;
    });
  }, [entries, filter, sortKey, sortDesc, showHidden]);

  const open = (entry: WorkspaceEntry) => {
    if (entry.kind === 'dir') {
      load(entry.path);
      // Keep keyboard focus on the list so arrow keys keep working in the new folder.
      tableRef.current?.focus();
    } else readFile(entry);
  };

  const moveSelection = (next: WorkspaceEntry) => {
    if (next.kind === 'file') readFile(next);
    else setSelected(next);
    // Keep the newly selected row visible while keyboard navigating.
    requestAnimationFrame(() => {
      document.getElementById(`file-${next.path}`)?.scrollIntoView({ block: 'nearest' });
    });
  };

  const onListKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (visible.length === 0) return;
    const index = selected ? visible.findIndex((entry) => entry.path === selected.path) : -1;
    const last = visible.length - 1;
    const pageSize = 10;
    const clamp = (value: number) => Math.min(last, Math.max(0, value));
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      moveSelection(visible[clamp(index < 0 ? 0 : index + delta)]);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      moveSelection(visible[event.key === 'Home' ? 0 : last]);
    } else if (event.key === 'PageDown' || event.key === 'PageUp') {
      event.preventDefault();
      const delta = event.key === 'PageDown' ? pageSize : -pageSize;
      moveSelection(visible[clamp(index < 0 ? 0 : index + delta)]);
    } else if (event.key === 'Enter' && selected) {
      event.preventDefault();
      open(selected);
    } else if (event.key === 'Backspace' && path) {
      event.preventDefault();
      load(parent);
      tableRef.current?.focus();
    }
  };

  const toggleSort = (key: FileSortKey) => {
    if (sortKey === key) setSortDesc((value) => !value);
    else { setSortKey(key); setSortDesc(false); }
  };
  const sortMark = (key: FileSortKey) => (sortKey === key ? (sortDesc ? ' ▼' : ' ▲') : '');

  const fileCount = entries.filter((entry) => entry.kind === 'file').length;
  const dirCount = entries.length - fileCount;

  return <section className="panel-content files-panel">
    <header className="files-toolbar">
      <button type="button" onClick={() => load('')} aria-label="回到根目录" title="根目录">⌂</button>
      <button type="button" onClick={() => load(parent)} disabled={!path} aria-label="上一级" title="上一级（Backspace）">↑</button>
      <button type="button" onClick={() => load(path)} disabled={loading} aria-label="刷新" title="刷新">⟳</button>
      <nav className="files-breadcrumb" aria-label="当前路径">
        <button type="button" onClick={() => load('')}>根</button>
        {crumbs.map((crumb) => <span key={crumb.path} className="files-crumb"><span className="files-sep">/</span><button type="button" onClick={() => load(crumb.path)}>{crumb.name}</button></span>)}
      </nav>
      <input className="files-filter" type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="筛选文件名" aria-label="筛选文件名" />
      <label className="files-hidden-toggle"><input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} />隐藏项</label>
    </header>
    {error && <p className="browser-error" role="alert">{error}</p>}
    <div className="files-body">
      <div ref={tableRef} className="files-table-wrap" tabIndex={0} onKeyDown={onListKey} role="listbox" aria-label="文件列表" aria-activedescendant={selected ? `file-${selected.path}` : undefined}>
        <table className="files-table">
          <thead>
            <tr>
              <th><button type="button" onClick={() => toggleSort('name')}>名称{sortMark('name')}</button></th>
              <th className="files-col-size"><button type="button" onClick={() => toggleSort('size')}>大小{sortMark('size')}</button></th>
              <th className="files-col-date"><button type="button" onClick={() => toggleSort('modified')}>修改时间{sortMark('modified')}</button></th>
            </tr>
          </thead>
          <tbody>
            {loading && entries.length === 0 && <tr><td colSpan={3} className="files-empty">加载中…</td></tr>}
            {!loading && visible.length === 0 && <tr><td colSpan={3} className="files-empty">{entries.length === 0 ? '此目录为空' : '没有匹配的项目'}</td></tr>}
            {visible.map((entry) => <tr
              key={entry.path}
              id={`file-${entry.path}`}
              role="option"
              aria-selected={selected?.path === entry.path}
              className={selected?.path === entry.path ? 'selected' : ''}
              onClick={() => (entry.kind === 'dir' ? setSelected(entry) : readFile(entry))}
              onDoubleClick={() => open(entry)}
            >
              <td className="files-name"><span className="files-icon" aria-hidden="true">{entry.kind === 'dir' ? '📁' : '📄'}</span>{entry.name}</td>
              <td className="files-col-size">{entry.kind === 'file' ? formatFileSize(entry.size) : '—'}</td>
              <td className="files-col-date">{formatModified(entry.modified)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
      <aside className="files-preview-pane" aria-label="预览">
        {!selected && <p className="files-preview-hint">{dirCount} 个文件夹，{fileCount} 个文件。选择文件以预览，双击文件夹进入。</p>}
        {selected && <>
          <div className="files-preview-meta">
            <strong>{selected.name}</strong>
            <span>{selected.kind === 'dir' ? '文件夹' : formatFileSize(selected.size)}</span>
            <span>修改：{formatModified(selected.modified)}</span>
            <span className="files-preview-path">{selected.path}</span>
            {selected.kind === 'dir' && <button type="button" className="files-open-dir" onClick={() => load(selected.path)}>进入文件夹</button>}
          </div>
          {selected.kind === 'file' && <>
            {previewLoading && <p className="files-preview-hint">加载预览…</p>}
            {!previewLoading && binary && <p className="files-preview-hint">二进制文件（{formatFileSize(previewSize)}），无法以文本预览。</p>}
            {!previewLoading && !binary && <pre className="files-preview">{content}{truncated && '\n…（内容已截断）'}</pre>}
          </>}
        </>}
      </aside>
    </div>
  </section>;
}
