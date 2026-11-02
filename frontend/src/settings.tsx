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
  panelGradient: boolean;
  panelBlur: number;
  loaderStyle: LoaderStyle;
  panelAnimation: PanelAnimation;
  animationSpeed: number;
  scrollbarVisibility: ScrollbarVisibility;
  hotEdgeSidebar: boolean;
}

type LoaderStyle = 'dots' | 'spinner' | 'pulse' | 'none';
type PanelAnimation = 'fade' | 'slide' | 'none';
type ScrollbarVisibility = 'always' | 'hover' | 'hidden';

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
  { key: 'panelGradient', domain: '外观', title: '渐变透明', description: '面板背景从上到下渐变为透明（需要面板不透明度低于 100%）', type: 'boolean', default: false },
  { key: 'panelBlur', domain: '外观', title: '高斯模糊强度（px）', description: '面板背景的模糊半径，0 表示关闭', type: 'number', minimum: 0, maximum: 40, default: 18 },
  { key: 'loaderStyle', domain: '动效', title: '加载动画', description: '流式生成中「思考中」的指示器样式', type: 'enum', options: [{ value: 'dots', label: '三点跳动' }, { value: 'spinner', label: '旋转圈' }, { value: 'pulse', label: '脉冲条' }, { value: 'none', label: '无' }], default: 'dots' },
  { key: 'panelAnimation', domain: '动效', title: '面板动画', description: '面板展开、收起与切换时的过渡效果', type: 'enum', options: [{ value: 'fade', label: '淡入淡出' }, { value: 'slide', label: '滑动' }, { value: 'none', label: '无' }], default: 'fade' },
  { key: 'animationSpeed', domain: '动效', title: '动画速率（倍率）', description: '1 为默认，大于 1 更快，小于 1 更慢；0 表示关闭动画', type: 'number', minimum: 0, maximum: 3, default: 1 },
  { key: 'scrollbarVisibility', domain: '交互', title: '滚动条显示', description: '始终显示、鼠标悬停时显示，或隐藏（仍可滚动）', type: 'enum', options: [{ value: 'always', label: '始终显示' }, { value: 'hover', label: '悬停时显示' }, { value: 'hidden', label: '隐藏' }], default: 'hover' },
  { key: 'hotEdgeSidebar', domain: '交互', title: '热边：鼠标靠近左边缘展开侧栏', description: '鼠标移到窗口左边缘时自动展开聊天侧栏，离开后收起', type: 'boolean', default: true },
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

export interface SubagentPreferences {
  enabled: boolean;
  maxTurns: number;
  resultLimit: number;
  maxConcurrent: number;
  maxPerChat: number;
}

export const SUBAGENT_DEFAULTS: SubagentPreferences = { enabled: true, maxTurns: 4, resultLimit: 4000, maxConcurrent: 2, maxPerChat: 6 };

interface SubagentState {
  values: SubagentPreferences;
  update: <K extends keyof SubagentPreferences>(key: K, value: SubagentPreferences[K]) => void;
  reset: () => void;
}

