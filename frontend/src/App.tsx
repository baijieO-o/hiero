import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, lazy, Suspense, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type FormEvent as ReactFormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewHeaderActionsProps } from 'dockview-react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import type { ReactElement } from 'react';
import { McpServersForm, SettingsPanel, usePreferences, useSubagentPreferences, applyPreferenceTheme, type McpConfigState, type McpSaveState, type McpServerEntry, type McpServerStatus, type ModelListState, type ModelSettings, type SaveState } from './settings';
import { clearConsoleEntries, evaluateInPage, getDevtoolsSnapshot, subscribeDevtools } from './devtools';
import { handleCodeCopy, renderMarkdown, renderPartialMarkdown, splitStreamingBlocks } from './markdown';
import { renderMarkmaps, renderMermaidBlocks } from './diagram-render';
import { PermissionModePicker, isPermissionLabel, readStoredPermission, storePermission, toPermissionMode, type PermissionLabel } from './permission-mode';
import { TaskCard } from './task-card';
import { ApprovalDialog, type ApprovalDialogRequest } from './approval-dialog';
import { clarifyComplete, clarifyQuestions, type ClarifyAnswers } from './clarify-model';
import { ClarifyWizard } from './clarify-wizard';
import { DEFAULT_BUDGET, toContractFields, validateTaskCard, type TaskCardBudget } from './task-card-model';
import { chatModelOptions, readStoredDefaultModel, readStoredModelCatalog, storeModelCatalog } from './model-catalog-store';
import { RUNTIME_WS_URL } from './runtime-url';
import { SystemStatus } from './system-status';
import { runtimeSocketFor, type RuntimeSocketMessage } from './runtime-socket';
import { estimateCostUsd, formatCost } from './token-cost';
import { TerminalView, type TerminalWriteLine } from './terminal-view';
import { MAX_TEXT_PREVIEW_BYTES, classifyFile, folderNameFromEntry } from './dropped-files';
import { FileRefChip, FilePreviewDialog, type DroppedFileRef } from './file-ref';
import { compactionBoundary, insertDivider, sendableMessages } from './compaction';

type TodoStatus = 'done' | 'active' | 'pending';

type RuntimeMessage = RuntimeSocketMessage;

const TODO_ITEMS = ['定义任务契约', '运行执行网关', '验证工具证据', '准备交接文档'];

/** Read-only panels subscribe to every broadcast through one shared, reconnecting socket. */
function connectRuntime(onMessage: (message: RuntimeMessage) => void): () => void {
  const socket = runtimeSocketFor(RUNTIME_WS_URL);
  const unsubscribers = BROADCAST_TYPES.map((type) => socket.subscribe(type, onMessage));
  return () => { for (const unsubscribe of unsubscribers) unsubscribe(); };
}

const BROADCAST_TYPES = ['SNAPSHOT', 'STATE_CHANGE', 'VERIFY_RESULT', 'REWIND_RESULT', 'FILE_DIFF', 'HANDOFF_TRIGGERED'];

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
  workspaceId: string;
}

interface WorkspaceState {
  screens: Record<string, unknown | null>;
  activeScreen: string;
  buffers: BufferEntry[];
  roots: Record<string, string>;
  setSerializedLayout: (layout: unknown) => void;
  setActiveScreen: (name: string) => void;
  addScreen: (name: string, root?: string) => void;
  removeScreen: (name: string) => void;
  resetLayout: () => void;
  addBuffer: (kind: PanelKind, workspaceId: string) => string;
  removeBuffer: (id: string) => void;
  clearBuffers: (workspaceId: string) => void;
  browserUrls: Record<string, string>;
  setBrowserUrl: (id: string, url: string) => void;
}

