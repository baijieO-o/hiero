import { useEffect, useMemo, useRef, useState, useSyncExternalStore, lazy, Suspense, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type FormEvent as ReactFormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewHeaderActionsProps } from 'dockview-react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ReactElement } from 'react';
import { McpServersForm, SettingsPanel, usePreferences, useSubagentPreferences, applyPreferenceTheme, type McpConfigState, type McpSaveState, type McpServerEntry, type McpServerStatus, type ModelSettings, type SaveState } from './settings';
import { clearConsoleEntries, evaluateInPage, getDevtoolsSnapshot, subscribeDevtools } from './devtools';
import { renderMarkdown } from './markdown';
import { PermissionModePicker, isPermissionLabel, readStoredPermission, storePermission, toPermissionMode, type PermissionLabel } from './permission-mode';
import { TaskCard } from './task-card';
import { DEFAULT_BUDGET, toContractFields, validateTaskCard, type TaskCardBudget } from './task-card-model';
import { RUNTIME_WS_URL } from './runtime-url';
import { estimateCostUsd, formatCost } from './token-cost';

type TodoStatus = 'done' | 'active' | 'pending';

type RuntimeMessage = {
  type?: string;
  payload?: Record<string, unknown>;
};

const TODO_ITEMS = ['定义任务契约', '运行执行网关', '验证工具证据', '准备交接文档'];

function connectRuntime(onMessage: (message: RuntimeMessage) => void): () => void {
  const socket = new WebSocket(RUNTIME_WS_URL);
  socket.onmessage = (event) => {
    try { onMessage(JSON.parse(String(event.data)) as RuntimeMessage); } catch { /* Ignore non-JSON runtime messages. */ }
  };
  return () => socket.close();
}

type PanelKind = 'chat' | 'mission' | 'debug' | 'todo' | 'review' | 'handoff' | 'settings' | 'browser' | 'terminal' | 'files' | 'skills' | 'memory' | 'blank';

const PANEL_TITLES: Record<PanelKind, string> = {
  chat: '对话',
  mission: '任务控制台',
  debug: '调试控制台',
  todo: '待办清单',
  review: '代码审查',
  handoff: '交接文档',
  settings: '设置',
  browser: '浏览器',
  terminal: '终端',
  files: '文件管理器',
  skills: '技能管理',
  memory: '记忆',
  blank: '空缓存窗口',
};

const PANEL_KINDS = Object.keys(PANEL_TITLES).filter((kind) => kind !== 'blank') as PanelKind[];

const HIDDEN_RAIL_KINDS: PanelKind[] = ['mission', 'todo', 'review', 'handoff'];
const RAIL_KINDS = PANEL_KINDS.filter((kind) => !HIDDEN_RAIL_KINDS.includes(kind));

const DEFAULT_SCREEN = '默认';

interface BufferEntry {
  id: string;
  kind: PanelKind;
}

interface WorkspaceState {
  screens: Record<string, unknown | null>;
  activeScreen: string;
  buffers: BufferEntry[];
  setSerializedLayout: (layout: unknown) => void;
  setActiveScreen: (name: string) => void;
  addScreen: (name: string) => void;
  resetLayout: () => void;
  addBuffer: (kind: PanelKind) => string;
  removeBuffer: (id: string) => void;
  clearBuffers: () => void;
  browserUrls: Record<string, string>;
  setBrowserUrl: (id: string, url: string) => void;
}

