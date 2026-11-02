import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactElement } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type Theme = 'dark' | 'light' | 'system';
type SendKey = 'enter' | 'mod-enter';

export interface PreferenceValues {
  theme: Theme;
  accentColor: string;
  sendKey: SendKey;
  autoScroll: boolean;
  fontSize: number;
  uiFontSize: number;
  bubbleWidth: number;
  compact: boolean;
  reduceMotion: boolean;
  wrapCode: boolean;
  backgroundImage: string;
  backgroundOpacity: number;
  panelOpacity: number;
  textColor: string;
}

const DEFAULT_ACCENT = '#a5ec68';

interface PreferenceField {
  key: keyof PreferenceValues;
  domain: string;
  title: string;
  description: string;
  type: 'enum' | 'boolean' | 'number' | 'color' | 'text';
  options?: { value: string; label: string }[];
  minimum?: number;
  maximum?: number;
  default: PreferenceValues[keyof PreferenceValues];
}

// Declarative schema: the form is rendered from this list, so new settings only need a new entry.
export const PREFERENCE_SCHEMA: PreferenceField[] = [
  { key: 'theme', domain: '外观', title: '主题', description: '深色、浅色或跟随系统', type: 'enum', options: [{ value: 'dark', label: '深色' }, { value: 'light', label: '浅色' }, { value: 'system', label: '跟随系统' }], default: 'system' },
  { key: 'accentColor', domain: '外观', title: '强调色', description: '按钮与高亮颜色', type: 'color', default: DEFAULT_ACCENT },
  { key: 'fontSize', domain: '排版', title: '聊天字号（px）', description: '聊天正文字号', type: 'number', minimum: 12, maximum: 20, default: 14 },
  { key: 'uiFontSize', domain: '排版', title: '界面字号（px）', description: '面板、侧栏等界面文字的基础字号', type: 'number', minimum: 11, maximum: 18, default: 13 },
  { key: 'bubbleWidth', domain: '排版', title: '消息最大宽度（%）', description: '聊天气泡占聊天区宽度的最大比例', type: 'number', minimum: 40, maximum: 100, default: 78 },
  { key: 'compact', domain: '外观', title: '紧凑模式', description: '缩小消息之间的间距', type: 'boolean', default: false },
  { key: 'reduceMotion', domain: '外观', title: '减少动效', description: '关闭过渡动画', type: 'boolean', default: false },
  { key: 'sendKey', domain: '交互', title: '发送快捷键', description: 'Enter 发送，或 Ctrl/Cmd+Enter 发送', type: 'enum', options: [{ value: 'enter', label: 'Enter 发送' }, { value: 'mod-enter', label: 'Ctrl/Cmd+Enter 发送' }], default: 'enter' },
  { key: 'autoScroll', domain: '交互', title: '流式输出自动吸底', description: '回复生成时自动滚动到底部', type: 'boolean', default: true },
  { key: 'wrapCode', domain: '交互', title: '代码块自动换行', description: '长代码行换行显示，而不是横向滚动', type: 'boolean', default: false },
  { key: 'backgroundImage', domain: '外观', title: '背景图片', description: '图片地址（http(s):// 或 file 可访问的 URL），或上传本地图片；留空则不使用背景图', type: 'text', default: '' },
  { key: 'backgroundOpacity', domain: '外观', title: '背景透明度（%）', description: '背景图的不透明度，越小越淡', type: 'number', minimum: 5, maximum: 100, default: 35 },
  { key: 'panelOpacity', domain: '外观', title: '面板不透明度（%）', description: '面板、标签栏、导航和底部栏的不透明度，调低后可透出背景图', type: 'number', minimum: 0, maximum: 100, default: 0 },
    { key: 'textColor', domain: '外观', title: '文字颜色', description: '界面主要文字颜色，恢复默认请点击「重置」', type: 'color', default: '' },
  ];

const DEFAULT_PREFERENCES = Object.fromEntries(PREFERENCE_SCHEMA.map((field) => [field.key, field.default])) as unknown as PreferenceValues;

interface PreferenceState {
  values: PreferenceValues;
  update: (key: keyof PreferenceValues, value: PreferenceValues[keyof PreferenceValues]) => void;
  reset: () => void;
}