const useWorkspaceStore = create<WorkspaceState>()(persist((set) => ({
  screens: { [DEFAULT_SCREEN]: null },
  activeScreen: DEFAULT_SCREEN,
  buffers: [],
  roots: {},
  browserUrls: {},
  setSerializedLayout: (layout) => set((state) => ({ screens: { ...state.screens, [state.activeScreen]: layout } })),
  setActiveScreen: (name) => set({ activeScreen: name }),
  addScreen: (name, root) => set((state) => ({
    screens: { ...state.screens, [name]: null },
    roots: root ? { ...state.roots, [name]: root } : state.roots,
    activeScreen: name,
  })),
  removeScreen: (name) => set((state) => {
    if (name === DEFAULT_SCREEN) return {};
    const { [name]: _layout, ...screens } = state.screens;
    const { [name]: _root, ...roots } = state.roots;
    const owned = new Set(state.buffers.filter((buffer) => buffer.workspaceId === name).map((buffer) => buffer.id));
    const browserUrls = Object.fromEntries(Object.entries(state.browserUrls).filter(([id]) => !owned.has(id)));
    return {
      screens,
      roots,
      buffers: state.buffers.filter((buffer) => !owned.has(buffer.id)),
      browserUrls,
      activeScreen: state.activeScreen === name ? DEFAULT_SCREEN : state.activeScreen,
    };
  }),
  resetLayout: () => set((state) => ({ screens: { ...state.screens, [state.activeScreen]: null } })),
  addBuffer: (kind, workspaceId) => {
    const id = `buffer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    set((state) => ({ buffers: [...state.buffers, { id, kind, workspaceId }] }));
    return id;
  },
  removeBuffer: (id) => set((state) => {
    const { [id]: _removed, ...browserUrls } = state.browserUrls;
    return { buffers: state.buffers.filter((buffer) => buffer.id !== id), browserUrls };
  }),
  clearBuffers: (workspaceId) => set((state) => {
    const owned = new Set(state.buffers.filter((buffer) => buffer.workspaceId === workspaceId).map((buffer) => buffer.id));
    const browserUrls = Object.fromEntries(Object.entries(state.browserUrls).filter(([id]) => !owned.has(id)));
    return { buffers: state.buffers.filter((buffer) => !owned.has(buffer.id)), browserUrls };
  }),
  setBrowserUrl: (id, url) => set((state) => ({ browserUrls: { ...state.browserUrls, [id]: url } })),
}), {
  name: 'hiero-workspace',
  version: 1,
  migrate: (persisted, version) => {
    const state = persisted as Partial<WorkspaceState>;
    if (version < 1 && state.buffers) {
      return { ...state, buffers: state.buffers.map((buffer) => ({ ...buffer, workspaceId: DEFAULT_SCREEN })) } as WorkspaceState;
    }
    return state as WorkspaceState;
  },
}));

// Root directory of the active workspace; undefined falls back to the backend default.
function activeWorkspaceRoot(): string | undefined {
  const state = useWorkspaceStore.getState();
  return state.roots[state.activeScreen] || undefined;
}

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

/** One ordered piece of an assistant turn: narration text or a tool call, in the order they happened. */
type ChatSegment = { kind: 'text'; text: string } | { kind: 'tool'; step: ToolStep };

/** Appends a text delta, extending the last text segment when there is one. Returns a new array. */
function appendTextSegment(segments: ChatSegment[], text: string): ChatSegment[] {
  if (!text) return segments;
  const last = segments[segments.length - 1];
  if (last?.kind === 'text') return [...segments.slice(0, -1), { kind: 'text', text: last.text + text }];
  return [...segments, { kind: 'text', text }];
}

/** Builds the text-only content and tool list that older message rendering and persistence still use. */
function summarizeSegments(segments: ChatSegment[]): { content: string; steps: ToolStep[] } {
  let content = '';
  const steps: ToolStep[] = [];
  for (const segment of segments) {
    if (segment.kind === 'text') content += segment.text;
    else steps.push(segment.step);
  }
  return { content, steps };
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  images?: string[];
  files?: string[];
  steps?: ToolStep[];
  /** Interleaved text and tool steps in arrival order; absent on messages saved before this layout. */
  segments?: ChatSegment[];
  usage?: ChatUsage;
  model?: string;
  trace?: TraceEvent[];
  requestId?: string;
  completedAt?: number;
  /** Marks a divider inserted where a manual compaction happened. */
  compactedMarker?: boolean;
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
  /** Summary of messages[0..compactedUpTo); later requests send the summary plus the messages after it. */
  compactedSummary?: string;
  compactedUpTo?: number;
}

interface ContextUsageView { window: number; total: number; system: number; tools: number; tool_results: number; messages: number }

function parseContextUsage(raw: unknown): ContextUsageView | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const item = raw as Record<string, unknown>;
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return { window: num(item.window), total: num(item.total), system: num(item.system), tools: num(item.tools), tool_results: num(item.tool_results), messages: num(item.messages) };
}

export interface ChatOptions {
  model: string;
  permission: string;
  workspace: string;
  contextMode: string;
}

const CHAT_CONTEXT_OPTIONS = ['临时会话', '持久化 Markdown'];
// 热边：鼠标距窗口左边缘多少像素内触发展开；离开侧栏后延迟收起，避免抖动。
const HOT_EDGE_PX = 8;
const HOT_EDGE_HIDE_DELAY_MS = 300;
const TIMESTAMP_IDLE_HIDE_MS = 1500;

interface ChatState {
  conversations: Conversation[];
  activeId: string;
  pending: boolean;
  /** Ordered text and tool segments for the reply in progress. Only the streaming bubble subscribes to this. */
  streamingSegments: ChatSegment[];
  error: string | null;
  compacting: boolean;
  /** Latest context usage per conversation id, requested when the session info panel opens. */
  contextUsage: Record<string, ContextUsageView>;
  requestContextUsage: (conversationId: string) => void;
  compactConversation: (conversationId: string) => void;
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

/** Messages to send to the backend: the summary covers the older part, so only the messages after it are sent. Divider rows are never sent. */
function sendableHistory(conversation: Conversation, extra: ChatMessage[] = []): ChatMessage[] {
  return sendableMessages(conversation, extra);
}

function createConversation(): Conversation {
  return { id: `conv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, title: '新对话', messages: [], updatedAt: Date.now() };
}

/** Last serialized value written per storage key, so unchanged state skips the localStorage write. */
const lastPersisted = new Map<string, string>();
/** Remembers the in-flight chat request so a page reload can re-attach to it. */
const ACTIVE_REQUEST_KEY = 'hiero-active-request';
const RECONNECT_RETRY_MS = 1500;

function readActiveRequest(): { conversationId: string; requestId: string } | null {
  try {
    const raw = localStorage.getItem(ACTIVE_REQUEST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { conversationId?: unknown; requestId?: unknown };
    return typeof parsed.conversationId === 'string' && typeof parsed.requestId === 'string'
      ? { conversationId: parsed.conversationId, requestId: parsed.requestId }
      : null;
  } catch {
    return null;
  }
}

function writeActiveRequest(request: { conversationId: string; requestId: string } | null): void {
  if (request) localStorage.setItem(ACTIVE_REQUEST_KEY, JSON.stringify(request));
  else localStorage.removeItem(ACTIVE_REQUEST_KEY);
}

const useChatStore = create<ChatState>()(persist((set, get) => {
  let socket: WebSocket | null = null;
  let activeRequest: { conversationId: string; requestId: string } | null = null;
  // The request whose chat message was queued on the socket; onopen must not re-attach it.
  let sentOnSocket: string | null = null;
  let pendingFiles: string[] = [];
  let pendingTrace: TraceEvent[] | undefined;
  /** Deltas arrive per token; they are merged and written to the store at most once per animation frame. */
  let deltaBuffer = '';
  let deltaFrame: number | undefined;
  /** Set after a tool call or reset so the next delta opens a new text segment instead of extending the previous one. */
  let textBreak = false;
  const flushDeltas = () => {
    if (deltaFrame !== undefined) {
      cancelAnimationFrame(deltaFrame);
      deltaFrame = undefined;
    }
    if (!deltaBuffer) return;
    const text = deltaBuffer;
    deltaBuffer = '';
    const startNew = textBreak;
    textBreak = false;
    set((state) => ({
      streamingSegments: startNew
        ? [...state.streamingSegments, { kind: 'text', text }]
        : appendTextSegment(state.streamingSegments, text),
    }));
  };
  const queueDelta = (text: string) => {
    deltaBuffer += text;
    if (deltaFrame === undefined) deltaFrame = requestAnimationFrame(() => { deltaFrame = undefined; flushDeltas(); });
  };
  const discardDeltas = () => {
    deltaBuffer = '';
    if (deltaFrame !== undefined) cancelAnimationFrame(deltaFrame);
    deltaFrame = undefined;
  };
  /** Turns the in-flight stream into a finished assistant message and clears the stream state. */
  const finishStream = (extra: Partial<ChatMessage>): ChatMessage => {
    flushDeltas();
    const segments = get().streamingSegments;
    const summary = summarizeSegments(segments);
    const files = pendingFiles.length > 0 ? [...new Set(pendingFiles)] : undefined;
    const message: ChatMessage = {
      role: 'assistant',
      content: summary.content,
      segments: segments.length > 0 ? segments : undefined,
      steps: summary.steps.length > 0 ? summary.steps : undefined,
      files,
      completedAt: Date.now(),
      ...extra,
    };
    pendingFiles = [];
    pendingTrace = undefined;
    return message;
  };
  /** Usage and compaction requests are independent of chat turns, so they are matched by request id here. */
  const sideRequests = new Map<string, { kind: 'usage' | 'compact'; conversationId: string }>();
  const updateConversation = (id: string, change: (conv: Conversation) => Conversation) =>
    set((state) => ({ conversations: state.conversations.map((conv) => (conv.id === id ? change(conv) : conv)) }));
  const handleSideChannel = (message: RuntimeMessage) => {
    const requestId = typeof message.payload?.request_id === 'string' ? message.payload.request_id : '';
    const pending = sideRequests.get(requestId);
    if (!pending) return;
    sideRequests.delete(requestId);
    if (message.type === 'CHAT_USAGE') {
      const usage = parseContextUsage(message.payload?.usage);
      if (usage) set((state) => ({ contextUsage: { ...state.contextUsage, [pending.conversationId]: usage } }));
      return;
    }
    set({ compacting: false });
    if (message.payload?.ok === false) {
      set({ error: typeof message.payload?.message === 'string' ? message.payload.message : '压缩失败' });
      return;
    }
    const summary = typeof message.payload?.summary === 'string' ? message.payload.summary : '';
    if (!summary) return;
    updateConversation(pending.conversationId, (conv) => {
      // The summary replaces everything up to the current end of the visible history; the divider marks where it happened.
      // Manual /compact keeps only the latest message unsummarized (backend createCompactor(1)); automatic compaction keeps 6.
      const upTo = compactionBoundary(conv.messages);
      const divider: ChatMessage = { role: 'assistant', content: '', compactedMarker: true, completedAt: Date.now() };
      return { ...conv, compactedSummary: summary, compactedUpTo: upTo, messages: insertDivider(conv.messages, upTo, divider), updatedAt: Date.now() };
    });
    set({ error: null });
  };
  const ensureSocket = (): WebSocket => {
    if (socket && socket.readyState <= WebSocket.OPEN) return socket;
    const next = new WebSocket(RUNTIME_WS_URL);
    next.onmessage = (event) => {
      let message: RuntimeMessage;
      try { message = JSON.parse(String(event.data)) as RuntimeMessage; } catch { return; }
      if (message.type === 'CHAT_USAGE' || message.type === 'CHAT_COMPACTED') {
        handleSideChannel(message);
        return;
      }
      const requestId = typeof message.payload?.request_id === 'string' ? message.payload.request_id : '';
      if (!activeRequest || activeRequest.requestId !== requestId) return;
      const conversationId = activeRequest.conversationId;
      if (message.type === 'CHAT_DELTA') {
        const text = typeof message.payload?.text === 'string' ? message.payload.text : '';
        queueDelta(text);
      } else if (message.type === 'CHAT_RESET') {
        // A reset ends the current text run; the next delta starts a new text segment.
        flushDeltas();
        textBreak = true;
      } else if (message.type === 'CHAT_TOOL') {
        flushDeltas();
        textBreak = true;
        const name = typeof message.payload?.name === 'string' ? message.payload.name : '';
        const args = typeof message.payload?.arguments === 'string' ? message.payload.arguments : '{}';
        const result = typeof message.payload?.result === 'string' ? message.payload.result : '';
        set((state) => ({ streamingSegments: [...state.streamingSegments, { kind: 'tool', step: { name, arguments: args, result } }] }));
        if (name === 'read_file') {
          const path = readPathArgument(args);
          if (path) pendingFiles.push(path);
        }
      } else if (message.type === 'CHAT_TRACE') {
        pendingTrace = parseTraceEvents(message.payload?.events);
      } else if (message.type === 'CHAT_REPLY') {
        const replied = typeof message.payload?.content === 'string' ? message.payload.content : undefined;
        const usage = parseChatUsage(message.payload?.usage);
        const model = typeof message.payload?.model === 'string' ? message.payload.model : undefined;
        const trace = pendingTrace;
        const requestId = activeRequest.requestId;
        const savedPath = typeof message.payload?.saved_path === 'string' ? message.payload.saved_path : undefined;
        if (savedPath) pendingFiles.push(savedPath);
        const finished = finishStream({ usage, model, trace, requestId });
        // The final reply text is authoritative; replace the last text segment when the server sends it.
        if (replied !== undefined) finished.content = replied;
        updateConversation(conversationId, (conv) => ({ ...conv, messages: [...conv.messages, finished], updatedAt: Date.now() }));
        activeRequest = null;
        writeActiveRequest(null);
        set({ pending: false, streamingSegments: [], error: null });
      } else if (message.type === 'CHAT_CANCELLED') {
        const finished = finishStream({});
        const partial = finished.content.trim();
        if (partial || finished.steps) {
          updateConversation(conversationId, (conv) => ({ ...conv, messages: [...conv.messages, finished], updatedAt: Date.now() }));
        }
        activeRequest = null;
        writeActiveRequest(null);
        set({ pending: false, streamingSegments: [], error: null });
      } else if (message.type === 'CHAT_UNKNOWN') {
        // The backend no longer has this run (it restarted or the record expired), so nothing can be recovered.
        pendingFiles = [];
        pendingTrace = undefined;
        discardDeltas();
        activeRequest = null;
        writeActiveRequest(null);
        set({ pending: false, streamingSegments: [], error: '未找到该请求的记录，可能后端已重启，请重试。' });
      } else if (message.type === 'CHAT_ERROR') {
        const rawDetail = typeof message.payload?.message === 'string' ? message.payload.message : '请求失败';
        const errorCode = typeof message.payload?.code === 'string' ? message.payload.code : '';
        const detail = errorCode ? `[${errorCode}] ${rawDetail}` : rawDetail;
        pendingFiles = [];
        pendingTrace = undefined;
        discardDeltas();
        activeRequest = null;
        writeActiveRequest(null);
        set({ pending: false, streamingSegments: [], error: detail });
      }
    };
    // The backend keeps a chat run alive when the socket drops. On reconnect the pending request is re-attached
    // and its buffered events replay, so a page reload does not lose the in-flight reply.
    const handleDisconnect = () => {
      if (socket !== next) return;
      socket = null;
      sentOnSocket = null;
      if (!activeRequest) return;
      set({ error: '与后端的连接已断开，正在重连…' });
      window.setTimeout(() => {
        if (activeRequest && (!socket || socket.readyState > WebSocket.OPEN)) ensureSocket();
      }, RECONNECT_RETRY_MS);
    };
    next.onopen = () => {
      if (socket !== next || !activeRequest) return;
      // A request sent on this socket already starts its run; attaching it would race ahead of the chat message.
      if (activeRequest.requestId === sentOnSocket) return;
      next.send(JSON.stringify({ type: 'chat_attach', request_id: activeRequest.requestId }));
    };
    next.onclose = handleDisconnect;
    next.onerror = handleDisconnect;
    socket = next;
    return next;
  };
  const initial = createConversation();
  // A reload during a reply: restore the in-flight marker so the socket re-attaches and replays the run.
  const restored = readActiveRequest();
  if (restored) {
    activeRequest = restored;
    window.setTimeout(() => ensureSocket(), 0);
  }
  return {
    conversations: [initial],
    activeId: initial.id,
    pending: restored !== null,
    streamingSegments: [],
    error: null,
    compacting: false,
    contextUsage: {},
    requestContextUsage: (conversationId) => {
      const conversation = get().conversations.find((conv) => conv.id === conversationId);
      if (!conversation) return;
      const requestId = `usage-${Date.now()}`;
      sideRequests.set(requestId, { kind: 'usage', conversationId });
      const { workspace } = get().options;
      const subagent = useSubagentPreferences.getState().values;
      const payload = JSON.stringify({ type: 'chat_usage', request_id: requestId, messages: sendableHistory(conversation), workspace, subagent, compacted_summary: conversation.compactedSummary });
      const target = ensureSocket();
      if (target.readyState === WebSocket.OPEN) target.send(payload);
      else target.addEventListener('open', () => target.send(payload), { once: true });
    },
    compactConversation: (conversationId) => {
      const state = get();
      if (state.pending || state.compacting) return;
      const conversation = state.conversations.find((conv) => conv.id === conversationId);
      if (!conversation) return;
      const requestId = `compact-${Date.now()}`;
      sideRequests.set(requestId, { kind: 'compact', conversationId });
      set({ compacting: true, error: null });
      const { model, workspace } = state.options;
      const payload = JSON.stringify({ type: 'chat_compact', request_id: requestId, messages: sendableHistory(conversation), workspace, model, compacted_summary: conversation.compactedSummary });
      const target = ensureSocket();
      if (target.readyState === WebSocket.OPEN) target.send(payload);
      else target.addEventListener('open', () => target.send(payload), { once: true });
    },
    options: { model: readStoredDefaultModel(), permission: readStoredPermission(), workspace: 'D:\\hiero', contextMode: '临时会话' },
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
      updateConversation(conversation.id, (conv) => {
        // Rewinding into the summarized range invalidates the summary, because it describes messages that no longer exist.
        const keepSummary = conv.compactedUpTo !== undefined && messageIndex >= conv.compactedUpTo;
        return {
          ...conv,
          messages: conv.messages.slice(0, messageIndex),
          updatedAt: Date.now(),
          ...(keepSummary ? {} : { compactedSummary: undefined, compactedUpTo: undefined }),
        };
      });
      set({ error: null });
    },
    send: (text, images = []) => {
      const trimmed = text.trim();
      const state = get();
      if ((!trimmed && images.length === 0) || state.pending) return;
      const conversation = state.conversations.find((conv) => conv.id === state.activeId);
      if (!conversation) return;
      const message: ChatMessage = { role: 'user', content: trimmed, ...(images.length > 0 ? { images } : {}) };
      const requestId = `chat-${Date.now()}`;
      activeRequest = { conversationId: conversation.id, requestId };
      sentOnSocket = requestId;
      writeActiveRequest(activeRequest);
      updateConversation(conversation.id, (conv) => ({
        ...conv,
        messages: [...conv.messages, message],
        title: conv.messages.length === 0 ? (trimmed || '图片消息').slice(0, 20) : conv.title,
        updatedAt: Date.now(),
      }));
      pendingFiles = [];
      discardDeltas();
      textBreak = false;
      set({ pending: true, streamingSegments: [], error: null });
      const target = ensureSocket();
      const { model, permission, workspace, contextMode } = state.options;
      const subagent = useSubagentPreferences.getState().values;
      const payload = JSON.stringify({ type: 'chat', request_id: requestId, messages: sendableHistory(conversation, [message]), compacted_summary: conversation.compactedSummary, model, permission, workspace, context_mode: contextMode, subagent });
      if (target.readyState === WebSocket.OPEN) target.send(payload);
      else target.addEventListener('open', () => target.send(payload), { once: true });
    },
    cancel: () => {
      const request = activeRequest;
      if (!request) {
        if (get().pending) set({ pending: false, streamingSegments: [], error: null });
        return;
      }
      const target = ensureSocket();
      const payload = JSON.stringify({ type: 'chat_cancel', request_id: request.requestId });
      if (target.readyState === WebSocket.OPEN) target.send(payload);
      else target.addEventListener('open', () => target.send(payload), { once: true });
      const finished = finishStream({});
      const hasContent = finished.content.trim().length > 0 || (finished.steps?.length ?? 0) > 0;
      activeRequest = null;
      writeActiveRequest(null);
      if (hasContent) {
        updateConversation(request.conversationId, (conv) => ({ ...conv, messages: [...conv.messages, finished], updatedAt: Date.now() }));
      }
      set({ pending: false, streamingSegments: [], error: null });
    },
  };
}, {
  name: 'hiero-chat',
  partialize: (state) => ({ conversations: state.conversations, activeId: state.activeId, options: state.options }),
  storage: {
    getItem: (name) => {
      const raw = localStorage.getItem(name);
      return raw === null ? null : JSON.parse(raw);
    },
    setItem: (name, value) => {
      const serialized = JSON.stringify(value);
      if (lastPersisted.get(name) === serialized) return;
      lastPersisted.set(name, serialized);
      localStorage.setItem(name, serialized);
    },
    removeItem: (name) => {
      lastPersisted.delete(name);
      localStorage.removeItem(name);
    },
  },
}));

/** Fills in traces that exist only on the backend (for example after browser storage was cleared). */
function restoreServerTraces(): void {
  const socket = new WebSocket(RUNTIME_WS_URL);
  socket.onopen = () => socket.send(JSON.stringify({ type: 'chat_trace_history' }));
  socket.onmessage = (event) => {
    let message: RuntimeMessage;
    try { message = JSON.parse(String(event.data)) as RuntimeMessage; } catch { return; }
    if (message.type !== 'CHAT_TRACE_HISTORY') return;
    socket.close();
    const stored = new Map<string, TraceEvent[]>();
    const traces = Array.isArray(message.payload?.traces) ? message.payload.traces as Array<{ request_id?: unknown; events?: unknown }> : [];
    for (const item of traces) {
      if (typeof item.request_id !== 'string') continue;
      const events = parseTraceEvents(item.events);
      if (events) stored.set(item.request_id, events);
    }
    if (stored.size === 0) return;
    useChatStore.setState((state) => ({
      conversations: state.conversations.map((conv) => ({
        ...conv,
        messages: conv.messages.map((msg) => {
          if (msg.role !== 'assistant' || msg.trace || !msg.requestId) return msg;
          const trace = stored.get(msg.requestId);
          return trace ? { ...msg, trace } : msg;
        }),
      })),
    }));
  };
}
restoreServerTraces();

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

function MarkdownBody({ content }: { content: string }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(content), [content]);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const instances = renderMarkmaps(root);
    void renderMermaidBlocks(root);
    return () => instances.forEach((instance) => instance.destroy?.());
  }, [html]);
  return <div ref={ref} className="chat-markdown" onClick={(event) => { handleCodeCopy(event.target); }} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Renders narration text and tool rows in the order they happened, like Copilot's chat. */
function SegmentList({ segments, streaming }: { segments: ChatSegment[]; streaming?: boolean }): ReactElement {
  return <div className="chat-segments">
    {segments.map((segment, index) => {
      if (segment.kind === 'tool') return <ToolRow key={index} step={segment.step} />;
      if (!segment.text) return null;
      if (streaming) return <StreamingText key={index} text={segment.text} />;
      return <div key={index} className="chat-segment-text">
        <MarkdownBody content={segment.text} />
      </div>;
    })}
  </div>;
}

function ToolRow({ step }: { step: ToolStep }): ReactElement {
  const view = describeStep(step);
  return <details className={`chat-step${view.failed ? ' chat-step-failed' : ''}`}>
    <summary>
      <span className="chat-step-icon" aria-hidden="true">{view.failed ? '✕' : '✓'}</span>
      <span className="chat-step-name">{view.title}</span>
      <span className="chat-step-arg">{view.detail}</span>
    </summary>
    <div className="chat-step-body">
      <pre>{view.body}</pre>
    </div>
  </details>;
}

/**
 * Renders a streaming text segment block by block. Finished blocks are rendered as markdown and
 * memoized, so each new token only re-parses the unfinished tail.
 */
function StreamingText({ text }: { text: string }): ReactElement {
  const { done, tail } = useMemo(() => splitStreamingBlocks(text), [text]);
  const tailHtml = useMemo(() => (tail.trim() ? renderPartialMarkdown(tail) : ''), [tail]);
  return <div className="chat-segment-text chat-streaming-text">
    {done.map((block, index) => <MarkdownBody key={index} content={block} />)}
    {tailHtml && <div className="chat-markdown chat-streaming-tail" dangerouslySetInnerHTML={{ __html: tailHtml }} />}
  </div>;
}

function ChatMessageView({ role, content, images, files, steps, segments, usage, model, trace, completedAt, onRewind, rewindDisabled, anchorIndex }: { role: ChatMessage['role']; content: string; images?: string[]; files?: string[]; steps?: ToolStep[]; segments?: ChatSegment[]; usage?: ChatUsage; model?: string; trace?: TraceEvent[]; completedAt?: number; onRewind?: () => void; rewindDisabled?: boolean; anchorIndex?: number }): ReactElement {
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
    {images && images.length > 0 && <div className="chat-images">
      {images.map((src, index) => <img key={index} src={src} alt={`上传的图片 ${index + 1}`} />)}
    </div>}
    {segments && segments.length > 0
      ? <SegmentList segments={segments} />
      : <>
        {steps && steps.length > 0 && <ToolChain steps={steps} />}
        {content && <MarkdownBody content={content} />}
      </>}
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

/** Owns the streaming subscription so token updates re-render only this bubble, not the whole chat panel. */
const StreamingBubble = memo(function StreamingBubble(): ReactElement {
  const segments = useChatStore((state) => state.streamingSegments);
  const autoScroll = usePreferences((state) => state.values.autoScroll);
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!autoScroll) return;
    const log = anchor.current?.closest<HTMLElement>('.chat-log');
    if (!log) return;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }, [autoScroll, segments]);
  const hasOutput = segments.some((segment) => segment.kind === 'tool' || segment.text.length > 0);
  return <div ref={anchor}>
    {hasOutput
      ? <div className="chat-message chat-assistant chat-streaming">
        <div className="chat-message-head"><span className="chat-role">Hiero</span></div>
        <SegmentList segments={segments} streaming />
      </div>
      : <div className="chat-loader" role="status" aria-label="思考中"><span /><span /><span /></div>}
  </div>;
});