const useWorkspaceStore = create<WorkspaceState>()(persist((set) => ({
  screens: { [DEFAULT_SCREEN]: null },
  activeScreen: DEFAULT_SCREEN,
  buffers: [],
  browserUrls: {},
  setSerializedLayout: (layout) => set((state) => ({ screens: { ...state.screens, [state.activeScreen]: layout } })),
  setActiveScreen: (name) => set({ activeScreen: name }),
  addScreen: (name) => set((state) => ({ screens: { ...state.screens, [name]: null }, activeScreen: name })),
  resetLayout: () => set((state) => ({ screens: { ...state.screens, [state.activeScreen]: null } })),
  addBuffer: (kind) => {
    const id = `buffer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    set((state) => ({ buffers: [...state.buffers, { id, kind }] }));
    return id;
  },
  removeBuffer: (id) => set((state) => {
    const { [id]: _removed, ...browserUrls } = state.browserUrls;
    return { buffers: state.buffers.filter((buffer) => buffer.id !== id), browserUrls };
  }),
  clearBuffers: () => set({ buffers: [], browserUrls: {} }),
  setBrowserUrl: (id, url) => set((state) => ({ browserUrls: { ...state.browserUrls, [id]: url } })),
}), { name: 'hiero-workspace' }));

const COMMAND_ALIASES: Record<string, PanelKind> = {
  CHAT: 'chat',
  MS: 'mission',
  TASK: 'mission',
  DBG: 'debug',
  DEBUG: 'debug',
  TODO: 'todo',
  REV: 'review',
  DIFF: 'review',
  HO: 'handoff',
  HANDOFF: 'handoff',
  SET: 'settings',
  SETTINGS: 'settings',
  BROWSER: 'browser',
  BR: 'browser',
  WEB: 'browser',
  TERMINAL: 'terminal',
  TERM: 'terminal',
  FILES: 'files',
  FM: 'files',
};

function resolveCommand(input: string): PanelKind | null {
  const key = input.trim().toUpperCase();
  if (!key) return null;
  if (key in COMMAND_ALIASES) return COMMAND_ALIASES[key];
  return PANEL_KINDS.find((kind) => kind.toUpperCase() === key) ?? null;
}

interface ToolStep {
  name: string;
  arguments: string;
  result: string;
}

interface TraceEvent {
  seq: number;
  kind: 'model_call' | 'tool_call' | 'subagent_call' | 'reply' | 'error';
  label: string;
  startedAt: number;
  durationMs?: number;
  ok?: boolean;
  detail?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  images?: string[];
  files?: string[];
  steps?: ToolStep[];
  usage?: ChatUsage;
  model?: string;
  trace?: TraceEvent[];
  completedAt?: number;
}

interface ChatUsage { input_tokens: number; output_tokens: number; calls: number; duration_ms: number }

const MAX_CHAT_IMAGES = 4;
const MAX_IMAGE_EDGE = 1600;

function readImageAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(image.naturalWidth * scale);
      canvas.height = Math.round(image.naturalHeight * scale);
      const context = canvas.getContext('2d');
      if (!context) { URL.revokeObjectURL(url); reject(new Error('无法处理图片')); return; }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.9));
    };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`无法读取图片 ${file.name}`)); };
    image.src = url;
  });
}

interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
}

export interface ChatOptions {
  model: string;
  permission: string;
  workspace: string;
  contextMode: string;
}

const CHAT_MODEL_OPTIONS = ['gpt-5.6-luna'];
const CHAT_CONTEXT_OPTIONS = ['临时会话', '持久化 Markdown'];
// 热边：鼠标距窗口左边缘多少像素内触发展开；离开侧栏后延迟收起，避免抖动。
const HOT_EDGE_PX = 8;
const HOT_EDGE_HIDE_DELAY_MS = 300;
const TIMESTAMP_IDLE_HIDE_MS = 1500;

interface ChatState {
  conversations: Conversation[];
  activeId: string;
  pending: boolean;
  streamingText: string;
  streamingSteps: ToolStep[];
  error: string | null;
  options: ChatOptions;
  setOption: <K extends keyof ChatOptions>(key: K, value: ChatOptions[K]) => void;
  newConversation: () => void;
  selectConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  deleteConversation: (id: string) => void;
  rewindConversation: (messageIndex: number) => void;
  send: (text: string, images?: string[]) => void;
  cancel: () => void;
}

function readPathArgument(rawArguments: string): string {
  try {
    const parsed = JSON.parse(rawArguments) as { path?: unknown };
    return typeof parsed.path === 'string' ? parsed.path : '';
  } catch {
    return '';
  }
}

function createConversation(): Conversation {
  return { id: `conv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, title: '新对话', messages: [], updatedAt: Date.now() };
}

const useChatStore = create<ChatState>()(persist((set, get) => {
  let socket: WebSocket | null = null;
  let activeRequest: { conversationId: string; requestId: string } | null = null;
  let pendingFiles: string[] = [];
  let pendingSteps: ToolStep[] = [];
  let pendingTrace: TraceEvent[] | undefined;
  const updateConversation = (id: string, change: (conv: Conversation) => Conversation) =>
    set((state) => ({ conversations: state.conversations.map((conv) => (conv.id === id ? change(conv) : conv)) }));
  const ensureSocket = (): WebSocket => {
    if (socket && socket.readyState <= WebSocket.OPEN) return socket;
    const next = new WebSocket(RUNTIME_WS_URL);
    next.onmessage = (event) => {
      let message: RuntimeMessage;
      try { message = JSON.parse(String(event.data)) as RuntimeMessage; } catch { return; }
      const requestId = typeof message.payload?.request_id === 'string' ? message.payload.request_id : '';
      if (!activeRequest || activeRequest.requestId !== requestId) return;
      const conversationId = activeRequest.conversationId;
      if (message.type === 'CHAT_DELTA') {
        const text = typeof message.payload?.text === 'string' ? message.payload.text : '';
        set((state) => ({ streamingText: state.streamingText + text }));
      } else if (message.type === 'CHAT_RESET') {
        set({ streamingText: '' });
      } else if (message.type === 'CHAT_TOOL') {
        const name = typeof message.payload?.name === 'string' ? message.payload.name : '';
        const args = typeof message.payload?.arguments === 'string' ? message.payload.arguments : '{}';
        const result = typeof message.payload?.result === 'string' ? message.payload.result : '';
        pendingSteps.push({ name, arguments: args, result });
        set({ streamingSteps: [...pendingSteps] });
        if (name === 'read_file') {
          const path = readPathArgument(args);
          if (path) pendingFiles.push(path);
        }
      } else if (message.type === 'CHAT_TRACE') {
        pendingTrace = parseTraceEvents(message.payload?.events);
      } else if (message.type === 'CHAT_REPLY') {
        const content = typeof message.payload?.content === 'string' ? message.payload.content : get().streamingText;
        const files = pendingFiles.length > 0 ? [...new Set(pendingFiles)] : undefined;
        const steps = pendingSteps.length > 0 ? pendingSteps : undefined;
        const usage = parseChatUsage(message.payload?.usage);
        const model = typeof message.payload?.model === 'string' ? message.payload.model : undefined;
        const trace = pendingTrace;
        pendingFiles = [];
        pendingSteps = [];
        pendingTrace = undefined;
        updateConversation(conversationId, (conv) => ({ ...conv, messages: [...conv.messages, { role: 'assistant', content, files, steps, usage, model, trace, completedAt: Date.now() }], updatedAt: Date.now() }));
        activeRequest = null;
        set({ pending: false, streamingText: '', streamingSteps: [], error: null });
      } else if (message.type === 'CHAT_CANCELLED') {
        const partial = get().streamingText.trim();
        const files = pendingFiles.length > 0 ? [...new Set(pendingFiles)] : undefined;
        const steps = pendingSteps.length > 0 ? pendingSteps : undefined;
        pendingFiles = [];
        pendingSteps = [];
        pendingTrace = undefined;
        if (partial || steps) {
          updateConversation(conversationId, (conv) => ({ ...conv, messages: [...conv.messages, { role: 'assistant', content: partial, files, steps, completedAt: Date.now() }], updatedAt: Date.now() }));
        }
        activeRequest = null;
        set({ pending: false, streamingText: '', streamingSteps: [], error: null });
      } else if (message.type === 'CHAT_ERROR') {
        const detail = typeof message.payload?.message === 'string' ? message.payload.message : '请求失败';
        pendingFiles = [];
        pendingSteps = [];
        pendingTrace = undefined;
        activeRequest = null;
        set({ pending: false, streamingText: '', streamingSteps: [], error: detail });
      }
    };
    const abandonPending = () => {
      if (socket !== next) return;
      socket = null;
      if (!activeRequest) return;
      activeRequest = null;
      pendingFiles = [];
      pendingSteps = [];
      set({ pending: false, streamingText: '', streamingSteps: [], error: '与后端的连接已断开，请重试。' });
    };
    next.onclose = abandonPending;
    next.onerror = abandonPending;
    socket = next;
    return next;
  };
  const initial = createConversation();
  return {
    conversations: [initial],
    activeId: initial.id,
    pending: false,
    streamingText: '',
    streamingSteps: [],
    error: null,
    options: { model: 'gpt-5.6-luna', permission: readStoredPermission(), workspace: 'D:\\hiero', contextMode: '临时会话' },
    setOption: (key, value) => set((state) => ({ options: { ...state.options, [key]: value } })),
    newConversation: () => {
      if (get().pending) return;
      const conv = createConversation();
      set((state) => ({ conversations: [conv, ...state.conversations], activeId: conv.id, error: null }));
    },
    selectConversation: (id) => { if (!get().pending) set({ activeId: id, error: null }); },
    renameConversation: (id, title) => {
      const trimmed = title.trim();
      if (trimmed) updateConversation(id, (conv) => ({ ...conv, title: trimmed }));
    },
    deleteConversation: (id) => {
      if (get().pending && activeRequest?.conversationId === id) return;
      set((state) => {
        const remaining = state.conversations.filter((conv) => conv.id !== id);
        if (remaining.length === 0) {
          const fresh = createConversation();
          return { conversations: [fresh], activeId: fresh.id };
        }
        const activeId = state.activeId === id ? remaining[0]!.id : state.activeId;
        return { conversations: remaining, activeId };
      });
    },
    rewindConversation: (messageIndex) => {
      if (get().pending) return;
      const state = get();
      const conversation = state.conversations.find((conv) => conv.id === state.activeId);
      if (!conversation || messageIndex < 0 || messageIndex >= conversation.messages.length) return;
      updateConversation(conversation.id, (conv) => ({ ...conv, messages: conv.messages.slice(0, messageIndex), updatedAt: Date.now() }));
      set({ error: null });
    },
    send: (text, images = []) => {
      const trimmed = text.trim();
      const state = get();
      if ((!trimmed && images.length === 0) || state.pending) return;
      const conversation = state.conversations.find((conv) => conv.id === state.activeId);
      if (!conversation) return;
      const message: ChatMessage = { role: 'user', content: trimmed, ...(images.length > 0 ? { images } : {}) };
      const history = [...conversation.messages, message];
      const requestId = `chat-${Date.now()}`;
      activeRequest = { conversationId: conversation.id, requestId };
      updateConversation(conversation.id, (conv) => ({
        ...conv,
        messages: history,
        title: conv.messages.length === 0 ? (trimmed || '图片消息').slice(0, 20) : conv.title,
        updatedAt: Date.now(),
      }));
      pendingFiles = [];
      pendingSteps = [];
      set({ pending: true, streamingText: '', streamingSteps: [], error: null });
      const target = ensureSocket();
      const { model, permission, workspace, contextMode } = state.options;
      const subagent = useSubagentPreferences.getState().values;
      const payload = JSON.stringify({ type: 'chat', request_id: requestId, messages: history, model, permission, workspace, context_mode: contextMode, subagent });
      if (target.readyState === WebSocket.OPEN) target.send(payload);
      else target.addEventListener('open', () => target.send(payload), { once: true });
    },
    cancel: () => {
      const request = activeRequest;
      if (!request || !get().pending) return;
      const target = ensureSocket();
      const payload = JSON.stringify({ type: 'chat_cancel', request_id: request.requestId });
      if (target.readyState === WebSocket.OPEN) target.send(payload);
      else target.addEventListener('open', () => target.send(payload), { once: true });
    },
  };
}, {
  name: 'hiero-chat',
  partialize: (state) => ({ conversations: state.conversations, activeId: state.activeId, options: state.options }),
}));

function PencilIcon(): ReactElement {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>;
}

function CopyIcon(): ReactElement {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>;
}

function CheckIcon(): ReactElement {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>;
}

function GitForkIcon(): ReactElement {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="6" cy="3" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="6" cy="21" r="2" /><path d="M6 5v14" /><path d="M18 8a6 6 0 0 1-6 6H6" /></svg>;
}

function TrashIcon(): ReactElement {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /></svg>;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function describeStep(step: ToolStep): { title: string; detail: string; body: string; failed: boolean } {
  const args = parseJsonObject(step.arguments) ?? {};
  const result = parseJsonObject(step.result);
  const path = typeof args.path === 'string' ? args.path : '';
  const errorText = result && typeof result.error === 'string' ? result.error : '';
  if (step.name === 'read_file') {
    const content = result && typeof result.content === 'string' ? result.content : '';
    const lineCount = content ? content.split(/\r?\n/).length : 0;
    return {
      title: `读取 ${path || '文件'}`,
      detail: errorText ? `失败：${errorText}` : `${lineCount} 行`,
      body: errorText || content || step.result,
      failed: Boolean(errorText),
    };
  }
  return { title: step.name, detail: path, body: errorText || step.result, failed: Boolean(errorText) };
}

function ToolChain({ steps }: { steps: ToolStep[] }): ReactElement {
  return <div className="chat-steps">
    {steps.map((step, index) => {
      const view = describeStep(step);
      return <details key={index} className={`chat-step${view.failed ? ' chat-step-failed' : ''}`}>
        <summary>
          <span className="chat-step-icon" aria-hidden="true">{view.failed ? '✕' : '✓'}</span>
          <span className="chat-step-name">{view.title}</span>
          <span className="chat-step-arg">{view.detail}</span>
        </summary>
        <div className="chat-step-body">
          <pre>{view.body}</pre>
        </div>
      </details>;
    })}
  </div>;
}

function parseChatUsage(raw: unknown): ChatUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const item = raw as Record<string, unknown>;
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return { input_tokens: num(item.input_tokens), output_tokens: num(item.output_tokens), calls: num(item.calls), duration_ms: num(item.duration_ms) };
}

function summarizeSessionUsage(messages: ChatMessage[]): { calls: number; input_tokens: number; output_tokens: number; costUsd: number | undefined } {
  const total = { calls: 0, input_tokens: 0, output_tokens: 0, costUsd: 0 as number | undefined };
  for (const message of messages) {
    if (!message.usage || message.usage.calls === 0) continue;
    total.calls += message.usage.calls;
    total.input_tokens += message.usage.input_tokens;
    total.output_tokens += message.usage.output_tokens;
    const cost = estimateCostUsd(message.usage, message.model);
    // Any message without a known price makes the session total unknown rather than underestimated.
    if (cost === undefined) total.costUsd = undefined;
    else if (total.costUsd !== undefined) total.costUsd += cost;
  }
  return total;
}

function ChatMessageView({ role, content, images, files, steps, usage, model, trace, completedAt, onRewind, rewindDisabled, anchorIndex }: { role: ChatMessage['role']; content: string; images?: string[]; files?: string[]; steps?: ToolStep[]; usage?: ChatUsage; model?: string; trace?: TraceEvent[]; completedAt?: number; onRewind?: () => void; rewindDisabled?: boolean; anchorIndex?: number }): ReactElement {
  const [copied, setCopied] = useState(false);
  const [timeVisible, setTimeVisible] = useState(false);
  const idleTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(idleTimer.current), []);
  const copy = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => undefined);
  };
  const showTimeUntilIdle = () => {
    setTimeVisible(true);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setTimeVisible(false), TIMESTAMP_IDLE_HIDE_MS);
  };
  const hideTime = () => {
    window.clearTimeout(idleTimer.current);
    setTimeVisible(false);
  };
  const bubble = <div className={`chat-message chat-${role}`} data-message-index={anchorIndex}>
    <div className="chat-message-head">
      <span className="chat-role">{role === 'user' ? '你' : 'Hiero'}</span>
      <button type="button" className="chat-copy" onClick={copy} aria-label={copied ? '已复制' : '复制消息'} title={copied ? '已复制' : '复制消息'}>{copied ? <CheckIcon /> : <CopyIcon />}</button>
    </div>
    {steps && steps.length > 0 && <ToolChain steps={steps} />}
    {images && images.length > 0 && <div className="chat-images">
      {images.map((src, index) => <img key={index} src={src} alt={`上传的图片 ${index + 1}`} />)}
    </div>}
    {content && <div className="chat-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />}
    {files && files.length > 0 && <div className="chat-files">
      {files.map((file) => <button type="button" key={file} className="chat-file" onClick={() => requestOpenFile(file)} title={`在文件管理器中打开 ${file}`}>📄 {file}</button>)}
    </div>}
    {usage && usage.calls > 0 && <div className="chat-usage" title="模型调用轨迹">
      模型调用 {usage.calls} 次 · 输入 {usage.input_tokens} / 输出 {usage.output_tokens} tokens · 耗时 {(usage.duration_ms / 1000).toFixed(1)}s · 成本 {formatCost(estimateCostUsd(usage, model))}
    </div>}
    {trace && trace.length > 0 && <TraceTimeline events={trace} />}
  </div>;
  const checkpoint = onRewind && <button type="button" className="chat-checkpoint" onClick={onRewind} disabled={rewindDisabled} title="还原到此消息之前，删除此消息及之后的内容">
    <span>还原检查点</span><span aria-hidden="true">·</span><GitForkIcon />
  </button>;
  if (checkpoint) return <>{checkpoint}{bubble}</>;
  if (role !== 'assistant' || completedAt === undefined) return bubble;
  return <div className={`chat-message-wrap chat-${role}`} onPointerEnter={showTimeUntilIdle} onPointerMove={showTimeUntilIdle} onPointerLeave={hideTime}>
    {bubble}
    <div className={`chat-timestamp${timeVisible ? ' is-visible' : ''}`}>{formatMessageTime(completedAt)}</div>
  </div>;
}

function formatMessageTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const TRACE_KINDS: TraceEvent['kind'][] = ['model_call', 'tool_call', 'subagent_call', 'reply', 'error'];
const TRACE_KIND_LABELS: Record<TraceEvent['kind'], string> = { model_call: '模型', tool_call: '工具', subagent_call: '子代理', reply: '回复', error: '错误' };

function parseTraceEvents(raw: unknown): TraceEvent[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const events: TraceEvent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (!TRACE_KINDS.includes(record.kind as TraceEvent['kind'])) continue;
    if (typeof record.label !== 'string' || typeof record.startedAt !== 'number') continue;
    events.push({
      seq: typeof record.seq === 'number' ? record.seq : events.length + 1,
      kind: record.kind as TraceEvent['kind'],
      label: record.label,
      startedAt: record.startedAt,
      ...(typeof record.durationMs === 'number' ? { durationMs: record.durationMs } : {}),
      ...(typeof record.ok === 'boolean' ? { ok: record.ok } : {}),
      ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
    });
  }
  return events.length > 0 ? events : undefined;
}

function TraceTimeline({ events }: { events: TraceEvent[] }): ReactElement {
  const origin = events[0].startedAt;
  return <details className="chat-trace">
    <summary>执行时间线（{events.length} 步）</summary>
    <ol className="chat-trace-list">
      {events.map((event) => <li key={event.seq} className={`chat-trace-item chat-trace-${event.kind}${event.ok === false ? ' chat-trace-failed' : ''}`}>
        <span className="chat-trace-seq">{event.seq}</span>
        <span className="chat-trace-kind">{TRACE_KIND_LABELS[event.kind]}</span>
        <span className="chat-trace-label">{event.label}</span>
        <span className="chat-trace-time">+{((event.startedAt - origin) / 1000).toFixed(2)}s{event.durationMs !== undefined ? ` · ${(event.durationMs / 1000).toFixed(2)}s` : ''}</span>
        {event.ok === false && <span className="chat-trace-status">失败</span>}
        {event.detail && <div className="chat-trace-detail">{event.detail}</div>}
      </li>)}
    </ol>
  </details>;
}

function ChatPanel(): ReactElement {
  const { conversations, activeId, pending, streamingText, streamingSteps, error, options, setOption, newConversation, selectConversation, renameConversation, deleteConversation, rewindConversation, send, cancel } = useChatStore();
  const [draft, setDraft] = useState('');
  const [folderPicking, setFolderPicking] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const pickWorkspaceFolder = async (): Promise<void> => {
    setFolderPicking(true);
    setFolderError(null);
    try {
      const result = await requestWorkspace({ type: 'folder_pick', initialPath: options.workspace });
      const picked = typeof result.path === 'string' ? result.path : '';
      if (picked) setOption('workspace', picked);
    } catch (caught) {
      setFolderError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setFolderPicking(false);
    }
  };
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('hiero-chat-sidebar-width'));
    return Number.isFinite(saved) && saved >= 120 ? saved : 200;
  });
  const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let latest = startWidth;
    const onMove = (moveEvent: PointerEvent): void => {
      latest = Math.max(120, Math.min(480, startWidth + moveEvent.clientX - startX));
      setSidebarWidth(latest);
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      localStorage.setItem('hiero-chat-sidebar-width', String(latest));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey); };
  }, [menu]);
  const sendKey = usePreferences((state) => state.values.sendKey);
  const autoScroll = usePreferences((state) => state.values.autoScroll);
  const logRef = useRef<HTMLDivElement>(null);
  const active = conversations.find((conv) => conv.id === activeId) ?? conversations[0];
  const messages = active?.messages ?? [];
  useEffect(() => {
    if (autoScroll && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [autoScroll, messages.length, streamingText]);
  const [jumpOpen, setJumpOpen] = useState(false);
  useEffect(() => { setJumpOpen(false); }, [activeId]);
  useEffect(() => {
    if (!jumpOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setJumpOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [jumpOpen]);
  const jumpToMessage = (index: number) => {
    setJumpOpen(false);
    const target = logRef.current?.querySelector<HTMLElement>(`[data-message-index="${index}"]`);
    if (!target) return;
    target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    target.classList.remove('chat-message-flash');
    void target.offsetWidth;
    target.classList.add('chat-message-flash');
  };
  const [images, setImages] = useState<string[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addImageFiles = (files: File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith('image/'));
    if (imageFiles.length === 0) return;
    const room = MAX_CHAT_IMAGES - images.length;
    if (room <= 0) { setImageError(`最多上传 ${MAX_CHAT_IMAGES} 张图片`); return; }
    Promise.all(imageFiles.slice(0, room).map(readImageAsDataUrl))
      .then((urls) => { setImages((current) => [...current, ...urls].slice(0, MAX_CHAT_IMAGES)); setImageError(imageFiles.length > room ? `最多上传 ${MAX_CHAT_IMAGES} 张图片` : null); })
      .catch((cause: unknown) => setImageError(cause instanceof Error ? cause.message : '图片处理失败'));
  };
  const onPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.some((file) => file.type.startsWith('image/'))) {
      event.preventDefault();
      addImageFiles(files);
    }
  };
  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    addImageFiles(Array.from(event.dataTransfer.files));
  };
  const submit = () => {
    if (!draft.trim() && images.length === 0) return;
    send(draft, images);
    setDraft('');
    setImages([]);
    setImageError(null);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    const submitKey = sendKey === 'mod-enter' ? event.ctrlKey || event.metaKey : !event.shiftKey;
    if (submitKey) { event.preventDefault(); submit(); }
  };
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const rename = (id: string) => {
    const conv = conversations.find((item) => item.id === id);
    if (!conv) return;
    setConfirmDeleteId(null);
    renameSkipRef.current = false;
    setEditing({ id, title: conv.title });
  };
  const renameSkipRef = useRef(false);
  const commitRename = () => {
    if (!editing) return;
    if (renameSkipRef.current) { renameSkipRef.current = false; setEditing(null); return; }
    const title = editing.title.trim();
    if (title) renameConversation(editing.id, title);
    setEditing(null);
  };
  const remove = (id: string) => {
    setEditing(null);
    setConfirmDeleteId(id);
  };
  const confirmRemove = (id: string) => {
    setConfirmDeleteId(null);
    deleteConversation(id);
  };
  const renameInput = (id: string) => editing?.id === id
    ? <input className="chat-rename-input" autoFocus value={editing.title} onChange={(event) => setEditing({ id, title: event.target.value })} onBlur={commitRename} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitRename(); } if (event.key === 'Escape') { renameSkipRef.current = true; setEditing(null); } }} />
    : null;
  const deleteConfirm = (id: string) => confirmDeleteId === id
    ? <span className="chat-delete-confirm"><button type="button" className="chat-text-button danger" onClick={() => confirmRemove(id)}>确认删除</button><button type="button" className="chat-text-button" onClick={() => setConfirmDeleteId(null)}>取消</button></span>
    : null;
  const openMenu = (event: ReactMouseEvent, id: string) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, id });
  };
  const sessionUsage = summarizeSessionUsage(messages);
  return <section className="panel-content chat-panel">
    <div className="chat-layout" style={{ gridTemplateColumns: `${sidebarWidth}px 6px minmax(0, 1fr)` }}>
      <aside className="chat-sidebar">
        <button className="primary-button" type="button" onClick={newConversation} disabled={pending}>+ 新对话</button>
        <ul className="chat-history">
          {conversations.map((conv) => <li key={conv.id} className="chat-history-row" onContextMenu={(event) => openMenu(event, conv.id)}>
            {renameInput(conv.id) ?? <button type="button" className={conv.id === active?.id ? 'chat-history-item active' : 'chat-history-item'} onClick={() => selectConversation(conv.id)}>{conv.title}</button>}
            {deleteConfirm(conv.id)}
            <div className="chat-history-actions">
              <button type="button" className="chat-icon-button" title="重命名" aria-label="重命名" onClick={() => rename(conv.id)} disabled={pending}><PencilIcon /></button>
              <button type="button" className="chat-icon-button" title="删除" aria-label="删除" onClick={() => remove(conv.id)} disabled={pending}><TrashIcon /></button>
            </div>
          </li>)}
        </ul>
      </aside>
      <div className="chat-splitter" role="separator" aria-orientation="vertical" aria-label="调整对话侧栏宽度" onPointerDown={startSidebarResize} />
      <div className="chat-main">
        <div className="chat-title-row" onContextMenu={(event) => { if (active) openMenu(event, active.id); }}>
          <header className="panel-header"><span className="eyebrow">对话</span><h2>{active?.title ?? '新对话'}</h2></header>
          {active && deleteConfirm(active.id)}
          {active && <div className="chat-title-actions">
            <button className="chat-icon-button" type="button" title="跳转到消息" aria-label="跳转到消息" aria-expanded={jumpOpen} onClick={() => setJumpOpen((open) => !open)} disabled={!messages.some((m) => m.role === 'user')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h13" /></svg>
            </button>
            <button className="chat-icon-button" type="button" title="重命名" aria-label="重命名" onClick={() => rename(active.id)} disabled={pending}><PencilIcon /></button>
            <button className="chat-icon-button" type="button" title="删除" aria-label="删除" onClick={() => remove(active.id)} disabled={pending}><TrashIcon /></button>
          </div>}
        </div>
        {menu && <div className="chat-context-menu" style={{ left: menu.x, top: menu.y }}>
          <button type="button" disabled={pending} onClick={() => { setMenu(null); rename(menu.id); }}>重命名</button>
          <button type="button" disabled={pending} onClick={() => { setMenu(null); remove(menu.id); }}>删除</button>
        </div>}
        {jumpOpen && <div className="chat-jump-panel" role="listbox" aria-label="消息跳转">
          {messages.map((message, index) => message.role === 'user' ? <button type="button" role="option" aria-selected={false} key={index} className="chat-jump-item" onClick={() => jumpToMessage(index)}>
            <span className="chat-jump-index">{index + 1}</span>
            <span className="chat-jump-text">{message.content.replace(/\s+/g, ' ').trim() || '（图片或文件）'}</span>
          </button> : null)}
        </div>}
        {sessionUsage.calls > 0 && <div className="chat-session-usage" title="本会话所有助手回复的模型调用合计（成本为估算）">
          会话合计：模型调用 {sessionUsage.calls} 次 · 输入 {sessionUsage.input_tokens} / 输出 {sessionUsage.output_tokens} tokens · 成本 {formatCost(sessionUsage.costUsd)}
        </div>}
        <div className="chat-log" ref={logRef}>
          {messages.length === 0 && !pending && <p className="chat-empty">{sendKey === 'mod-enter' ? '输入问题开始对话。Ctrl/Cmd+Enter 发送，Enter 换行。' : '输入问题开始对话。Enter 发送，Shift+Enter 换行。'}</p>}
          {messages.map((message, index) => <ChatMessageView key={index} anchorIndex={index} role={message.role} content={message.content} images={message.images} files={message.files} steps={message.steps} usage={message.usage} model={message.model} trace={message.trace} completedAt={message.completedAt} onRewind={message.role === 'user' ? () => rewindConversation(index) : undefined} rewindDisabled={pending} />)}
          {pending && (streamingText || streamingSteps.length > 0) && <ChatMessageView role="assistant" content={streamingText} steps={streamingSteps} />}
          {pending && !streamingText && <div className="chat-loader" role="status" aria-label="思考中"><span /><span /><span /></div>}
        </div>
        {error && <p className="chat-error">{error}</p>}
        {folderError && <p className="chat-error">{folderError}</p>}
        <div className="chat-composer" onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={onDrop}>
          <div className="chat-input-box">
            {(images.length > 0 || imageError) && <div className="chat-attachments">
              {images.map((src, index) => <div key={index} className="chat-attachment">
                <img src={src} alt={`待发送图片 ${index + 1}`} />
                <button type="button" aria-label="移除图片" title="移除" onClick={() => { setImages((current) => current.filter((_, i) => i !== index)); setImageError(null); }}>✕</button>
              </div>)}
              {imageError && <span className="chat-attachment-error">{imageError}</span>}
            </div>}
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} onPaste={onPaste} placeholder="发送消息给 Hiero……（可粘贴或拖入图片）" />
            <div className="chat-toolbar">
              <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(event) => { addImageFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
              <button className="chat-attach-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={pending || images.length >= MAX_CHAT_IMAGES} aria-label="添加图片" title="添加图片">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              </button>
              <details className="chat-tool-details">
                <summary className="chat-pill chat-pill-summary" title="发送前选择权限模式"><span className="chat-pill-label">权限</span><span className="chat-pill-value">{options.permission}</span><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg></summary>
                <div className="chat-tool-panel">
                  <PermissionModePicker value={isPermissionLabel(options.permission) ? options.permission : '标准'} disabled={pending} onChange={(value) => setOption('permission', value)} />
                </div>
              </details>
              <ChatOptionSelect label="模型" value={options.model} options={CHAT_MODEL_OPTIONS} disabled={pending} onChange={(value) => setOption('model', value)} />
              <ChatOptionSelect label="上下文" value={options.contextMode} options={CHAT_CONTEXT_OPTIONS} disabled={pending} onChange={(value) => setOption('contextMode', value)} />
              <span className="chat-toolbar-spacer" />
              {pending
                ? <button className="chat-send-round chat-stop-round" type="button" onClick={cancel} title="停止生成" aria-label="停止生成">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
                  </button>
                : <button className="chat-send-round" type="button" onClick={submit} disabled={!draft.trim() && images.length === 0} title={!draft.trim() && images.length === 0 ? '请先输入内容或添加图片' : '发送'} aria-label="发送">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
                  </button>}
            </div>
          </div>
          <label className="chat-workspace-row"><span>工作区</span><input value={options.workspace} disabled={pending} placeholder="绝对路径" onChange={(event) => setOption('workspace', event.target.value)} /><button type="button" className="chat-folder-button" disabled={pending || folderPicking} onClick={() => { void pickWorkspaceFolder(); }} title="选择文件夹" aria-label="选择文件夹">…</button></label>
        </div>
      </div>
    </div>
  </section>;
}
function ChatOptionSelect({ label, value, options, disabled, onChange }: { label: string; value: string; options: string[]; disabled: boolean; onChange: (value: string) => void }): ReactElement {
  return <label className="chat-pill">
    <span className="chat-pill-label">{label}</span>
    <span className="chat-pill-value">{value}</span>
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
    <select className="chat-pill-select" aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option}>{option}</option>)}</select>
  </label>;
}