export const usePreferences = create<PreferenceState>()(persist((set) => ({
  values: DEFAULT_PREFERENCES,
  update: (key, value) => set((state) => ({ values: { ...state.values, [key]: value } })),
  reset: () => set({ values: DEFAULT_PREFERENCES }),
}), {
  name: 'hiero-preferences',
  merge: (persisted, current) => {
    const saved = (persisted as Partial<PreferenceState> | undefined)?.values;
    return { ...current, values: { ...DEFAULT_PREFERENCES, ...saved } };
  },
}));

export interface ModelSettings {
  endpoint: string;
  model: string;
  token_count: number;
}

export function applyPreferenceTheme(values: PreferenceValues): void {
  const root = document.documentElement;
  const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;
  const resolved = values.theme === 'system' ? (prefersLight ? 'light' : 'dark') : values.theme;
  root.dataset.theme = resolved;
  if (resolved === 'light' && values.accentColor === DEFAULT_ACCENT) root.style.removeProperty('--accent');
  else root.style.setProperty('--accent', values.accentColor);
  root.style.setProperty('--chat-font-size', `${values.fontSize}px`);
  root.style.setProperty('--ui-font-size', `${values.uiFontSize}px`);
  root.style.setProperty('--bubble-max-width', `${values.bubbleWidth}%`);
  root.style.setProperty('--message-gap', values.compact ? '6px' : '12px');
  root.style.setProperty('--code-white-space', values.wrapCode ? 'pre-wrap' : 'pre');
  root.style.setProperty('--background-image', values.backgroundImage ? `url("${values.backgroundImage.replace(/["\\]/g, '')}")` : 'none');
  root.style.setProperty('--background-opacity', String(values.backgroundOpacity / 100));
  root.style.setProperty('--panel-opacity', String(values.panelOpacity / 100));
  if (values.textColor) {
    root.style.setProperty('--text-strong', values.textColor);
    root.style.setProperty('--text', values.textColor);
    root.style.setProperty('--text-muted', `color-mix(in srgb, ${values.textColor} 65%, transparent)`);
  } else {
    root.style.removeProperty('--text-strong');
    root.style.removeProperty('--text');
    root.style.removeProperty('--text-muted');
  }
  root.dataset.motion = values.reduceMotion ? 'reduce' : 'full';
}

const BACKGROUND_ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const BACKGROUND_MAX_SIDE = 1920;
// localStorage 配额约 5MB，留出余量。
const BACKGROUND_MAX_DATA_URL_LENGTH = 3_000_000;

async function imageFileToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, BACKGROUND_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器不支持图片处理');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    if (dataUrl.length > BACKGROUND_MAX_DATA_URL_LENGTH) throw new Error('图片过大，请换一张分辨率或体积更小的图片');
    return dataUrl;
  } finally {
    bitmap.close();
  }
}

function BackgroundImageControl({ value, onChange }: { value: string; onChange: (value: string) => void }): ReactElement {
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const uploaded = value.startsWith('data:');

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!BACKGROUND_ACCEPTED_TYPES.includes(file.type)) {
      setError('仅支持 PNG、JPEG、WebP、GIF 图片');
      return;
    }
    try {
      onChange(await imageFileToDataUrl(file));
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '图片处理失败');
    }
  };

  return <div className="settings-background-control">
    <input type="text" value={uploaded ? '' : value} readOnly={uploaded} placeholder={uploaded ? '已上传本地图片' : 'https://...'} onChange={(event) => onChange(event.target.value)} aria-label="背景图片" />
    <button type="button" className="ghost-button" onClick={() => fileInput.current?.click()}>上传图片</button>
    {value && <button type="button" className="ghost-button" onClick={() => onChange('')}>清除</button>}
    <input ref={fileInput} type="file" accept={BACKGROUND_ACCEPTED_TYPES.join(',')} hidden onChange={handleFile} aria-label="选择背景图片文件" />
    {error && <small className="settings-background-error" role="alert">{error}</small>}
  </div>;
}

