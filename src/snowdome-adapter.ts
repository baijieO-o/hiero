import { WebSocket } from 'ws';
import type { CompletionGateway } from './model-gateway.js';
import type { TaskContract } from './contracts.js';
import type { AdapterPlug } from './hot-plug.js';

export const SNOWDOME_DEFAULT_URL = 'ws://localhost:3000/agent';
export const SNOWDOME_DEFAULT_LOGIN_URL = 'http://localhost:3000/api/login';

/** Visitor session issued by Snowdome's login endpoint; the server assigns the actorId, not the client. */
export interface SnowdomeSession {
  token: string;
  actorId: string;
}

export async function loginSnowdome(loginUrl: string, name: string, fetchImpl: typeof fetch = fetch): Promise<SnowdomeSession> {
  const response = await fetchImpl(loginUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const body = await response.json() as { accepted?: boolean; token?: string; actorId?: string; reason_code?: string };
  if (!response.ok || !body.accepted || !body.token || !body.actorId) {
    throw new Error(`Snowdome 登录失败：${body.reason_code ?? response.status}`);
  }
  return { token: body.token, actorId: body.actorId };
}

/** Keeps a visitor online; resolves false when Snowdome no longer recognises the token (HTTP 401). */
export async function heartbeatSnowdome(heartbeatUrl: string, token: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const response = await fetchImpl(`${heartbeatUrl}?token=${encodeURIComponent(token)}`, { method: 'POST' });
  return response.ok;
}

export type SnowdomeIntent =
  | { kind: 'move'; actorId: string; target: { x: number; y: number; z: number } }
  | { kind: 'speak'; actorId: string; mode: 'whisper' | 'talk' | 'shout'; text: string }
  | { kind: 'leave'; actorId: string; destination: string };

export interface SnowdomeObservation {
  kind: 'observation';
  tick: number;
  self: { id: string; position: { x: number; y: number; z: number }; room: number; group: string };
  nearby: { id: string; name: string; position: { x: number; y: number; z: number }; distance: number }[];
  heard: { speakerId: string; mode: string; text: string }[];
}

export interface SnowdomeReceipt {
  accepted: boolean;
  reason_code: string;
  state_delta: Record<string, unknown>;
  cooldown_ms: number;
}

/** Minimal socket surface the adapter needs; tests inject a fake one. */
export interface SnowdomeSocket {
  send(data: string): void;
  close(): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
}

export type SnowdomeSocketFactory = (url: string) => Promise<SnowdomeSocket>;

const MODES = new Set(['whisper', 'talk', 'shout']);
const MAX_TEXT_LENGTH = 200;

function isCell(value: unknown): value is { x: number; y: number; z: number } {
  if (typeof value !== 'object' || value === null) return false;
  const cell = value as Record<string, unknown>;
  return Number.isInteger(cell.x) && Number.isInteger(cell.y) && Number.isInteger(cell.z);
}

/** Accepts only intents the Snowdome adapter protocol defines. Anything else is rejected before it reaches the socket. */
export function parseSnowdomeIntent(raw: unknown, actorId: string): SnowdomeIntent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (candidate.kind === 'move' && isCell(candidate.target)) {
    return { kind: 'move', actorId, target: { ...candidate.target } };
  }
  if (candidate.kind === 'speak' && typeof candidate.mode === 'string' && MODES.has(candidate.mode)
    && typeof candidate.text === 'string' && candidate.text.trim().length > 0 && candidate.text.length <= MAX_TEXT_LENGTH) {
    return { kind: 'speak', actorId, mode: candidate.mode as 'whisper' | 'talk' | 'shout', text: candidate.text };
  }
  if (candidate.kind === 'leave' && typeof candidate.destination === 'string' && candidate.destination.length > 0) {
    return { kind: 'leave', actorId, destination: candidate.destination };
  }
  return null;
}

/** Extracts the first JSON object from a model reply and validates it as an intent. */
export function parseModelIntent(content: string, actorId: string): SnowdomeIntent | null {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return parseSnowdomeIntent(JSON.parse(content.slice(start, end + 1)), actorId);
  } catch {
    return null;
  }
}

/** How many of this resident's own recent lines are shown to the model, so it can continue a topic without repeating itself. */
export const RECENT_SPEECH_LIMIT = 5;