function MissionControl(): ReactElement {
  const [goal, setGoal] = useState('');
  const [model, setModel] = useState('gpt-5.6-luna');
  const [permission, setPermissionState] = useState<PermissionLabel>(readStoredPermission);
  const setPermission = (value: PermissionLabel) => {
    storePermission(value);
    setPermissionState(value);
  };
  const workspace = useChatStore((state) => state.options.workspace);
  const setWorkspace = (value: string) => useChatStore.getState().setOption('workspace', value);
  const [contextMode, setContextMode] = useState('临时会话');
  const [started, setStarted] = useState(false);
  const [criteria, setCriteria] = useState('');
  const [budget, setBudget] = useState<TaskCardBudget>({ ...DEFAULT_BUDGET });
  const [confirmed, setConfirmed] = useState(false);
  const draft = { goal, criteria, budget };
  const validation = validateTaskCard(draft);
  const changeGoal = (value: string) => {
    setGoal(value);
    setConfirmed(false);
  };
  const changePermission = (value: PermissionLabel) => {
    setPermission(value);
    setConfirmed(false);
  };
  const launch = () => {
    if (validation || !confirmed) return;
    const nextGoal = goal.trim();
    setStarted(true);
    setConfirmed(false);
    const socket = new WebSocket(RUNTIME_WS_URL);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ goal: nextGoal, task: { workspace_path: workspace, model_config: { preferred_model: model, fallback_chain: [] }, permission_mode: toPermissionMode(permission), context_mode: contextMode === '持久化 Markdown' ? 'persistent_md' : 'ephemeral', ...toContractFields(draft) } }));
      window.setTimeout(() => socket.close(), 500);
    });
  };
  return <section className="panel-content"><PanelHeader eyebrow="任务控制台" title="开始一个任务" /><label className="field-label" htmlFor="goal">你希望 Hiero 做什么？</label><textarea id="goal" value={goal} onChange={(event) => changeGoal(event.target.value)} placeholder="描述你想要达成的结果……" /><div className="field-grid"><Select label="模型" value={model} onChange={setModel} options={['gpt-5.6-luna', 'Claude Sonnet 4', 'GPT-5', '本地 Qwen']} /><div className="field-wide"><span className="field-label">权限模式（启动前确认）</span><PermissionModePicker value={permission} onChange={changePermission} /></div><label className="chat-option chat-option-wide"><span>工作区</span><input value={workspace} onChange={(event) => setWorkspace(event.target.value)} placeholder="绝对路径" /></label><Select label="上下文模式" value={contextMode} onChange={setContextMode} options={['临时会话', '持久化 Markdown']} /></div><TaskCard summary={{ goal: goal.trim(), workspace, model, permissionLabel: permission, contextMode }} criteria={criteria} budget={budget} onCriteriaChange={setCriteria} onBudgetChange={setBudget} confirmed={confirmed} onConfirmedChange={setConfirmed} disabled={started} /><button className="primary-button" type="button" onClick={launch} disabled={started || !confirmed || validation !== null}>{started ? '任务已发送' : '启动任务'} <span>→</span></button>{validation && <p className="task-card-hint">{validation}</p>}<div style={{ marginTop: 12 }}><RollbackButton /></div></section>;
}


function Select({ label, options, value, onChange }: { label: string; options: string[]; value: string; onChange: (value: string) => void }): ReactElement {
  return <label className="select-wrap"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option}>{option}</option>)}</select></label>;
}

function PanelHeader({ eyebrow, title }: { eyebrow: string; title: string }): ReactElement {
  return <header className="panel-header"><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></header>;
}

type DevtoolsTab = 'console' | 'network' | 'runtime';

const DEVTOOLS_TABS: { id: DevtoolsTab; label: string }[] = [
  { id: 'console', label: 'Console' },
  { id: 'network', label: 'Network' },
  { id: 'runtime', label: 'Runtime' },
];

function formatClock(time: number): string {
  return new Date(time).toLocaleTimeString('zh-CN', { hour12: false });
}