function ChatPanel(): ReactElement {
  const { conversations, activeId, pending, error, compacting, contextUsage, requestContextUsage, compactConversation, options, setOption, newConversation, selectConversation, renameConversation, deleteConversation, rewindConversation, send, cancel } = useChatStore(useShallow((state) => ({ conversations: state.conversations, activeId: state.activeId, pending: state.pending, error: state.error, compacting: state.compacting, contextUsage: state.contextUsage, requestContextUsage: state.requestContextUsage, compactConversation: state.compactConversation, options: state.options, setOption: state.setOption, newConversation: state.newConversation, selectConversation: state.selectConversation, renameConversation: state.renameConversation, deleteConversation: state.deleteConversation, rewindConversation: state.rewindConversation, send: state.send, cancel: state.cancel })));
  const [draft, setDraft] = useState('');
  const [sessionInfoOpen, setSessionInfoOpen] = useState(false);
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
  }, [autoScroll, messages.length]);
  const [jumpOpen, setJumpOpen] = useState(false);
  useEffect(() => { setJumpOpen(false); }, [activeId]);
  useEffect(() => { if (sessionInfoOpen && active && !pending) requestContextUsage(active.id); }, [sessionInfoOpen, activeId, messages.length, pending]);
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
  const [fileRefs, setFileRefs] = useState<DroppedFileRef[]>([]);
  const [previewRef, setPreviewRef] = useState<DroppedFileRef | null>(null);
  const addFileRefs = (files: File[]) => {
    const refs = files.map((file): DroppedFileRef => {
      const kind = classifyFile(file);
      return { id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`, name: file.name, size: file.size, kind, file, url: null };
    });
    if (refs.length > 0) setFileRefs((current) => [...current, ...refs]);
  };
  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    const folders = Array.from(event.dataTransfer.items ?? [])
      .map((item) => item.webkitGetAsEntry?.())
      .filter((entry): entry is FileSystemEntry => !!entry && entry.isDirectory);
    if (folders.length > 0) {
      setFolderError(`检测到拖入的文件夹「${folderNameFromEntry(folders[0])}」。浏览器无法读取拖入文件夹的真实路径，请在工作区栏点「+」选择该文件夹；同一目录已存在工作区时会直接切换。`);
    }
    const imageFiles = files.filter((file) => classifyFile(file) === 'image');
    const otherFiles = files.filter((file) => classifyFile(file) !== 'image' && !(file.size === 0 && file.type === ''));
    addImageFiles(imageFiles);
    addFileRefs(otherFiles);
  };
  const submit = async () => {
    if (!draft.trim() && images.length === 0 && fileRefs.length === 0) return;
    if (images.length === 0 && fileRefs.length === 0 && draft.trim() === '/compact') {
      setDraft('');
      if (activeId) compactConversation(activeId);
      return;
    }
    const refBlocks = await Promise.all(fileRefs.map(async (ref) => {
      if (ref.kind !== 'text') return `[附件: ${ref.name}（${ref.size} 字节）]`;
      const content = await ref.file.slice(0, MAX_TEXT_PREVIEW_BYTES).text();
      return `[附件: ${ref.name}]\n\`\`\`\n${content}\n\`\`\``;
    }));
    const text = [draft, ...refBlocks].filter((part) => part.trim()).join('\n\n');
    send(text, images);
    setDraft('');
    setImages([]);
    setImageError(null);
    setFileRefs([]);
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
  const deleteConfirm = confirmDeleteId
    ? <DeleteConversationConfirm
      title={conversations.find((item) => item.id === confirmDeleteId)?.title ?? '这段对话'}
      onConfirm={() => confirmRemove(confirmDeleteId)}
      onCancel={() => setConfirmDeleteId(null)}
    />
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
          {active && <div className="chat-title-actions">
            <button className="chat-icon-button" type="button" title="跳转到消息" aria-label="跳转到消息" aria-expanded={jumpOpen} onClick={() => setJumpOpen((open) => !open)} disabled={!messages.some((m) => m.role === 'user')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h13" /></svg>
            </button>
            <button className="chat-icon-button" type="button" title="重命名" aria-label="重命名" onClick={() => rename(active.id)} disabled={pending}><PencilIcon /></button>
            <button className="chat-icon-button" type="button" title="删除" aria-label="删除" onClick={() => remove(active.id)} disabled={pending}><TrashIcon /></button>
          </div>}
        </div>
        {deleteConfirm}
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
          {messages.map((message, index) => message.compactedMarker
            ? <div key={index} className="chat-compacted-divider" role="separator">已压缩之前的对话</div>
            : <ChatMessageView key={index} anchorIndex={index} role={message.role} content={message.content} images={message.images} files={message.files} steps={message.steps} segments={message.segments} usage={message.usage} model={message.model} trace={message.trace} completedAt={message.completedAt} onRewind={message.role === 'user' ? () => rewindConversation(index) : undefined} rewindDisabled={pending} />)}
          {pending && <StreamingBubble />}
        </div>
        {error && <p className="chat-error">{error}</p>}
        {folderError && <p className="chat-error">{folderError}</p>}
        {sessionInfoOpen && active && <SessionInfoPanel
          usage={contextUsage[active.id]}
          compacting={compacting}
          hasCompacted={active.compactedSummary !== undefined}
          canCompact={messages.filter((m) => !m.compactedMarker).length > 2 && !pending}
          onCompact={() => compactConversation(active.id)}
          onClose={() => setSessionInfoOpen(false)}
        />}
        <div className="chat-composer" onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={onDrop}>
          <div className="chat-input-box">
            {fileRefs.length > 0 && <div className="chat-file-refs">
              {fileRefs.map((item) => <FileRefChip key={item.id} item={item} onPreview={() => setPreviewRef(item)} onRemove={() => setFileRefs((current) => current.filter((ref) => ref.id !== item.id))} />)}
            </div>}
            {previewRef && <FilePreviewDialog item={previewRef} onClose={() => setPreviewRef(null)} />}
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
              <ChatOptionSelect label="模型" value={options.model} options={chatModelOptions(readStoredModelCatalog(), options.model)} disabled={pending} onChange={(value) => setOption('model', value)} />
              <ChatOptionSelect label="上下文" value={options.contextMode} options={CHAT_CONTEXT_OPTIONS} disabled={pending} onChange={(value) => setOption('contextMode', value)} />
              <span className="chat-toolbar-spacer" />
              <ContextUsageRing usage={activeId ? contextUsage[activeId] : undefined} open={sessionInfoOpen} onToggle={() => {
                if (!sessionInfoOpen && activeId) requestContextUsage(activeId);
                setSessionInfoOpen((open) => !open);
              }} />
              {pending
                ? <button className="chat-send-round chat-stop-round" type="button" onClick={cancel} title="停止生成" aria-label="停止生成">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
                  </button>
                : <button className="chat-send-round" type="button" onClick={submit} disabled={!draft.trim() && images.length === 0 && fileRefs.length === 0} title={!draft.trim() && images.length === 0 && fileRefs.length === 0 ? '请先输入内容或添加图片' : '发送'} aria-label="发送">
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
const USAGE_CATEGORIES: Array<{ key: 'system' | 'tools' | 'tool_results' | 'messages'; label: string; color: string }> = [
  { key: 'system', label: '系统提示词', color: '#8b8fa3' },
  { key: 'tools', label: '工具定义', color: '#6aa9ff' },
  { key: 'tool_results', label: '工具结果', color: '#f5b453' },
  { key: 'messages', label: '消息', color: '#4cc38a' },
];

function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

function ContextUsageRing({ usage, open, onToggle }: { usage: ContextUsageView | undefined; open: boolean; onToggle: () => void }): ReactElement {
  const percent = usage && usage.window > 0 ? Math.min(100, (usage.total / usage.window) * 100) : 0;
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  return <button type="button" className="chat-usage-ring" onClick={onToggle} aria-expanded={open} aria-label="会话信息" title="会话信息与上下文用量">
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <circle cx="10" cy="10" r={radius} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeDasharray={`${(percent / 100) * circumference} ${circumference}`} transform="rotate(-90 10 10)" />
    </svg>
  </button>;
}

function SessionInfoPanel({ usage, compacting, hasCompacted, canCompact, onCompact, onClose }: { usage: ContextUsageView | undefined; compacting: boolean; hasCompacted: boolean; canCompact: boolean; onCompact: () => void; onClose: () => void }): ReactElement {
  const percent = usage && usage.window > 0 ? (usage.total / usage.window) * 100 : 0;
  return <div className="chat-session-info" role="dialog" aria-label="会话信息">
    <div className="chat-session-info-head">
      <strong>会话信息</strong>
      <button type="button" className="chat-icon-button" aria-label="关闭" onClick={onClose}>✕</button>
    </div>
    <div className="chat-session-info-section">
      <div className="chat-session-info-row"><span>上下文窗口</span><span>{usage ? `${formatTokens(usage.total)} / ${formatTokens(usage.window)} (${percent.toFixed(1)}%)` : '计算中…'}</span></div>
      <div className="chat-usage-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
        {usage && USAGE_CATEGORIES.map((item) => <span key={item.key} style={{ width: `${usage.window > 0 ? (usage[item.key] / usage.window) * 100 : 0}%`, background: item.color }} title={item.label} />)}
      </div>
      <ul className="chat-usage-list">
        {USAGE_CATEGORIES.map((item) => <li key={item.key}>
          <span className="chat-usage-dot" style={{ background: item.color }} />
          <span className="chat-usage-label">{item.label}</span>
          <span className="chat-usage-value">{usage ? `${formatTokens(usage[item.key])} tokens` : '—'}</span>
        </li>)}
      </ul>
      <p className="chat-session-info-hint">估算值（约 4 字符 / token），上限按 128K 计算。</p>
    </div>
    <div className="chat-session-info-foot">
      <button type="button" className="chat-compact-button" onClick={onCompact} disabled={!canCompact || compacting} title={canCompact ? '把较早的对话压缩成摘要，之后的请求只发送摘要和新消息' : '历史太短，暂时无法压缩'}>
        {compacting ? '压缩中…' : '压缩对话'}
      </button>
      <span className="chat-session-info-hint">{hasCompacted ? '已压缩：之前的内容以摘要形式参与后续请求。' : '也可以在输入框中发送 /compact。'}</span>
    </div>
  </div>;
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
  const [model, setModel] = useState(readStoredDefaultModel);
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
  const [clarifyAnswers, setClarifyAnswers] = useState<ClarifyAnswers>({ allowWrites: null });
  const draft = { goal, criteria, budget };
  const validation = validateTaskCard(draft);
  const questions = clarifyQuestions({ goal, criteria }, workspace);
  const clarified = clarifyComplete(questions, criteria, clarifyAnswers, workspace);
  const effectivePermission: PermissionLabel = clarifyAnswers.allowWrites === false ? '严格' : permission;
  const changeGoal = (value: string) => {
    setGoal(value);
    setConfirmed(false);
  };
  const changePermission = (value: PermissionLabel) => {
    setPermission(value);
    setConfirmed(false);
  };
  const launch = () => {
    if (validation || !confirmed || !clarified) return;
    const nextGoal = goal.trim();
    setStarted(true);
    setConfirmed(false);
    const socket = new WebSocket(RUNTIME_WS_URL);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ goal: nextGoal, task: { workspace_path: workspace, model_config: { preferred_model: model, fallback_chain: [] }, permission_mode: toPermissionMode(effectivePermission), context_mode: contextMode === '持久化 Markdown' ? 'persistent_md' : 'ephemeral', ...toContractFields(draft) } }));
      window.setTimeout(() => socket.close(), 500);
    });
  };
  return <section className="panel-content"><PanelHeader eyebrow="任务控制台" title="开始一个任务" /><label className="field-label" htmlFor="goal">你希望 Hiero 做什么？</label><textarea id="goal" value={goal} onChange={(event) => changeGoal(event.target.value)} placeholder="描述你想要达成的结果……" /><div className="field-grid"><Select label="模型" value={model} onChange={setModel} options={chatModelOptions(readStoredModelCatalog(), model)} /><div className="field-wide"><span className="field-label">权限模式（启动前确认）</span><PermissionModePicker value={permission} onChange={changePermission} /></div><label className="chat-option chat-option-wide"><span>工作区</span><input value={workspace} onChange={(event) => setWorkspace(event.target.value)} placeholder="绝对路径" /></label><Select label="上下文模式" value={contextMode} onChange={setContextMode} options={['临时会话', '持久化 Markdown']} /></div><ClarifyWizard questions={questions} answers={clarifyAnswers} criteria={criteria} onCriteriaChange={setCriteria} onAnswersChange={setClarifyAnswers} complete={clarified} /><TaskCard summary={{ goal: goal.trim(), workspace, model, permissionLabel: effectivePermission, contextMode }} criteria={criteria} budget={budget} onCriteriaChange={setCriteria} onBudgetChange={setBudget} confirmed={confirmed} onConfirmedChange={setConfirmed} disabled={started} /><button className="primary-button" type="button" onClick={launch} disabled={started || !confirmed || !clarified || validation !== null}>{started ? '任务已发送' : '启动任务'} <span>→</span></button>{validation && <p className="task-card-hint">{validation}</p>}<div style={{ marginTop: 12 }}><RollbackButton /></div></section>;
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
    if (message.type !== 'STATE_CHANGE' && message.type !== 'SNAPSHOT') return;
    const node = typeof message.payload?.node === 'string' ? message.payload.node : undefined;
    const status = typeof message.payload?.status === 'string' ? message.payload.status : undefined;
    // SNAPSHOT carries only the node, so resync from it on every (re)connect.
    if (message.type === 'SNAPSHOT' && node) setCurrentNode(node);
    else if (node && status) setCurrentNode(node);
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
  return <section className="panel-content review-panel"><PanelHeader eyebrow="代码审查" title="文件修改对比" /><div className="diff-path">{diff.path}</div><div className="editor-frame"><Suspense fallback={<div className="editor-loading">正在加载代码编辑器…</div>}><DiffEditor key={`${diff.path}:${diff.original.length}:${diff.modified.length}`} height="100%" language="typescript" original={diff.original} modified={diff.modified} theme="vs-dark" options={{ readOnly: true, minimap: { enabled: false }, renderSideBySide: true }} /></Suspense></div></section>;
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
  const [modelList, setModelList] = useState<ModelListState>({ status: 'idle' });
  const socketRef = useRef<WebSocket | null>(null);
  const fetchModels = (input: { endpoint: string; tokens: string }) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setModelList({ status: 'error', message: '未连接到后端（localhost:8080），请先启动后端。' });
      return;
    }
    setModelList({ status: 'loading' });
    socket.send(JSON.stringify({ type: 'model_list', request_id: 'model-list', payload: input }));
  };
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
        if (message.type === 'MODEL_LIST') {
          const result = message.payload as unknown as { models: string[]; error?: string };
          setModelList(result.error ? { status: 'error', message: result.error } : { status: 'ready', models: result.models });
          if (!result.error) storeModelCatalog(result.models);
        }
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
  return <section className="panel-content"><PanelHeader eyebrow="配置" title="设置" /><SettingsPanel modelSettings={settings} saveState={saveState} onSaveModel={saveModel} modelList={modelList} onFetchModels={fetchModels} mcpConfig={mcpConfig} mcpSaveState={mcpSaveState} onSaveMcp={saveMcp} /></section>;
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
    const workspace = body.workspace ?? useChatStore.getState().options.workspace;
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