export const useSubagentPreferences = create<SubagentState>()(persist((set) => ({
  values: SUBAGENT_DEFAULTS,
  update: (key, value) => set((state) => ({ values: { ...state.values, [key]: value } })),
  reset: () => set({ values: SUBAGENT_DEFAULTS }),
}), {
  name: 'hiero-subagent',
  merge: (persisted, current) => {
    const saved = (persisted as Partial<SubagentState> | undefined)?.values;
    return { ...current, values: { ...SUBAGENT_DEFAULTS, ...saved } };
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
  root.style.setProperty('--panel-blur', `${values.panelBlur}px`);
  root.style.setProperty('--panel-gradient-mask', values.panelGradient ? 'linear-gradient(to bottom, #000 0%, transparent 100%)' : 'none');
  root.style.setProperty('--anim-speed', String(values.animationSpeed));
  root.dataset.motion = values.reduceMotion || values.animationSpeed === 0 ? 'reduce' : 'full';
  root.dataset.loader = values.loaderStyle;
  root.dataset.panelAnim = values.panelAnimation;
  root.dataset.scrollbar = values.scrollbarVisibility;
  root.dataset.hotEdge = values.hotEdgeSidebar ? 'on' : 'off';
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

export type McpServerEntry =
  | { name: string; transport?: 'stdio'; command: string; args: string[]; cwd?: string; env?: Record<string, string>; enabled: boolean }
  | { name: string; transport: 'sse' | 'http'; url: string; headers?: Record<string, string>; enabled: boolean };
export type McpServerStatus = { name: string; connected: boolean; tool_count: number; error?: string };
export type McpConfigState = { servers: McpServerEntry[]; statuses: McpServerStatus[]; path: string };
export type McpSaveState = { status: 'idle' } | { status: 'saving' } | { status: 'saved' } | { status: 'error'; message: string };

const MCP_TEMPLATE = JSON.stringify({ servers: [{ name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'], enabled: true }] }, null, 2);

// Presets are disabled by default. They read credentials from the runtime env, never from this file.
const MCP_PRESETS: Array<{ label: string; server: McpServerEntry }> = [
  { label: '文件系统', server: { name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'], enabled: false } },
  { label: 'GitHub', server: { name: 'github', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}' }, enabled: false } },
  { label: 'Postgres', server: { name: 'postgres', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', '${POSTGRES_URL}'], enabled: false } },
];

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

  const addPreset = (preset: McpServerEntry) => {
    let current: { servers?: unknown } = {};
    try { current = JSON.parse(text) as { servers?: unknown }; } catch { current = {}; }
    const servers = Array.isArray(current.servers) ? (current.servers as McpServerEntry[]) : [];
    if (servers.some((server) => server.name === preset.name)) return;
    setText(JSON.stringify({ servers: [...servers, preset] }, null, 2));
    setParseError('');
    setDirty(true);
  };

  return <form className="settings-mcp-form" onSubmit={submit}>
    <p className="settings-mcp-hint">支持 stdio（本地命令）以及 sse / http（远程 URL）。保存到 {config?.path ?? '.hiero/mcp.json'}。预设默认禁用；启用前请确认命令来源可信，凭据请通过环境变量提供。</p>
    <div className="settings-mcp-presets" aria-label="MCP 预设">
      {MCP_PRESETS.map((preset) => <button type="button" key={preset.server.name} className="ghost-button" onClick={() => addPreset(preset.server)}>添加预设：{preset.label}</button>)}
    </div>
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
  const subagent = useSubagentPreferences((state) => state.values);
  const updateSubagent = useSubagentPreferences((state) => state.update);
  const resetSubagent = useSubagentPreferences((state) => state.reset);
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
      <h3>子代理</h3>
      <label className="settings-row">
        <span><strong>启用只读子代理</strong><small>允许模型把调研任务交给只读子代理（只能读文件、列目录、查记忆）。关闭后模型不再看到 delegate_read 工具。</small></span>
        <input type="checkbox" checked={subagent.enabled} onChange={(event) => updateSubagent('enabled', event.target.checked)} aria-label="启用只读子代理" />
      </label>
      <label className="settings-row">
        <span><strong>最大轮数</strong><small>子代理最多调用模型几轮（1–10）。越大越能深入调研，耗时和成本也越高。</small></span>
        <input type="number" value={subagent.maxTurns} min={1} max={10} onChange={(event) => updateSubagent('maxTurns', Number(event.target.value))} aria-label="子代理最大轮数" />
      </label>
      <label className="settings-row">
        <span><strong>结果长度上限（字符）</strong><small>子代理返回给主对话的摘要最长字符数（500–20000）。</small></span>
        <input type="number" value={subagent.resultLimit} min={500} max={20000} step={100} onChange={(event) => updateSubagent('resultLimit', Number(event.target.value))} aria-label="子代理结果长度上限" />
      </label>
      <label className="settings-row">
        <span><strong>每轮最多子代理调用数</strong><small>模型一次回复中最多同时委派几个子代理（1–4），超出的调用会被拒绝。</small></span>
        <input type="number" value={subagent.maxConcurrent} min={1} max={4} onChange={(event) => updateSubagent('maxConcurrent', Number(event.target.value))} aria-label="每轮最多子代理调用数" />
      </label>
      <label className="settings-row">
        <span><strong>每次聊天最多子代理调用数</strong><small>一次对话请求中子代理总调用次数上限（1–20），防止失控委派。</small></span>
        <input type="number" value={subagent.maxPerChat} min={1} max={20} onChange={(event) => updateSubagent('maxPerChat', Number(event.target.value))} aria-label="每次聊天最多子代理调用数" />
      </label>
      <div className="settings-form-actions">
        <button type="button" className="ghost-button" onClick={resetSubagent}>恢复子代理默认值</button>
      </div>
    </div>
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