function DebugConsole(): ReactElement {
  const devtools = useSyncExternalStore(subscribeDevtools, getDevtoolsSnapshot);
  const [tab, setTab] = useState<DevtoolsTab>('console');
  const [filter, setFilter] = useState('');
  const [prompt, setPrompt] = useState('');
  const outputRef = useRef<HTMLDivElement | null>(null);
  const needle = filter.trim().toLowerCase();
  const matches = (text: string) => !needle || text.toLowerCase().includes(needle);
  const consoleRows = devtools.console.filter((entry) => matches(entry.text));
  const networkRows = devtools.network.filter((entry) => matches(`${entry.method} ${entry.url} ${entry.status ?? ''}`));
  const runtimeRows = devtools.runtime.filter((entry) => matches(`${entry.type} ${entry.detail}`));
  const counts = { error: devtools.console.filter((entry) => entry.level === 'error').length, warn: devtools.console.filter((entry) => entry.level === 'warn').length };
  useEffect(() => { outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight }); }, [devtools, tab]);
  const submit = (event: ReactFormEvent) => {
    event.preventDefault();
    const code = prompt.trim();
    if (!code) return;
    evaluateInPage(code);
    setPrompt('');
  };
  return <section className="panel-content devtools-panel">
    <div className="devtools-tabs" role="tablist">
      {DEVTOOLS_TABS.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}</button>)}
    </div>
    <div className="devtools-toolbar">
      <button type="button" onClick={clearConsoleEntries} aria-label="清空控制台" title="清空控制台">⊘</button>
      <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="筛选" aria-label="筛选日志" />
      {tab === 'console' && <span className="devtools-counts"><span className="count-error">✕ {counts.error}</span><span className="count-warn">⚠ {counts.warn}</span></span>}
    </div>
    <div className="devtools-output" ref={outputRef} aria-live="polite">
      {tab === 'console' && consoleRows.map((entry) => <div key={entry.id} className={`devtools-row level-${entry.level}`}><span className="devtools-time">{formatClock(entry.time)}</span><pre>{entry.text}</pre></div>)}
      {tab === 'network' && networkRows.map((entry) => <div key={entry.id} className={`devtools-row net-row ${entry.ok ? '' : 'level-error'}`}><span className="devtools-time">{formatClock(entry.time)}</span><span className="net-method">{entry.method}</span><span className="net-status">{entry.status ?? 'ERR'}</span><span className="net-url">{entry.url}</span><span className="net-time">{entry.durationMs} ms</span></div>)}
      {tab === 'runtime' && runtimeRows.map((entry) => <div key={entry.id} className="devtools-row"><span className="devtools-time">{formatClock(entry.time)}</span><span className="net-method">{entry.type}</span><pre>{entry.detail}</pre></div>)}
      {tab === 'console' && consoleRows.length === 0 && <p className="devtools-empty">控制台为空</p>}
    </div>
    {tab === 'console' && <form className="devtools-prompt" onSubmit={submit}>
      <span>›</span>
      <input value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="在页面上下文中执行 JavaScript" aria-label="控制台输入" />
    </form>}
  </section>;
}

function TodoList(): ReactElement {
  const [currentNode, setCurrentNode] = useState('Plan');
  const [verify, setVerify] = useState<{ verified: boolean; checks: { criterion: string; status: string; reason?: string }[] } | null>(null);
  const [rewind, setRewind] = useState<{ restored: string[]; skipped: string[] } | null>(null);
  useEffect(() => connectRuntime((message) => {
    if (message.type === 'VERIFY_RESULT') { setVerify(message.payload as unknown as typeof verify); return; }
    if (message.type === 'REWIND_RESULT') { setRewind(message.payload as unknown as typeof rewind); return; }
    if (message.type !== 'STATE_CHANGE') return;
    const node = typeof message.payload?.node === 'string' ? message.payload.node : undefined;
    const status = typeof message.payload?.status === 'string' ? message.payload.status : undefined;
    if (node && status) setCurrentNode(node);
  }), []);
  const statuses: TodoStatus[] = TODO_ITEMS.map((_, index) => index < Math.max(0, ['Plan', 'Exec', 'Verify', 'Handoff'].indexOf(currentNode)) ? 'done' : index === Math.max(0, ['Plan', 'Exec', 'Verify', 'Handoff'].indexOf(currentNode)) ? 'active' : 'pending');
  return <section className="panel-content"><PanelHeader eyebrow="状态机" title="待办清单" /><div className="todo-list">{TODO_ITEMS.map((label, index) => <div className={`todo-item ${statuses[index]}`} key={label}><span className="todo-mark">{statuses[index] === 'done' ? '✓' : statuses[index] === 'active' ? '◌' : ''}</span><span>{label}</span></div>)}</div><p className="todo-note">仅根据状态机广播同步 · 当前节点：{currentNode}</p>{verify && <div className={`verify-result ${verify.verified ? 'passed' : 'failed'}`}><strong>{verify.verified ? 'Verify passed' : 'Verify failed'}</strong>{verify.checks.map((check) => <div className="verify-check" key={check.criterion}><span>{check.status}</span> {check.criterion}{check.reason ? <em> ({check.reason})</em> : null}</div>)}</div>}{rewind && <div className="rewind-result"><strong>Rewind</strong> restored {rewind.restored.length} file(s){rewind.skipped.length > 0 ? `, skipped ${rewind.skipped.length} human-edited` : ''}</div>}</section>;
}

const DiffEditor = lazy(async () => {
  const { DiffEditor: MonacoDiffEditor } = await import('@monaco-editor/react');
  return { default: MonacoDiffEditor };
});

function CodeReview(): ReactElement {
  const [diff, setDiff] = useState({ path: '等待 FILE_DIFF 事件', original: '', modified: '' });
  useEffect(() => connectRuntime((message) => {
    if (message.type !== 'FILE_DIFF' || typeof message.payload?.path !== 'string') return;
    setDiff({ path: message.payload.path, original: typeof message.payload.original === 'string' ? message.payload.original : '', modified: typeof message.payload.modified === 'string' ? message.payload.modified : '' });
  }), []);
  return <section className="panel-content review-panel"><PanelHeader eyebrow="代码审查" title="文件修改对比" /><div className="diff-path">{diff.path}</div><div className="editor-frame"><Suspense fallback={<div className="editor-loading">正在加载代码编辑器…</div>}><DiffEditor height="100%" language="typescript" original={diff.original} modified={diff.modified} theme="vs-dark" options={{ readOnly: true, minimap: { enabled: false }, renderSideBySide: true }} /></Suspense></div></section>;
}

function HandoffPanel(): ReactElement {
  const [handoff, setHandoff] = useState<Record<string, unknown> | null>(null);
  useEffect(() => connectRuntime((message) => { if (message.type === 'HANDOFF_TRIGGERED') setHandoff(message.payload ?? null); }), []);
  return <section className={`panel-content handoff-panel ${handoff ? 'has-handoff' : ''}`}><PanelHeader eyebrow="上下文交接" title="Handoff Document" />{handoff ? <div className="handoff-card"><HandoffField label="任务目标" value={handoff.task_goal} /><HandoffField label="当前状态" value={handoff.current_state} /><HandoffField label="下一步" value={handoff.next_steps} /><HandoffField label="已完成步骤" value={handoff.completed_steps} /></div> : <div className="empty-state">等待后端广播 HANDOFF_TRIGGERED<br /><span>交接文档生成后将在这里显示</span></div>}</section>;
}

function HandoffField({ label, value }: { label: string; value: unknown }): ReactElement { return <div className="handoff-field"><span>{label}</span><p>{Array.isArray(value) ? value.join('、') : String(value ?? '—')}</p></div>; }


let openBufferFromPanel: ((kind: PanelKind) => void) | null = null;

function BlankBuffer(): ReactElement {
  const [command, setCommand] = useState('');
  const [output, setOutput] = useState<string[]>([]);
  const run = () => {
    const kind = resolveCommand(command);
    const text = command.trim();
    if (kind && openBufferFromPanel) {
      openBufferFromPanel(kind);
      setOutput((current) => [...current, `> ${text.toUpperCase()} → 已打开 ${PANEL_TITLES[kind]}`]);
    } else {
      setOutput((current) => [...current, `> ${text} · 未知命令`]);
    }
    setCommand('');
  };
  return <section className="panel-content blank-panel"><PanelHeader eyebrow="命令入口" title="空缓存窗口" /><form className="command-bar" onSubmit={(event) => { event.preventDefault(); if (command.trim()) run(); }}><span className="command-prompt">&gt;</span><input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="输入命令：MS / DBG / TODO / REV / HO" aria-label="缓存窗口命令" /></form><div className="console-output">{output.map((line, index) => <p key={index}>{line}</p>)}</div></section>;
}

function SettingsBuffer(): ReactElement {
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });
  const [mcpConfig, setMcpConfig] = useState<McpConfigState | null>(null);
  const [mcpSaveState, setMcpSaveState] = useState<McpSaveState>({ status: 'idle' });
  const socketRef = useRef<WebSocket | null>(null);
  const saveModel = (input: { endpoint: string; model: string; tokens: string }) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setSaveState({ status: 'error', message: '未连接到后端（localhost:8080），请先启动后端再保存。' });
      return;
    }
    setSaveState({ status: 'saving' });
    socket.send(JSON.stringify({ type: 'settings_save', payload: input }));
  };
  const saveMcp = (servers: McpServerEntry[]) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setMcpSaveState({ status: 'error', message: '未连接到后端（localhost:8080），请先启动后端再保存。' });
      return;
    }
    setMcpSaveState({ status: 'saving' });
    socket.send(JSON.stringify({ type: 'mcp_config_save', payload: { servers } }));
  };
  useEffect(() => {
    let active = true;
    const socket = new WebSocket(RUNTIME_WS_URL);
    socketRef.current = socket;
    socket.onopen = () => {
      if (!active) return;
      socket.send(JSON.stringify({ type: 'settings_get' }));
      socket.send(JSON.stringify({ type: 'mcp_config_get' }));
    };
    socket.onmessage = (event) => {
      if (!active) return;
      try {
        const message = JSON.parse(String(event.data)) as RuntimeMessage;
        if (message.type === 'SETTINGS') setSettings(message.payload as unknown as ModelSettings);
        if (message.type === 'MCP_CONFIG') setMcpConfig(message.payload as unknown as McpConfigState);
        if (message.type === 'MCP_CONFIG_SAVE_RESULT') {
          const result = message.payload as unknown as { ok: true; servers: McpServerEntry[]; statuses: McpServerStatus[]; path: string } | { ok: false; message: string };
          if (result.ok) {
            setMcpConfig({ servers: result.servers, statuses: result.statuses, path: result.path });
            setMcpSaveState({ status: 'saved' });
          } else {
            setMcpSaveState({ status: 'error', message: result.message });
          }
        }
        if (message.type === 'SETTINGS_SAVE_RESULT') {
          const result = message.payload as unknown as { ok: boolean; message?: string; settings?: ModelSettings };
          if (result.ok && result.settings) {
            setSettings(result.settings);
            setSaveState({ status: 'saved', tokenCount: result.settings.token_count });
          } else {
            setSaveState({ status: 'error', message: result.message ?? '保存失败' });
          }
        }
      } catch { /* Ignore non-JSON runtime messages. */ }
    };
    socket.onerror = () => { if (active) setSettings(null); };
    return () => {
      active = false;
      socketRef.current = null;
      socket.close();
    };
  }, []);
  return <section className="panel-content"><PanelHeader eyebrow="配置" title="设置" /><SettingsPanel modelSettings={settings} saveState={saveState} onSaveModel={saveModel} mcpConfig={mcpConfig} mcpSaveState={mcpSaveState} onSaveMcp={saveMcp} /></section>;
}

function normalizeBrowserUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function BrowserBuffer({ api }: { api: { id: string } }): ReactElement {
  const bufferId = api.id;
  const url = useWorkspaceStore((state) => state.browserUrls[bufferId] ?? '');
  const setBrowserUrl = useWorkspaceStore((state) => state.setBrowserUrl);
  const [draft, setDraft] = useState(url);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const navigate = (raw: string) => {
    const next = normalizeBrowserUrl(raw);
    if (!next) {
      setError('请输入有效的 http 或 https 链接');
      return;
    }
    setError(null);
    setDraft(next);
    setBrowserUrl(bufferId, next);
  };
  const submit = (event: ReactFormEvent) => {
    event.preventDefault();
    navigate(draft);
  };
  return <section className="panel-content browser-panel">
    <form className="browser-toolbar" onSubmit={submit}>
      <button type="button" onClick={() => setReloadKey((key) => key + 1)} disabled={!url} aria-label="刷新">↻</button>
      <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="输入链接，例如 example.com" aria-label="浏览器地址" />
      <button type="submit">前往</button>
      {url && <a href={url} target="_blank" rel="noreferrer">外部打开</a>}
    </form>
    {error && <p className="browser-error">{error}</p>}
    {url
      ? <iframe key={reloadKey} className="browser-frame" src={url} title={url} sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox" />
      : <div className="empty-state">输入链接后在此打开页面<br /><span>部分网站禁止嵌入，可点击"外部打开"</span></div>}
  </section>;
}

interface WorkspaceEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  size: number;
  modified: number;
}

type SkillScope = 'project' | 'user' | 'agents' | 'codex';
const SKILL_SCOPE_LABELS: Record<SkillScope, string> = { project: '项目', user: '用户', agents: '通用', codex: 'Codex' };
type SkillRecord = { id: string; name: string; scope: SkillScope; description: string; path: string; size: number };

type WorkspaceRequestBody = { workspace?: string } & (
  | { type: 'folder_pick'; initialPath?: string }
  | { type: 'fs_list'; path?: string }
  | { type: 'fs_read'; path: string }
  | { type: 'term_exec'; command: string; cwd?: string; permission?: string }
  | { type: 'skill_list' }
  | { type: 'skill_read'; scope: SkillScope; name: string }
  | { type: 'skill_save'; scope: SkillScope; name: string; content: string }
  | { type: 'skill_delete'; scope: SkillScope; name: string }
  | { type: 'memory_read'; scope: MemoryScope }
  | { type: 'memory_save'; scope: MemoryScope; content: string }
  | { type: 'deep_memory_list' }
  | { type: 'deep_memory_delete'; scope: MemoryScope; id: string }
);

type MemoryScope = 'global' | 'project';
type DeepMemoryEntry = { id: string; scope: MemoryScope; content: string; tags: string[]; created_at: string };
const MEMORY_SCOPE_LABELS: Record<MemoryScope, string> = { global: '全局准则', project: '项目记忆' };

function requestWorkspace(body: WorkspaceRequestBody): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const socket = new WebSocket(RUNTIME_WS_URL);
    const timer = window.setTimeout(() => { socket.close(); reject(new Error('请求超时，运行时无响应')); }, 60_000);
    const workspace = useChatStore.getState().options.workspace;
    socket.onopen = () => socket.send(JSON.stringify({ ...body, workspace, request_id: requestId }));
    socket.onerror = () => { window.clearTimeout(timer); reject(new Error('无法连接运行时 ' + RUNTIME_WS_URL)); };
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as RuntimeMessage;
      if (message.type !== 'WORKSPACE_RESULT' || message.payload?.request_id !== requestId) return;
      window.clearTimeout(timer);
      socket.close();
      if (message.payload.ok === true) resolve(message.payload);
      else reject(new Error(String(message.payload.message ?? '请求失败')));
    };
  });
}

type ApprovalRequest = { approval_id: string; tool_name: string; summary: string; input: unknown };

/** Listens for APPROVAL_REQUIRED on a persistent socket and answers with approval_response. */
function ApprovalModal(): ReactElement | null {
  const [queue, setQueue] = useState<ApprovalRequest[]>([]);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let active = true;
    const socket = new WebSocket(RUNTIME_WS_URL);
    socketRef.current = socket;
    socket.onmessage = (event) => {
      let message: RuntimeMessage;
      try { message = JSON.parse(String(event.data)) as RuntimeMessage; } catch { return; }
      if (!active || message.type !== 'APPROVAL_REQUIRED' || !message.payload) return;
      const payload = message.payload as unknown as ApprovalRequest;
      setQueue((current) => [...current, payload]);
    };
    return () => { active = false; socketRef.current = null; socket.close(); };
  }, []);

  const current = queue[0];
  if (!current) return null;

  const respond = (approved: boolean) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'approval_response', payload: { approval_id: current.approval_id, approved } }));
    }
    setQueue((rest) => rest.slice(1));
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="操作审批" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: '#1e1e1e', color: '#eee', padding: 20, borderRadius: 8, maxWidth: 560, width: '90%' }}>
        <h3 style={{ marginTop: 0 }}>需要审批：{current.tool_name}</h3>
        <p>{current.summary}</p>
        <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto', background: '#111', padding: 8 }}>{JSON.stringify(current.input, null, 2)}</pre>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={() => respond(false)}>拒绝</button>
          <button type="button" onClick={() => respond(true)}>同意</button>
        </div>
      </div>
    </div>
  );
}

type RollbackPayload = { ok: boolean; restored?: string[]; skipped?: string[]; warning?: { code: string; message: string }; message?: string };

/** Sends write_rollback and reports restored files, plus RBK-006 when human edits were kept. */
function RollbackButton(): ReactElement {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const rollback = () => {
    setBusy(true);
    setResult(null);
    const socket = new WebSocket(RUNTIME_WS_URL);
    const finish = (text: string) => { setResult(text); setBusy(false); socket.close(); };
    socket.onopen = () => socket.send(JSON.stringify({ type: 'write_rollback' }));
    socket.onerror = () => finish('回退失败：无法连接后端。');
    socket.onmessage = (event) => {
      let message: RuntimeMessage;
      try { message = JSON.parse(String(event.data)) as RuntimeMessage; } catch { return; }
      if (message.type !== 'ROLLBACK_RESULT' || !message.payload) return;
      const payload = message.payload as unknown as RollbackPayload;
      if (!payload.ok) { finish(`回退失败：${payload.message ?? '未知错误'}`); return; }
      const parts = [`已回退 ${payload.restored?.length ?? 0} 个文件。`];
      if (payload.skipped?.length) parts.push(`${payload.warning?.code ?? 'RBK-006'}：以下文件由人工修改过，已保留：${payload.skipped.join('，')}`);
      finish(parts.join(' '));
    };
  };

  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
      <button type="button" onClick={rollback} disabled={busy}>{busy ? '回退中…' : '回退上一次写入'}</button>
      {result ? <span role="status">{result}</span> : null}
    </span>
  );
}

const SKILL_CATEGORIES = ['MCP 服务器', '技能', '指令', '智能体', '挂钩', '工具'] as const;
type SkillCategory = (typeof SKILL_CATEGORIES)[number];

function McpCategoryView(): ReactElement {
  const [config, setConfig] = useState<McpConfigState | null>(null);
  const [saveState, setSaveState] = useState<McpSaveState>({ status: 'idle' });
  const socketRef = useRef<WebSocket | null>(null);
  useEffect(() => {
    let active = true;
    const socket = new WebSocket(RUNTIME_WS_URL);
    socketRef.current = socket;
    socket.onopen = () => { if (active) socket.send(JSON.stringify({ type: 'mcp_config_get' })); };
    socket.onmessage = (event) => {
      if (!active) return;
      try {
        const message = JSON.parse(String(event.data)) as RuntimeMessage;
        if (message.type === 'MCP_CONFIG') setConfig(message.payload as unknown as McpConfigState);
        if (message.type === 'MCP_CONFIG_SAVE_RESULT') {
          const result = message.payload as unknown as { ok: true; servers: McpServerEntry[]; statuses: McpServerStatus[]; path: string } | { ok: false; message: string };
          if (result.ok) {
            setConfig({ servers: result.servers, statuses: result.statuses, path: result.path });
            setSaveState({ status: 'saved' });
          } else {
            setSaveState({ status: 'error', message: result.message });
          }
        }
      } catch { /* Ignore non-JSON runtime messages. */ }
    };
    socket.onerror = () => { if (active) setSaveState({ status: 'error', message: '未连接到后端（localhost:8080）。' }); };
    return () => { active = false; socketRef.current = null; socket.close(); };
  }, []);
  const save = (servers: McpServerEntry[]) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setSaveState({ status: 'error', message: '未连接到后端（localhost:8080），请先启动后端再保存。' });
      return;
    }
    setSaveState({ status: 'saving' });
    socket.send(JSON.stringify({ type: 'mcp_config_save', payload: { servers } }));
  };
  return <div className="skills-editor"><McpServersForm config={config} saveState={saveState} onSave={save} /></div>;
}