function PreferenceControl({ field, value, onChange }: { field: PreferenceField; value: PreferenceValues[keyof PreferenceValues]; onChange: (value: PreferenceValues[keyof PreferenceValues]) => void }): ReactElement {
  if (field.type === 'boolean') {
    return <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} aria-label={field.title} />;
  }
  if (field.type === 'enum') {
    return <select value={String(value)} onChange={(event) => onChange(event.target.value)} aria-label={field.title}>
      {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>;
  }
  if (field.key === 'textColor') {
    return <span className="settings-text-color-control">
      <input type="color" value={String(value) || '#d4d7de'} onChange={(event) => onChange(event.target.value)} aria-label={field.title} />
      <button type="button" disabled={!value} onClick={() => onChange('')}>重置</button>
    </span>;
  }
  if (field.type === 'color') {
    return <input type="color" value={String(value)} onChange={(event) => onChange(event.target.value)} aria-label={field.title} />;
  }
  if (field.key === 'backgroundImage') {
    return <BackgroundImageControl value={String(value)} onChange={onChange} />;
  }
  if (field.type === 'text') {
    return <input type="text" value={String(value)} placeholder="https://..." onChange={(event) => onChange(event.target.value)} aria-label={field.title} />;
  }
  return <input type="number" value={Number(value)} min={field.minimum} max={field.maximum} onChange={(event) => onChange(Number(event.target.value))} aria-label={field.title} />;
}

export function ModelGatewayForm({ modelSettings, saveState, onSave }: { modelSettings: ModelSettings | null; saveState: SaveState; onSave: (input: { endpoint: string; model: string; tokens: string }) => void }): ReactElement {
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [tokens, setTokens] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!modelSettings || dirty) return;
    setEndpoint(modelSettings.endpoint);
    setModel(modelSettings.model);
  }, [modelSettings, dirty]);

  useEffect(() => {
    if (saveState.status === 'saved') {
      setTokens('');
      setDirty(false);
    }
  }, [saveState]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({ endpoint, model, tokens });
  };

  const statusText = saveState.status === 'saving'
    ? '正在保存…'
    : saveState.status === 'saved'
      ? `已保存到本地 .env，当前令牌 ${saveState.tokenCount} 个，新请求立即使用。`
      : saveState.status === 'error'
        ? `保存失败：${saveState.message}`
        : dirty ? '有未保存的修改。' : '';

  return <form className="settings-gateway-form" onSubmit={submit}>
    <label className="settings-field">
      <span><strong>API 端点</strong><small>OpenAI 兼容地址，例如 https://example.com/v1（会自动补全 /chat/completions）</small></span>
      <input value={endpoint} onChange={(event) => { setEndpoint(event.target.value); setDirty(true); }} placeholder="https://..." aria-label="API 端点" />
    </label>
    <label className="settings-field">
      <span><strong>默认模型</strong><small>例如 gpt-5.6-luna</small></span>
      <input value={model} onChange={(event) => { setModel(event.target.value); setDirty(true); }} placeholder="gpt-5.6-luna" aria-label="默认模型" />
    </label>
    <label className="settings-field">
      <span><strong>API 密钥（令牌）</strong><small>多个用逗号分隔，用于轮换。已保存 {modelSettings?.token_count ?? 0} 个；留空则保留原有密钥。保存在本地 .env，不会回显。</small></span>
      <input type="password" value={tokens} onChange={(event) => { setTokens(event.target.value); setDirty(true); }} placeholder={modelSettings?.token_count ? '••••••（已保存，留空保留）' : 'sk-...'} aria-label="API 密钥" autoComplete="off" />
    </label>
    <div className="settings-form-actions">
      <button type="submit" className="ghost-button" disabled={!modelSettings || saveState.status === 'saving'}>{saveState.status === 'saving' ? '保存中…' : '保存并立即生效'}</button>
      <span className={`settings-save-status settings-save-${saveState.status}`} role="status">{statusText}</span>
    </div>
  </form>;
}

export type McpServerEntry = { name: string; transport: 'stdio'; command: string; args: string[]; cwd?: string; env?: Record<string, string>; enabled: boolean };
export type McpServerStatus = { name: string; connected: boolean; tool_count: number; error?: string };
export type McpConfigState = { servers: McpServerEntry[]; statuses: McpServerStatus[]; path: string };
export type McpSaveState = { status: 'idle' } | { status: 'saving' } | { status: 'saved' } | { status: 'error'; message: string };

