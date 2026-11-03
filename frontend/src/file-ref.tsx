import { useEffect, useState } from 'react';
import { MAX_TEXT_PREVIEW_BYTES, type DroppedFileKind } from './dropped-files';

export type DroppedFileRef = {
  id: string;
  name: string;
  size: number;
  kind: DroppedFileKind;
  file: File;
  url: string | null;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function FileRefChip({ item, onPreview, onRemove }: { item: DroppedFileRef; onPreview: () => void; onRemove: () => void }) {
  return (
    <div className="chat-file-ref" title={item.name}>
      <span className="chat-file-ref-name">{item.name}</span>
      <span className="chat-file-ref-size">{formatSize(item.size)}</span>
      <button type="button" onClick={onPreview} aria-label={`预览 ${item.name}`} title="预览">预览</button>
      <button type="button" onClick={onRemove} aria-label={`移除 ${item.name}`} title="移除">✕</button>
    </div>
  );
}

function openInNewTab(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

export function FilePreviewDialog({ item, onClose }: { item: DroppedFileRef; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useEffect(() => {
    const objectUrl = URL.createObjectURL(item.file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [item.file]);

  useEffect(() => {
    if (item.kind !== 'text') return;
    let cancelled = false;
    const slice = item.file.slice(0, MAX_TEXT_PREVIEW_BYTES);
    slice.text().then(
      (content) => { if (!cancelled) setText(content); },
      (cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : '读取失败'); },
    );
    return () => { cancelled = true; };
  }, [item]);

  const truncated = item.kind === 'text' && item.file.size > MAX_TEXT_PREVIEW_BYTES;

  return (
    <div className="approval-backdrop" role="dialog" aria-modal="true" aria-label={`预览 ${item.name}`} onClick={onClose}>
      <div className="file-preview" onClick={(event) => event.stopPropagation()}>
        <header className="file-preview-head">
          <strong>{item.name}</strong>
          <span className="chat-file-ref-size">{formatSize(item.size)}</span>
          {url && <button type="button" onClick={() => openInNewTab(url)}>在新页面打开</button>}
          <button type="button" onClick={onClose} aria-label="关闭预览">✕</button>
        </header>
        <div className="file-preview-body">
          {item.kind === 'image' && url && <img src={url} alt={item.name} />}
          {item.kind === 'text' && error && <p className="chat-error">{error}</p>}
          {item.kind === 'text' && text !== null && <pre>{text}{truncated ? '\n\n…（仅显示前 512 KB）' : ''}</pre>}
          {item.kind === 'other' && <p>该类型不支持内嵌预览，请点击「在新页面打开」。</p>}
        </div>
      </div>
    </div>
  );
}