export function buildDecisionPrompt(observation: SnowdomeObservation, recentSpeech: readonly string[] = []): string {
  const heard = observation.heard.length > 0 ? observation.heard.map((line) => `${line.speakerId}：${line.text}`).join('\n') : '（没有人对你说话）';
  const mine = recentSpeech.length > 0 ? recentSpeech.map((text) => `- ${text}`).join('\n') : '（你还没有说过话）';
  return [
    '你是 hiero，一个来到 Snowdome 小镇结识居民、交流想法的访客。说话具体、真诚，回应对方实际说的内容。',
    '只有在有人对你说话时才发言；没有人说话时不要主动问候或自我介绍，可以四处走走（用 move）去认识新的居民。',
    '不要重复你自己说过的话（见下方“你最近说过”）。',
    '只输出一个 JSON 对象，格式之一：',
    '{"kind":"move","target":{"x":整数,"y":整数,"z":整数}}（每次最多移动 3 格）',
    '{"kind":"speak","mode":"whisper|talk|shout","text":"台词"}',
    '{"kind":"leave","destination":"backyard"}',
    '无需行动时，输出 {"kind":"speak","mode":"whisper","text":"（沉默）"}。',
    `你最近说过：\n${mine}`,
    `刚才听到：\n${heard}`,
    `当前观察包：${JSON.stringify(observation)}`,
  ].join('\n');
}

export function parseObservation(raw: string): SnowdomeObservation | null {
  try {
    const value = JSON.parse(raw) as Partial<SnowdomeObservation>;
    return value.kind === 'observation' && typeof value.tick === 'number' && value.self ? (value as SnowdomeObservation) : null;
  } catch {
    return null;
  }
}

export interface SnowdomeAdapterOptions {
  name: string;
  url?: string;
  loginUrl?: string;
  autoBehavior: boolean;
  connect: SnowdomeSocketFactory;
  login?: (loginUrl: string, name: string) => Promise<SnowdomeSession>;
  heartbeat?: (heartbeatUrl: string, token: string) => Promise<boolean>;
  heartbeatIntervalMs?: number;
  reconnectDelayMs?: number;
  gateway?: CompletionGateway;
  task: TaskContract;
  onReceipt?: (receipt: SnowdomeReceipt) => void;
  onError?: (message: string) => void;
}

/** Opens a real `ws` connection and resolves once it is open. */
export function wsSocketFactory(url: string): Promise<SnowdomeSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve({
      send: (data) => ws.send(data),
      close: () => ws.close(),
      onMessage: (handler) => ws.on('message', (raw) => handler(raw.toString())),
      onClose: (handler) => ws.on('close', handler),
    }));
    ws.once('error', reject);
  });
}

/** Wraps a SnowdomeAdapter as a hot-pluggable adapter so the registry can start and stop it. */
export function snowdomeAdapterPlug(options: SnowdomeAdapterOptions): AdapterPlug {
  const adapter = new SnowdomeAdapter(options);
  return { start: () => adapter.start(), stop: () => adapter.stop() };
}

/** Receipts that mean the visitor session is no longer valid, e.g. after Snowdome restarts and drops its in-memory tokens. */
const STALE_SESSION_CODES = new Set(['login_required', 'unknown_actor']);
const DEFAULT_RECONNECT_MS = 5000;
/** Snowdome moves a visitor out of town after 45 s without a heartbeat, so beat well inside that window. */
const DEFAULT_HEARTBEAT_MS = 15000;

/** Client for Snowdome's agent WebSocket. Intents are sent only after the server accepts the subscription. */
export class SnowdomeAdapter {
  private socket: SnowdomeSocket | undefined;
  private session: SnowdomeSession | undefined;
  private closed = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private readonly pendingReceipts: ((receipt: SnowdomeReceipt) => void)[] = [];
  private readonly recentSpeech: string[] = [];

  public constructor(private readonly options: SnowdomeAdapterOptions) {}

  public async start(): Promise<void> {
    this.closed = false;
    try {
      await this.connect();
    } catch (cause) {
      this.stop();
      throw cause;
    }
  }

  private async connect(): Promise<void> {
    const login = this.options.login ?? loginSnowdome;
    const session = await login(this.options.loginUrl ?? SNOWDOME_DEFAULT_LOGIN_URL, this.options.name);
    this.session = session;
    const base = this.options.url ?? SNOWDOME_DEFAULT_URL;
    const socket = await this.options.connect(`${base}?token=${encodeURIComponent(session.token)}`);
    this.socket = socket;
    socket.onMessage((data) => this.handleMessage(data));
    socket.onClose(() => this.handleClose(socket));
    const receipt = await this.request({ kind: 'subscribe', actorId: session.actorId });
    if (!receipt.accepted) {
      socket.close();
      throw new Error(`Snowdome 订阅被拒绝：${receipt.reason_code}`);
    }
    this.startHeartbeat();
  }