const MCP_TEMPLATE = JSON.stringify({ servers: [{ name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'], enabled: true }] }, null, 2);

export function McpServersForm({ config, saveState, onSave }: { config: McpConfigState | null; saveState: McpSaveState; onSave: (servers: McpServerEntry[]) => void }): ReactElement {
  const [text, setText] = useState('');
  const [parseError, setParseError] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!config || dirty) return;
    setText(config.servers.length > 0 ? JSON.stringify({ servers: config.servers }, null, 2) : MCP_TEMPLATE);
  }, [config, dirty]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (cause) { setParseError(`JSON 格式错误：${cause instanceof Error ? cause.message : String(cause)}`); return; }
    const servers = (parsed as { servers?: unknown }).servers;
    if (!Array.isArray(servers)) { setParseError('顶层需要 { "servers": [...] } 结构。'); return; }
    setParseError('');
    onSave(servers as McpServerEntry[]);
    setDirty(false);
  };

  const statusByName = new Map((config?.statuses ?? []).map((status) => [status.name, status]));
  const statusText = saveState.status === 'saving' ? '保存并连接中…' : saveState.status === 'saved' ? '已保存' : saveState.status === 'error' ? saveState.message : '';

  return <form className="settings-mcp-form" onSubmit={submit}>
    <p className="settings-mcp-hint">仅支持 stdio：Hiero 会在本地启动这些命令并通过标准输入输出通信。保存到 {config?.path ?? '.hiero/mcp.json'}。</p>
    {config && config.statuses.length > 0 && <ul className="settings-mcp-status">
      {config.statuses.map((status) => <li key={status.name} className={status.connected ? 'mcp-connected' : 'mcp-failed'}>
        <strong>{status.name}</strong>：{status.connected ? `已连接，${status.tool_count} 个工具` : `未连接 — ${statusByName.get(status.name)?.error ?? '未知错误'}`}
      </li>)}
    </ul>}
    <label className="settings-field">
      <span><strong>服务器配置（JSON）</strong><small>每个服务器需要 name、command，可选 args、cwd、env、enabled。</small></span>
      <textarea rows={12} value={text} onChange={(event) => { setText(event.target.value); setDirty(true); }} spellCheck={false} aria-label="MCP 服务器配置" />
    </label>
    {parseError && <p className="settings-save-error" role="alert">{parseError}</p>}
    <div className="settings-form-actions">
      <button type="submit" className="ghost-button" disabled={!config || saveState.status === 'saving'}>保存并连接</button>
      <span className={`settings-save-status settings-save-${saveState.status}`} role="status">{statusText}</span>
    </div>
  </form>;
}

export type SaveState = { status: 'idle' } | { status: 'saving' } | { status: 'saved'; tokenCount: number } | { status: 'error'; message: string };

export function SettingsPanel({ modelSettings, saveState, onSaveModel, mcpConfig, mcpSaveState, onSaveMcp }: { modelSettings: ModelSettings | null; saveState: SaveState; onSaveModel: (input: { endpoint: string; model: string; tokens: string }) => void; mcpConfig: McpConfigState | null; mcpSaveState: McpSaveState; onSaveMcp: (servers: McpServerEntry[]) => void }): ReactElement {
  const values = usePreferences((state) => state.values);
  const update = usePreferences((state) => state.update);
  const reset = usePreferences((state) => state.reset);
  const [query, setQuery] = useState('');

  const fields = useMemo(() => PREFERENCE_SCHEMA.filter((field) => `${field.domain}${field.title}${field.description}`.toLowerCase().includes(query.trim().toLowerCase())), [query]);
  const domains = Array.from(new Set(fields.map((field) => field.domain)));

  return <section className="settings-panel" aria-label="设置">
    <div className="settings-toolbar">
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索设置……" aria-label="搜索设置" />
      <button type="button" className="ghost-button" onClick={reset}>恢复默认</button>
    </div>
    {domains.map((domain) => <div className="settings-domain" key={domain}>
      <h3>{domain}</h3>
      {fields.filter((field) => field.domain === domain).map((field) => <label className="settings-row" key={field.key}>
        <span><strong>{field.title}</strong><small>{field.description}</small></span>
        <PreferenceControl field={field} value={values[field.key]} onChange={(next) => update(field.key, next)} />
      </label>)}
    </div>)}
    <div className="settings-domain">
      <h3>模型与网关</h3>
      {modelSettings
        ? <ModelGatewayForm modelSettings={modelSettings} saveState={saveState} onSave={onSaveModel} />
        : <p className="chat-empty">正在读取后端配置……</p>}
    </div>
    <div className="settings-domain">
      <h3>MCP 服务器</h3>
      <McpServersForm config={mcpConfig} saveState={mcpSaveState} onSave={onSaveMcp} />
    </div>
  </section>;
}