function SkillsBuffer(): ReactElement {
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [category, setCategory] = useState<SkillCategory>('技能');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    setError(null);
    requestWorkspace({ type: 'skill_list' })
      .then((payload) => setSkills((payload.skills as SkillRecord[]) ?? []))
      .catch((cause: Error) => setError(cause.message));
  };
  useEffect(refresh, []);

  const open = (skill: SkillRecord) => {
    setSelectedId(skill.id);
    setStatus(null);
    requestWorkspace({ type: 'skill_read', scope: skill.scope, name: skill.name })
      .then((payload) => { const text = String(payload.content ?? ''); setDraft(text); setSaved(text); })
      .catch((cause: Error) => setError(cause.message));
  };

  const selected = skills.find((skill) => skill.id === selectedId) ?? null;
  const dirty = draft !== saved;

  const save = () => {
    if (!selected) return;
    requestWorkspace({ type: 'skill_save', scope: selected.scope, name: selected.name, content: draft })
      .then(() => { setSaved(draft); setStatus('已保存'); refresh(); })
      .catch((cause: Error) => setError(cause.message));
  };

  const remove = () => {
    if (!selected || !window.confirm(`删除技能 ${selected.name}？此操作会删除其目录。`)) return;
    requestWorkspace({ type: 'skill_delete', scope: selected.scope, name: selected.name })
      .then(() => { setSelectedId(null); setDraft(''); setSaved(''); setStatus('已删除'); refresh(); })
      .catch((cause: Error) => setError(cause.message));
  };

  return (
    <div className="skills-panel">
      <nav className="skills-categories" aria-label="分类">
        {SKILL_CATEGORIES.map((item) => (
          <button key={item} type="button" className={item === category ? 'active' : ''} onClick={() => setCategory(item)}>
            <span>{item}</span>
            <b>{item === '技能' ? skills.length : 0}</b>
          </button>
        ))}
      </nav>
      <div className="skills-main">
        {category === 'MCP 服务器' && <McpCategoryView />}
        {category !== '技能' && category !== 'MCP 服务器' && <p className="skills-empty">{category} 暂未接入数据源。</p>}
        {category === '技能' && (
          <div className="skills-body">
            <ul className="skills-list">
              {skills.map((skill) => (
                <li key={skill.id}>
                  <button type="button" className={skill.id === selectedId ? 'active' : ''} onClick={() => open(skill)}>
                    <strong>{skill.name}</strong>
                    <small>{SKILL_SCOPE_LABELS[skill.scope]} · {skill.description || '无描述'}</small>
                  </button>
                </li>
              ))}
              {skills.length === 0 && <li className="skills-empty">未找到技能。可在 .agent/skills、~/.copilot/skills 或 ~/.agents/skills 下新建 &lt;name&gt;/SKILL.md。</li>}
            </ul>
            <div className="skills-editor">
              {selected ? (
                <>
                  <div className="skills-editor-head">
                    <span>{selected.path}</span>
                    <button type="button" onClick={save} disabled={!dirty}>保存</button>
                    <button type="button" onClick={remove}>删除</button>
                  </div>
                  <textarea value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} aria-label="SKILL.md 内容" />
                </>
              ) : <p className="skills-empty">选择一个技能以查看或编辑。</p>}
              {status && <p className="skills-status">{status}</p>}
              {error && <p className="skills-error">{error}</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DeepMemoryBuffer(): ReactElement {
  const [entries, setEntries] = useState<DeepMemoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    requestWorkspace({ type: 'deep_memory_list' })
      .then((payload) => { setEntries(payload.entries as DeepMemoryEntry[]); setError(null); })
      .catch((cause: Error) => setError(cause.message));
  };

  useEffect(refresh, []);

  const remove = (entry: DeepMemoryEntry) => {
    requestWorkspace({ type: 'deep_memory_delete', scope: entry.scope, id: entry.id })
      .then(refresh)
      .catch((cause: Error) => setError(cause.message));
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
            {entries.map((entry) => (
              <li key={entry.id}>
                <small>{entry.scope === 'global' ? '全局' : '项目'} · {entry.created_at.slice(0, 16).replace('T', ' ')}{entry.tags.length ? ` · ${entry.tags.join(', ')}` : ''}</small>
                <p>{entry.content}</p>
                <button type="button" onClick={() => remove(entry)}>删除</button>
              </li>
            ))}
          </ul>
          {entries.length === 0 && <p className="skills-status">还没有深层记忆。模型可通过 memory_remember 写入，或在对话中让它记住事情。</p>}
          {error && <p className="skills-error">{error}</p>}
        </div>
      </div>
    </div>
  );
}

function MemoryBuffer(): ReactElement {
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
      {scope === 'deep' ? <DeepMemoryBuffer /> : <div className="skills-main">
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

let pendingFileOpen: string | null = null;
const fileOpenListeners = new Set<(path: string) => void>();

function requestOpenFile(path: string): void {
  pendingFileOpen = path;
  if (fileOpenListeners.size > 0) {
    fileOpenListeners.forEach((listener) => listener(path));
    pendingFileOpen = null;
    return;
  }
  openBufferFromPanel?.('files');
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

function FileManagerBuffer(): ReactElement {
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [selected, setSelected] = useState<WorkspaceEntry | null>(null);
  const [content, setContent] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<FileSortKey>('name');
  const [sortDesc, setSortDesc] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const previewRequest = useRef(0);
  const listRequest = useRef(0);

  const readFile = (entry: WorkspaceEntry) => {
    const requestId = ++previewRequest.current;
    setSelected(entry);
    setError(null);
    setContent('');
    setTruncated(false);
    setPreviewLoading(true);
    requestWorkspace({ type: 'fs_read', path: entry.path })
      .then((payload) => {
        if (requestId !== previewRequest.current) return;
        setContent(String(payload.content ?? ''));
        setTruncated(payload.truncated === true);
      })
      .catch((cause: Error) => { if (requestId === previewRequest.current) setError(cause.message); })
      .finally(() => { if (requestId === previewRequest.current) setPreviewLoading(false); });
  };

  const load = (nextPath: string, thenRead?: string) => {
    const requestId = ++listRequest.current;
    setError(null);
    setLoading(true);
    requestWorkspace({ type: 'fs_list', path: nextPath })
      .then((payload) => {
        if (requestId !== listRequest.current) return;
        const nextEntries = (payload.entries as WorkspaceEntry[]) ?? [];
        setPath(String(payload.path ?? ''));
        setEntries(nextEntries);
        setSelected(null);
        setContent('');
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
    if (entry.kind === 'dir') load(entry.path);
    else readFile(entry);
  };

  const onListKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (visible.length === 0) return;
    const index = selected ? visible.findIndex((entry) => entry.path === selected.path) : -1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = visible[Math.min(visible.length - 1, Math.max(0, index < 0 ? 0 : index + delta))];
      if (next.kind === 'file') readFile(next);
      else setSelected(next);
    } else if (event.key === 'Enter' && selected) {
      event.preventDefault();
      open(selected);
    } else if (event.key === 'Backspace' && path) {
      event.preventDefault();
      load(parent);
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
      <div className="files-table-wrap" tabIndex={0} onKeyDown={onListKey} role="listbox" aria-label="文件列表" aria-activedescendant={selected ? `file-${selected.path}` : undefined}>
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
            {!previewLoading && <pre className="files-preview">{content}{truncated && '\n…（内容已截断）'}</pre>}
          </>}
        </>}
      </aside>
    </div>
  </section>;
}

type TerminalLine = { kind: 'command'; prompt: string; text: string } | { kind: 'output'; text: string; failed: boolean };

type TerminalTab = { id: number; title: string };

function TerminalBuffer(): ReactElement {
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
    {tabs.map((tab) => <TerminalSession key={tab.id} hidden={tab.id !== activeId} />)}
  </section>;
}

function TerminalSession({ hidden }: { hidden: boolean }): ReactElement {
  const [command, setCommand] = useState('');
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [running, setRunning] = useState(false);
  const [root, setRoot] = useState('');
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const outputRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const prompt = `PS ${root}>`;
  const workspace = useChatStore((state) => state.options.workspace);
  useEffect(() => {
    requestWorkspace({ type: 'fs_list', path: '' }).then((payload) => { if (typeof payload.root === 'string') setRoot(payload.root); }).catch(() => undefined);
  }, [workspace]);
  useEffect(() => { if (!hidden) inputRef.current?.focus(); }, [hidden]);
  useEffect(() => { outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight }); }, [lines]);
  const run = (event: ReactFormEvent) => {
    event.preventDefault();
    const text = command.trim();
    if (!text || running) return;
    setRunning(true);
    setCommand('');
    setHistoryIndex(null);
    setCommandHistory((current) => [...current, text]);
    requestWorkspace({ type: 'term_exec', command: text, permission: '标准' })
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
    <div className="terminal-output" ref={outputRef} aria-live="polite" onClick={() => { if (window.getSelection()?.toString()) return; inputRef.current?.focus(); }}>
      <p className="wt-banner">Windows PowerShell{'\n'}命令在工作区根目录一次性执行（非交互式）。</p>
      {lines.map((line, index) => line.kind === 'command'
        ? <pre key={index} className="wt-command"><span className="wt-prompt">{line.prompt}</span> {line.text}</pre>
        : <pre key={index} className={line.failed ? 'wt-error' : 'wt-output'}>{line.text}</pre>)}
    </div>
    <form className="terminal-input" onSubmit={run}>
      <span className="wt-prompt">{running ? '' : prompt}</span>
      <input ref={inputRef} value={command} onChange={(event) => { setCommand(event.target.value); setHistoryIndex(null); }} onKeyDown={recall} placeholder={running ? '执行中……' : ''} aria-label="终端命令" disabled={running} autoComplete="off" spellCheck={false} />
    </form>
  </div>;
}

const panelComponents = { chat: ChatPanel, mission: MissionControl, debug: DebugConsole, todo: TodoList, review: CodeReview, handoff: HandoffPanel, settings: SettingsBuffer, browser: BrowserBuffer, terminal: TerminalBuffer, files: FileManagerBuffer, skills: SkillsBuffer, memory: MemoryBuffer, blank: BlankBuffer };

function FloatingCloseAction({ group, containerApi }: IDockviewHeaderActionsProps): ReactElement | null {
  if (group.model.location.type !== 'floating') return null;
  const close = () => group.panels.forEach((panel) => containerApi.removePanel(panel));
  return <button type="button" className="floating-close" onClick={close} aria-label="关闭窗口" title="关闭">×</button>;
}

function buildDefaultLayout(api: DockviewApi): void {
  const group = api.addGroup({ id: 'main', direction: 'within' });
  api.addPanel({ id: 'chat', component: 'chat', title: PANEL_TITLES.chat, position: { referenceGroup: group } });
  api.addPanel({ id: 'mission', component: 'mission', title: '任务控制台', position: { referencePanel: 'chat', direction: 'right' } });
  api.addPanel({ id: 'debug', component: 'debug', title: '调试控制台', position: { referencePanel: 'mission', direction: 'below' } });
  api.addPanel({ id: 'todo', component: 'todo', title: '待办清单', position: { referencePanel: 'mission', direction: 'right' } });
  api.addPanel({ id: 'review', component: 'review', title: '代码审查', position: { referencePanel: 'todo', direction: 'below' } });
  api.addPanel({ id: 'handoff', component: 'handoff', title: '交接文档', position: { referencePanel: 'review', direction: 'below' } });
}

function addBufferPanel(api: DockviewApi, id: string, kind: PanelKind): void {
  const offset = api.panels.filter((panel) => panel.id.startsWith('buffer-')).length * 28;
  api.addPanel({ id, component: kind, title: PANEL_TITLES[kind] });
  const panel = api.getPanel(id);
  if (!panel) return;
  api.addFloatingGroup(panel, { x: 160 + offset, y: 120 + offset, width: 520, height: 380 });
}

function CommandBar({ onRun }: { onRun: (kind: PanelKind) => void }): ReactElement {
  const [value, setValue] = useState('');
  const submit = () => {
    const kind = resolveCommand(value);
    if (kind) onRun(kind);
    setValue('');
  };
  return <form className="command-bar" onSubmit={(event) => { event.preventDefault(); submit(); }}><span className="command-prompt">&gt;</span><input value={value} onChange={(event) => setValue(event.target.value)} placeholder="输入命令：MS / DBG / TODO / REV / HO" aria-label="命令输入" /></form>;
}

function App(): ReactElement {
  const screens = useWorkspaceStore((state) => state.screens);
  const activeScreen = useWorkspaceStore((state) => state.activeScreen);
  const buffers = useWorkspaceStore((state) => state.buffers);
  const setSerializedLayout = useWorkspaceStore((state) => state.setSerializedLayout);
  const setActiveScreen = useWorkspaceStore((state) => state.setActiveScreen);
  const addScreen = useWorkspaceStore((state) => state.addScreen);
  const resetLayout = useWorkspaceStore((state) => state.resetLayout);
  const addBuffer = useWorkspaceStore((state) => state.addBuffer);
  const removeBuffer = useWorkspaceStore((state) => state.removeBuffer);
  const clearBuffers = useWorkspaceStore((state) => state.clearBuffers);
  const [api, setApi] = useState<DockviewApi | null>(null);
  const [screenDraft, setScreenDraft] = useState('');
  const hotEdgeSidebar = usePreferences((state) => state.values.hotEdgeSidebar);
  const [railOpen, setRailOpen] = useState(() => !usePreferences.getState().values.hotEdgeSidebar);
  const railHideTimer = useRef<number | undefined>(undefined);
  const railPinned = useRef(false);
  useEffect(() => {
    if (!hotEdgeSidebar) {
      setRailOpen(true);
      return;
    }
    setRailOpen(false);
    railPinned.current = false;
    const onMove = (event: PointerEvent): void => {
      if (event.clientX <= HOT_EDGE_PX) {
        window.clearTimeout(railHideTimer.current);
        setRailOpen(true);
      }
    };
    window.addEventListener('pointermove', onMove);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.clearTimeout(railHideTimer.current);
    };
  }, [hotEdgeSidebar]);
  const scheduleHideRail = (): void => {
    if (!hotEdgeSidebar || railPinned.current) return;
    window.clearTimeout(railHideTimer.current);
    railHideTimer.current = window.setTimeout(() => setRailOpen(false), HOT_EDGE_HIDE_DELAY_MS);
  };
  const keepRailOpen = (): void => window.clearTimeout(railHideTimer.current);
  const toggleRail = (): void => {
    railPinned.current = true;
    window.clearTimeout(railHideTimer.current);
    setRailOpen((open) => !open);
  };

  const openBuffer = (kind: PanelKind) => {
    if (!api) return;
    const id = addBuffer(kind);
    addBufferPanel(api, id, kind);
  };

  useEffect(() => {
    openBufferFromPanel = openBuffer;
  });

  useEffect(() => {
    applyPreferenceTheme(usePreferences.getState().values);
    return usePreferences.subscribe((state) => applyPreferenceTheme(state.values));
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.code === 'Space') {
        event.preventDefault();
        if (api) openBuffer('blank');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [api]);

  // Buffers are global across screens: suppress removal bookkeeping while the layout is rebuilt.
  const loadingRef = useRef(false);

  const loadLayout = (target: DockviewApi, layout: unknown) => {
    loadingRef.current = true;
    target.clear();
    let restored = false;
    if (layout) {
      try { target.fromJSON(layout as Parameters<DockviewApi['fromJSON']>[0]); restored = true; } catch { target.clear(); }
    }
    if (!restored) buildDefaultLayout(target);
    target.panels.filter((panel) => panel.id.startsWith('buffer-')).forEach((panel) => target.removePanel(panel));
    useWorkspaceStore.getState().buffers.forEach((buffer) => addBufferPanel(target, buffer.id, buffer.kind));
    loadingRef.current = false;
  };

  const onReady = (event: DockviewReadyEvent) => {
    setApi(event.api);
    const state = useWorkspaceStore.getState();
    loadLayout(event.api, state.screens[state.activeScreen]);
    event.api.onDidLayoutChange(() => { if (!loadingRef.current) setSerializedLayout(event.api.toJSON()); });
    event.api.onDidRemovePanel((panel) => { if (!loadingRef.current && panel.id.startsWith('buffer-')) removeBuffer(panel.id); });
  };

  const switchScreen = (name: string) => {
    if (!api || name === activeScreen) return;
    setActiveScreen(name);
    loadLayout(api, useWorkspaceStore.getState().screens[name]);
  };

  const onResetLayout = () => {
    if (!api) return;
    buffers.forEach((buffer) => { const panel = api.getPanel(buffer.id); if (panel) api.removePanel(panel); });
    clearBuffers();
    resetLayout();
    loadLayout(api, null);
  };

  const onCreateScreen = () => {
    const name = screenDraft.trim();
    if (!api || !name || screens[name] !== undefined) return;
    addScreen(name);
    loadLayout(api, null);
    setScreenDraft('');
  };

  const focusBuffer = (id: string) => api?.getPanel(id)?.api.setActive();

  const closeBuffer = (id: string) => {
    const panel = api?.getPanel(id);
    if (panel) api?.removePanel(panel);
    else removeBuffer(id);
  };

  const onClearBuffers = () => {
    if (!api) return;
    buffers.forEach((buffer) => { const panel = api.getPanel(buffer.id); if (panel) api.removePanel(panel); });
    clearBuffers();
  };

  return <main className="app-shell">
    <ApprovalModal />
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>HIERO</span></div>
      <nav className="screen-tabs" aria-label="工作区">
        {Object.keys(screens).map((name) => <button key={name} type="button" className={`screen-tab ${name === activeScreen ? 'active' : ''}`} onClick={() => switchScreen(name)}>{name}</button>)}
        <form className="screen-add" onSubmit={(event) => { event.preventDefault(); onCreateScreen(); }}><input value={screenDraft} onChange={(event) => setScreenDraft(event.target.value)} placeholder="新工作区" aria-label="新工作区名称" /></form>
      </nav>
      <span className="topbar-meta"><button type="button" className="layout-reset" onClick={onResetLayout}>重置布局</button> 个人 Agent 工作台 <span className="live-pill"><b /> 在线</span></span>
    </header>
    <div className="workspace-body">
      <aside className={`quick-rail ${railOpen ? 'open' : 'closed'}`} aria-label="快捷入口" onPointerEnter={keepRailOpen} onPointerLeave={scheduleHideRail}>
        <button type="button" className="rail-toggle" onClick={toggleRail} aria-label={railOpen ? '收起快捷栏' : '展开快捷栏'}>{railOpen ? '«' : '»'}</button>
        {railOpen && RAIL_KINDS.map((kind) => <button key={kind} type="button" className="rail-item" onClick={() => openBuffer(kind)}><span>{kind.toUpperCase().slice(0, 3)}</span>{PANEL_TITLES[kind]}</button>)}
      </aside>
      <div className="workspace">
        <div className="dockview-host"><DockviewReact components={panelComponents} rightHeaderActionsComponent={FloatingCloseAction} onReady={onReady} className="dockview-theme-abyss" /></div>
      </div>
    </div>
    <footer className="buffer-bar">
      <CommandBar onRun={openBuffer} />
      <div className="buffer-list" aria-label="已打开的缓存窗口">
        {buffers.map((buffer) => <span key={buffer.id} className="buffer-chip"><button type="button" onClick={() => focusBuffer(buffer.id)}>{PANEL_TITLES[buffer.kind]}</button><button type="button" className="buffer-close" onClick={() => closeBuffer(buffer.id)} aria-label={`关闭 ${PANEL_TITLES[buffer.kind]}`}>×</button></span>)}
      </div>
      {buffers.length > 0 && <button type="button" className="buffer-clear" onClick={onClearBuffers}>清空缓存窗口</button>}
    </footer>
  </main>;
}

export default App;