  /** Beats for the current token; a 401 means the session expired, so dropping the socket triggers a re-login. */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    const heartbeat = this.options.heartbeat ?? heartbeatSnowdome;
    const url = this.options.loginUrl ?? SNOWDOME_DEFAULT_LOGIN_URL;
    const heartbeatUrl = url.replace(/\/api\/login$/, '/api/visitor/heartbeat');
    this.heartbeatTimer = setInterval(() => {
      const session = this.session;
      if (!session) return;
      heartbeat(heartbeatUrl, session.token).then((alive) => {
        if (alive || this.session !== session) return;
        this.options.onError?.('Snowdome 心跳失效，重新登录');
        const socket = this.socket;
        this.socket = undefined;
        this.stopHeartbeat();
        socket?.close();
        this.resolvePendingAsDisconnected();
        this.scheduleReconnect();
      }).catch(() => undefined);
    }, this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private handleClose(socket: SnowdomeSocket): void {
    if (socket !== this.socket) return;
    this.socket = undefined;
    this.stopHeartbeat();
    this.resolvePendingAsDisconnected();
    if (!this.closed) this.scheduleReconnect();
  }

  /** Re-logs in and reconnects after an unexpected drop; keeps retrying until stop() is called. */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closed) return;
      this.connect().catch((cause: unknown) => {
        this.options.onError?.(cause instanceof Error ? cause.message : String(cause));
        this.scheduleReconnect();
      });
    }, this.options.reconnectDelayMs ?? DEFAULT_RECONNECT_MS);
  }

  private resolvePendingAsDisconnected(): void {
    const waiting = this.pendingReceipts.splice(0);
    for (const resolve of waiting) {
      resolve({ accepted: false, reason_code: 'disconnected', state_delta: {}, cooldown_ms: 0 });
    }
  }

  /** Sends an intent; the socket is only written after parsing so malformed intents never leave the process. */
  public async send(intent: SnowdomeIntent): Promise<SnowdomeReceipt> {
    if (!this.socket || !this.session) throw new Error('Snowdome adapter is not connected.');
    return this.request({ ...intent, actorId: this.session.actorId });
  }

  public get actorId(): string | undefined {
    return this.session?.actorId;
  }

  public stop(): void {
    this.closed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.resolvePendingAsDisconnected();
  }

  private request(message: Record<string, unknown>): Promise<SnowdomeReceipt> {
    return new Promise((resolve) => {
      this.pendingReceipts.push((receipt) => {
        this.options.onReceipt?.(receipt);
        if (STALE_SESSION_CODES.has(receipt.reason_code) && message.kind !== 'subscribe') this.socket?.close();
        resolve(receipt);
      });
      this.socket?.send(JSON.stringify(message));
    });
  }

  private async handleMessage(data: string): Promise<void> {
    const observation = parseObservation(data);
    if (observation) {
      if (this.options.autoBehavior) await this.decide(observation);
      return;
    }
    const receipt = this.parseReceipt(data);
    if (receipt) this.pendingReceipts.shift()?.(receipt);
  }

  private parseReceipt(data: string): SnowdomeReceipt | null {
    try {
      const value = JSON.parse(data) as Partial<SnowdomeReceipt>;
      return typeof value.accepted === 'boolean' && typeof value.reason_code === 'string' ? (value as SnowdomeReceipt) : null;
    } catch {
      return null;
    }
  }

  private rememberSpeech(text: string): void {
    this.recentSpeech.push(text);
    if (this.recentSpeech.length > RECENT_SPEECH_LIMIT) this.recentSpeech.shift();
  }

  private async decide(observation: SnowdomeObservation): Promise<void> {
    if (!this.options.gateway || this.closed) return;
    try {
      const prompt = buildDecisionPrompt(observation, this.recentSpeech);
      const response = await this.options.gateway.complete(this.options.task, { prompt, messages: [{ role: 'user', content: prompt }] });
      const intent = parseModelIntent(response.content, this.session?.actorId ?? '');
      if (!intent) {
        this.options.onError?.('模型输出不是合法的 Snowdome 意图，已拒绝。');
        return;
      }
      if (intent.kind === 'speak' && observation.heard.length === 0) return;
      if (intent.kind === 'speak' && !intent.text.includes('（沉默）')) this.rememberSpeech(intent.text);
      await this.send(intent);
    } catch (cause) {
      this.options.onError?.(cause instanceof Error ? cause.message : String(cause));
    }
  }
}