type ApprovalRequest = ApprovalDialogRequest;

/** Inline confirmation before deleting a conversation; cancel is the default and Esc cancels. */
function DeleteConversationConfirm({ title, onConfirm, onCancel }: { title: string; onConfirm: () => void; onCancel: () => void }): ReactElement {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  return <div className="chat-delete-confirm" role="alertdialog" aria-labelledby="chat-delete-title" aria-describedby="chat-delete-desc" onKeyDown={(event) => { if (event.key === 'Escape') onCancel(); }}>
    <div className="chat-delete-confirm-text">
      <strong id="chat-delete-title">删除「{title}」？</strong>
      <span id="chat-delete-desc">对话记录会被永久删除，无法恢复。</span>
    </div>
    <div className="chat-delete-confirm-actions">
      <button ref={cancelRef} type="button" className="chat-delete-cancel" onClick={onCancel}>保留</button>
      <button type="button" className="chat-delete-danger" onClick={onConfirm}>删除对话</button>
    </div>
  </div>;
}

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
  const approvalId = current?.approval_id;
  const respond = useCallback((approved: boolean) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN && approvalId) {
      socket.send(JSON.stringify({ type: 'approval_response', payload: { approval_id: approvalId, approved } }));
    }
    setQueue((rest) => rest.slice(1));
  }, [approvalId]);
  if (!current) return null;

  return <ApprovalDialog key={current.approval_id} request={current} onRespond={respond} />;
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
    requestWorkspace({ type: 'fs_list', path: nextPath, workspace: activeWorkspaceRoot() })
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

type TerminalLine = TerminalWriteLine;

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
  const [lines, setLines] = useState<TerminalLine[]>([{ kind: 'banner', text: 'Windows PowerShell\n命令在工作区根目录一次性执行（非交互式）。' }]);
  const [running, setRunning] = useState(false);
  const [root, setRoot] = useState('');
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const prompt = `PS ${root}>`;
  const workspace = useChatStore((state) => state.options.workspace);
  useEffect(() => {
    requestWorkspace({ type: 'fs_list', path: '', workspace: activeWorkspaceRoot() }).then((payload) => { if (typeof payload.root === 'string') setRoot(payload.root); }).catch(() => undefined);
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
    requestWorkspace({ type: 'term_exec', command: text, permission: '标准', workspace: activeWorkspaceRoot() })
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
    <TerminalView lines={lines} hidden={hidden} onActivate={() => inputRef.current?.focus()} />
    <form className="terminal-input" onSubmit={run}>
      <span className="wt-prompt">{running ? '' : prompt}</span>
      <input ref={inputRef} value={command} onChange={(event) => { setCommand(event.target.value); setHistoryIndex(null); }} onKeyDown={recall} placeholder={running ? '执行中……' : ''} aria-label="终端命令" disabled={running} autoComplete="off" spellCheck={false} />
    </form>
  </div>;
}

const panelComponents = { chat: ChatPanel, mission: MissionControl, debug: DebugConsole, todo: TodoList, review: CodeReview, handoff: HandoffPanel, settings: SettingsBuffer, browser: BrowserBuffer, terminal: TerminalBuffer, files: FileManagerBuffer, skills: SkillsBuffer, memory: MemoryBuffer, blank: BlankBuffer };

function GroupHeaderActions({ api, containerApi, group }: IDockviewHeaderActionsProps): ReactElement {
  const [maximized, setMaximized] = useState(() => api.isMaximized());
  const anchor = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    setMaximized(api.isMaximized());
    const subscription = containerApi.onDidMaximizedGroupChange(() => setMaximized(api.isMaximized()));
    return () => subscription.dispose();
  }, [api, containerApi]);
  useEffect(() => {
    const header = anchor.current?.closest<HTMLElement>('.dv-tabs-and-actions-container');
    if (!header) return;
    const onDoubleClick = (event: MouseEvent) => {
      if ((event.target as HTMLElement).closest('.dv-tab, button')) return;
      if (group.model.location.type !== 'grid') return;
      if (api.isMaximized()) api.exitMaximized();
      else api.maximize();
    };
    header.addEventListener('dblclick', onDoubleClick);
    return () => header.removeEventListener('dblclick', onDoubleClick);
  }, [api, group]);
  if (group.model.location.type === 'floating') {
    const close = () => group.panels.forEach((panel) => containerApi.removePanel(panel));
    return <span ref={anchor} style={{ display: 'contents' }}><button type="button" className="floating-close" onClick={close} aria-label="关闭窗口" title="关闭">×</button></span>;
  }
  const toggle = () => (maximized ? api.exitMaximized() : api.maximize());
  return <span ref={anchor} style={{ display: 'contents' }}>{(group.model.location.type === 'grid' || maximized) && <button type="button" className="group-maximize" onClick={toggle} aria-label={maximized ? '还原窗口' : '最大化窗口'} title={maximized ? '还原' : '最大化'}>{maximized ? '❐' : '□'}</button>}</span>;
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
  const activeBuffers = buffers.filter((buffer) => buffer.workspaceId === activeScreen);
  const roots = useWorkspaceStore((state) => state.roots);
  const activeRoot = roots[activeScreen] ?? '';
  const setSerializedLayout = useWorkspaceStore((state) => state.setSerializedLayout);
  const setActiveScreen = useWorkspaceStore((state) => state.setActiveScreen);
  const addScreen = useWorkspaceStore((state) => state.addScreen);
  const resetLayout = useWorkspaceStore((state) => state.resetLayout);
  const addBuffer = useWorkspaceStore((state) => state.addBuffer);
  const removeBuffer = useWorkspaceStore((state) => state.removeBuffer);
  const clearBuffers = useWorkspaceStore((state) => state.clearBuffers);
  const removeScreen = useWorkspaceStore((state) => state.removeScreen);
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
    const id = addBuffer(kind, useWorkspaceStore.getState().activeScreen);
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

  // Suppress removal bookkeeping while the layout is rebuilt.
  const loadingRef = useRef(false);

  // Only buffers owned by the given workspace are added to the dockview layout.
  const loadLayout = (target: DockviewApi, layout: unknown, workspaceId: string) => {
    loadingRef.current = true;
    target.clear();
    let restored = false;
    if (layout) {
      try { target.fromJSON(layout as Parameters<DockviewApi['fromJSON']>[0]); restored = true; } catch { target.clear(); }
    }
    if (!restored) buildDefaultLayout(target);
    target.panels.filter((panel) => panel.id.startsWith('buffer-')).forEach((panel) => target.removePanel(panel));
    useWorkspaceStore.getState().buffers
      .filter((buffer) => buffer.workspaceId === workspaceId)
      .forEach((buffer) => addBufferPanel(target, buffer.id, buffer.kind));
    loadingRef.current = false;
  };

  const onReady = (event: DockviewReadyEvent) => {
    setApi(event.api);
    const state = useWorkspaceStore.getState();
    loadLayout(event.api, state.screens[state.activeScreen], state.activeScreen);
    event.api.onDidLayoutChange(() => { if (!loadingRef.current) setSerializedLayout(event.api.toJSON()); });
    event.api.onDidRemovePanel((panel) => { if (!loadingRef.current && panel.id.startsWith('buffer-')) removeBuffer(panel.id); });
  };

  const switchScreen = (name: string) => {
    if (!api || name === activeScreen) return;
    setActiveScreen(name);
    loadLayout(api, useWorkspaceStore.getState().screens[name], name);
  };

  const onResetLayout = () => {
    if (!api) return;
    activeBuffers.forEach((buffer) => { const panel = api.getPanel(buffer.id); if (panel) api.removePanel(panel); });
    clearBuffers(activeScreen);
    resetLayout();
    loadLayout(api, null, activeScreen);
  };

  const onCreateScreen = async () => {
    const name = screenDraft.trim();
    if (!api || !name || screens[name] !== undefined) return;
    let root = '';
    try {
      const result = await requestWorkspace({ type: 'folder_pick', initialPath: activeRoot });
      root = typeof result.path === 'string' ? result.path : '';
    } catch {
      root = '';
    }
    if (!root) return;
    const existing = Object.keys(roots).find((key) => roots[key] === root);
    if (existing) {
      setActiveScreen(existing);
      loadLayout(api, screens[existing] ?? null, existing);
      setScreenDraft('');
      return;
    }
    addScreen(name, root);
    loadLayout(api, null, name);
    setScreenDraft('');
  };

  const onRemoveScreen = (name: string) => {
    if (name === DEFAULT_SCREEN || !window.confirm(`删除工作区「${name}」？其中的窗口也会一起关闭，此操作不可撤销。`)) return;
    const isActive = name === activeScreen;
    if (isActive && api) {
      activeBuffers.forEach((buffer) => { const panel = api.getPanel(buffer.id); if (panel) api.removePanel(panel); });
    }
    removeScreen(name);
    if (isActive && api) loadLayout(api, useWorkspaceStore.getState().screens[DEFAULT_SCREEN], DEFAULT_SCREEN);
  };

  const focusBuffer = (id: string) => api?.getPanel(id)?.api.setActive();

  const closeBuffer = (id: string) => {
    const panel = api?.getPanel(id);
    if (panel) api?.removePanel(panel);
    else removeBuffer(id);
  };

  const onClearBuffers = () => {
    if (!api) return;
    activeBuffers.forEach((buffer) => { const panel = api.getPanel(buffer.id); if (panel) api.removePanel(panel); });
    clearBuffers(activeScreen);
  };

  return <main className="app-shell">
    <ApprovalModal />
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>HIERO</span></div>
      <nav className="screen-tabs" aria-label="工作区">
        {Object.keys(screens).map((name) => <span key={name} className={`screen-tab-wrap ${name === activeScreen ? 'active' : ''}`}>
          <button type="button" className={`screen-tab ${name === activeScreen ? 'active' : ''}`} onClick={() => switchScreen(name)}>{name}</button>
          {name !== DEFAULT_SCREEN && <button type="button" className="screen-tab-close" aria-label={`删除工作区 ${name}`} title="删除工作区" onClick={() => onRemoveScreen(name)}>×</button>}
        </span>)}
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
        <div className="dockview-host"><DockviewReact components={panelComponents} rightHeaderActionsComponent={GroupHeaderActions} onReady={onReady} className="dockview-theme-abyss" /></div>
      </div>
    </div>
    <footer className="buffer-bar">
      <CommandBar onRun={openBuffer} />
      <div className="buffer-list" aria-label="已打开的缓存窗口">
        {activeBuffers.map((buffer) => <span key={buffer.id} className="buffer-chip"><button type="button" onClick={() => focusBuffer(buffer.id)}>{PANEL_TITLES[buffer.kind]}</button><button type="button" className="buffer-close" onClick={() => closeBuffer(buffer.id)} aria-label={`关闭 ${PANEL_TITLES[buffer.kind]}`}>×</button></span>)}
      </div>
      {activeBuffers.length > 0 && <button type="button" className="buffer-clear" onClick={onClearBuffers}>清空缓存窗口</button>}
      <SystemStatus />
    </footer>
  </main>;
}

export default App;
