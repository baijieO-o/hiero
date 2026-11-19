import { WebSocket } from 'ws';
import type { AdapterPlug } from './hot-plug.js';
import { fetchReputation, postCommitment, snowdomeBaseUrl, type SnowdomeCommitmentReceipt, type SnowdomeCommitmentOutcome, type SnowdomeReputationResponse } from './snowdome-commitments.js';

/** Commitment actions the driver may request. Counterparty and ids are sent as given; Snowdome enforces who may do what. */
export type SnowdomeCommitmentAction =
  | { kind: 'propose'; counterparty: string; content: string }
  | { kind: 'accept'; commitmentId: string }
  | { kind: 'report'; commitmentId: string; outcome: SnowdomeCommitmentOutcome };

export const SNOWDOME_DEFAULT_URL = 'ws://localhost:3000/agent';
export const SNOWDOME_DEFAULT_LOGIN_URL = 'http://localhost:3000/api/login';

/** Visitor session issued by Snowdome's login endpoint; the server assigns the actorId, not the client. */
export interface SnowdomeSession {
  token: string;
  actorId: string;
}

/** Stable id the server maps to one agent resident, so its buildings and backyard survive restarts and town moves. */
const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function agentIdFor(name: string): string {
  const id = name.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  return AGENT_ID_PATTERN.test(id) ? id : 'hiero';
}

/** The town entrance is briefly occupied when a returning resident logs in; retrying later succeeds. */
function isRetryableLoginError(cause: unknown): boolean {
  return cause instanceof Error && cause.message.endsWith('entrance_occupied');
}

export async function loginSnowdome(loginUrl: string, name: string, fetchImpl: typeof fetch = fetch): Promise<SnowdomeSession> {
  const response = await fetchImpl(loginUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, kind: 'agent', agentId: agentIdFor(name) }),
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
  | { kind: 'speak'; actorId: string; mode: 'whisper' | 'talk' | 'shout'; text: string };

export interface SnowdomeObservation {
  kind: 'observation';
  tick: number;
  self: { id: string; position: { x: number; y: number; z: number }; room: number; group: string };
  nearby: { id: string; name: string; position: { x: number; y: number; z: number }; distance: number }[];
  heard: { speakerId: string; mode: string; text: string }[];
  /** Recent conversation from oldest to newest; `heard` is cleared on each take, this is not. */
  recent?: { kind: 'said' | 'heard'; speakerId: string; text: string }[];
  /** Game day index from 0; read this rather than relying on `day_start`, which is absent on the first observation. */
  day_index?: number;
  day_fraction?: number;
  phase?: 'night' | 'dawn' | 'day' | 'dusk';
  /** Present once per game day per subscriber, after the first observation of that day. */
  day_start?: number;
}

export interface SnowdomeReceipt {
  accepted: boolean;
  reason_code: string;
  state_delta: Record<string, unknown>;
  cooldown_ms: number;
}

export interface SnowdomeHistoryEvent {
  seq?: number;
  type?: string;
  [key: string]: unknown;
}

/** Read-only raw history from Snowdome's in-memory window; summarising it is the third party's job. */
export async function fetchSnowdomeHistory(
  historyUrl: string,
  token: string,
  options: { since?: number; limit?: number } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<SnowdomeHistoryEvent[]> {
  const limit = Math.min(1000, Math.max(1, Math.floor(options.limit ?? 200)));
  const since = Math.max(0, Math.floor(options.since ?? 0));
  const url = `${historyUrl}?token=${encodeURIComponent(token)}&since=${since}&limit=${limit}`;
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Snowdome 历史查询失败：${response.status}`);
  const body = await response.json() as { events?: SnowdomeHistoryEvent[] };
  return Array.isArray(body.events) ? body.events : [];
}

/** Derives the history endpoint from the login endpoint, the same way as the heartbeat. */
export function historyUrlFor(loginUrl: string): string {
  if (!/\/api\/login$/.test(loginUrl)) throw new Error(`Snowdome 登录地址必须以 /api/login 结尾：${loginUrl}`);
  return loginUrl.replace(/\/api\/login$/, '/api/agent/history');
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
  return null;
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
  connect: SnowdomeSocketFactory;
  login?: (loginUrl: string, name: string) => Promise<SnowdomeSession>;
  /** HTTP client for commitment calls; tests inject a fake one. */
  fetch?: typeof fetch;
  heartbeat?: (heartbeatUrl: string, token: string) => Promise<boolean>;
  heartbeatIntervalMs?: number;
  reconnectDelayMs?: number;
  onReceipt?: (receipt: SnowdomeReceipt) => void;
  onError?: (message: string) => void;
  /** Called once per game day the first time this subscriber sees it; the third party plans here. */
  onDayStart?: (dayIndex: number) => void | Promise<void>;
  /**
   * The third-party driver. It runs off the observation path, so a slow plan never blocks observation handling;
   * its intents are validated, then queued and paced.
   */
  onObservation: (observation: SnowdomeObservation) => SnowdomeDecision | Promise<SnowdomeDecision>;
  /** Short message the third party wants to share with the owner; the runtime shows it in the chat window. */
  onNotice?: (text: string) => void;
}

/** What a third-party driver returns for one observation: intents to pace out, and optionally a note for the owner. */
export interface SnowdomeDecision {
  intents: SnowdomeIntent[];
  notice?: string;
  /** Optional rewrite of this resident's persona after an important event; applied by the runtime under the persona guardrails. */
  personaUpdate?: string;
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
    // Stays attached after open so a later socket error cannot crash the process; reject is a no-op once resolved.
    ws.on('error', reject);
  });
}

/** Wraps a SnowdomeAdapter as a hot-pluggable adapter so the registry can start and stop it. */
export function snowdomeAdapterPlug(options: SnowdomeAdapterOptions): AdapterPlug & { adapter: SnowdomeAdapter } {
  const adapter = new SnowdomeAdapter(options);
  return { adapter, start: () => adapter.start(), stop: () => adapter.stop() };
}

/** Derives the heartbeat endpoint from the login endpoint, keeping any path prefix. Throws when the login URL has an unexpected shape rather than beating the wrong route. */
export function heartbeatUrlFor(loginUrl: string): string {
  if (!/\/api\/login$/.test(loginUrl)) throw new Error(`Snowdome 登录地址必须以 /api/login 结尾：${loginUrl}`);
  return loginUrl.replace(/\/api\/login$/, '/api/visitor/heartbeat');
}

/** Receipts that mean the visitor session is no longer valid, e.g. after Snowdome restarts and drops its in-memory tokens. */
const STALE_SESSION_CODES = new Set(['login_required', 'unknown_actor']);
const DEFAULT_RECONNECT_MS = 5000;
const NOTICE_MIN_GAP_MS = 60_000;
/** Snowdome moves a visitor out of town after 45 s without a heartbeat, so beat well inside that window. */
const DEFAULT_HEARTBEAT_MS = 15000;
/** With nobody speaking, the driver is still asked at most this often so the resident can walk or start a conversation. */
const IDLE_DECISION_MS = 10000;
/** Snowdome accepts at most 5 intents per 10 s per resident, and at most 1 per second. */
const BURST_LIMIT = 5;
const BURST_WINDOW_MS = 10000;
const MIN_INTERVAL_MS = 1000;

/** Client for Snowdome's agent WebSocket. Intents are sent only after the server accepts the subscription. */
export class SnowdomeAdapter {
  private socket: SnowdomeSocket | undefined;
  private session: SnowdomeSession | undefined;
  private closed = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private readonly pendingReceipts: ((receipt: SnowdomeReceipt) => void)[] = [];
  /** True while the driver's plan is in flight; new observations wait instead of stacking requests. */
  private deciding = false;
  /** Set when a heard line arrived during a plan, so the next observation still gets answered. */
  private pendingHeard = false;
  private lastDecisionAt = 0;
  private lastDay: number | undefined;
  /** Latest observation not yet handed to the third-party hook; newer ones overwrite older ones. */
  private latestObservation: SnowdomeObservation | undefined;
  /** Validated intents waiting to be paced out; a newer batch replaces an unsent older one. */
  private outbox: SnowdomeIntent[] = [];
  private draining = false;
  /** Timestamps of the last few sends, used to honour the server's rate limits. */
  private readonly sentAt: number[] = [];
  /** Ends a pacing wait early when the adapter stops. */
  private wake: (() => void) | undefined;
  /** Earliest time an intent may be sent again after a rate_limited receipt. */
  private cooldownUntil = 0;
  private lastNotice: { text: string; at: number } | undefined;
  /** Bumped by start() and stop() so a connect attempt still in flight can tell it has been superseded. */
  private generation = 0;

  public constructor(private readonly options: SnowdomeAdapterOptions) {}

  public async start(): Promise<void> {
    this.closed = false;
    this.generation += 1;
    try {
      await this.connect(this.generation);
    } catch (cause) {
      // 入口暂时被占用是可恢复的，保持重连而不是放弃这个居民。
      if (isRetryableLoginError(cause)) {
        this.scheduleReconnect();
        throw cause;
      }
      this.stop();
      throw cause;
    }
  }

  private async connect(generation: number): Promise<void> {
    const isStale = () => this.closed || generation !== this.generation;
    const login = this.options.login ?? loginSnowdome;
    const session = await login(this.options.loginUrl ?? SNOWDOME_DEFAULT_LOGIN_URL, this.options.name);
    if (isStale()) return;
    this.session = session;
    const base = this.options.url ?? SNOWDOME_DEFAULT_URL;
    const socket = await this.options.connect(`${base}?token=${encodeURIComponent(session.token)}`);
    if (isStale()) {
      socket.close();
      return;
    }
    this.socket = socket;
    socket.onMessage((data) => this.handleMessage(data));
    socket.onClose(() => this.handleClose(socket));
    const receipt = await this.request({ kind: 'subscribe', actorId: session.actorId });
    if (isStale()) {
      socket.close();
      return;
    }
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
    const heartbeatUrl = heartbeatUrlFor(this.options.loginUrl ?? SNOWDOME_DEFAULT_LOGIN_URL);
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
      this.connect(this.generation).catch((cause: unknown) => {
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

  /** Reputation is public, but the base URL must match the commitment calls, so it lives here too. */
  public async reputation(id: string): Promise<SnowdomeReputationResponse> {
    return fetchReputation(snowdomeBaseUrl(this.options.loginUrl ?? SNOWDOME_DEFAULT_LOGIN_URL), id, this.options.fetch ?? fetch);
  }

  /** Commitment calls need the visitor token, which only the adapter holds; the driver reaches them through the runtime. */
  public async commitment(action: SnowdomeCommitmentAction): Promise<SnowdomeCommitmentReceipt> {
    const session = this.session;
    if (!session) throw new Error('Snowdome adapter is not connected.');
    const baseUrl = snowdomeBaseUrl(this.options.loginUrl ?? SNOWDOME_DEFAULT_LOGIN_URL);
    const fetchImpl = this.options.fetch ?? fetch;
    switch (action.kind) {
      case 'propose':
        return postCommitment(baseUrl, session.token, 'commitment', { counterparty: action.counterparty, content: action.content }, fetchImpl);
      case 'accept':
        return postCommitment(baseUrl, session.token, 'commitment/accept', { commitment_id: action.commitmentId }, fetchImpl);
      case 'report':
        return postCommitment(baseUrl, session.token, 'commitment/report', { commitment_id: action.commitmentId, outcome: action.outcome }, fetchImpl);
    }
  }

  public stop(): void {
    this.closed = true;
    this.generation += 1;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.outbox = [];
    this.latestObservation = undefined;
    this.wake?.();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.resolvePendingAsDisconnected();
  }

  private request(message: Record<string, unknown>): Promise<SnowdomeReceipt> {
    return new Promise((resolve) => {
      this.pendingReceipts.push((receipt) => {
        this.options.onReceipt?.(receipt);
        if (receipt.reason_code === 'rate_limited') this.cooldownUntil = Date.now() + Math.max(receipt.cooldown_ms, 0);
        if (STALE_SESSION_CODES.has(receipt.reason_code) && message.kind !== 'subscribe') this.socket?.close();
        resolve(receipt);
      });
      this.socket?.send(JSON.stringify(message));
    });
  }

  private async handleMessage(data: string): Promise<void> {
    const observation = parseObservation(data);
    if (observation) {
      this.noticeDay(observation);
      this.planFor(observation);
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

  /**
   * Hands the observation to the driver without awaiting it, so a slow plan never holds up observation handling.
   * Throttled: one plan in flight, and with nobody speaking only one per IDLE_DECISION_MS.
   * Skipped heard lines stay in `recent`, so the next plan still sees them.
   */
  private planFor(observation: SnowdomeObservation): void {
    if (observation.heard.length > 0) this.pendingHeard = true;
    this.latestObservation = observation;
    void this.runDriver();
  }

  /** Fires onDayStart when a new game day first appears; the day_index field is the source of truth, day_start is a hint. */
  private noticeDay(observation: SnowdomeObservation): void {
    const day = observation.day_index ?? observation.day_start;
    if (typeof day !== 'number' || day === this.lastDay) return;
    this.lastDay = day;
    if (!this.options.onDayStart) return;
    Promise.resolve(this.options.onDayStart(day)).catch((cause: unknown) => {
      this.options.onError?.(cause instanceof Error ? cause.message : String(cause));
    });
  }

  /**
   * Runs the driver on the latest observation. One run at a time, with an idle throttle. A failing driver only
   * leaves this resident idle for the tick.
   */
  private async runDriver(): Promise<void> {
    if (this.deciding || this.closed || !this.latestObservation) return;
    if (!this.pendingHeard && Date.now() - this.lastDecisionAt < IDLE_DECISION_MS) return;
    const observation = this.latestObservation;
    this.latestObservation = undefined;
    this.pendingHeard = false;
    this.lastDecisionAt = Date.now();
    this.deciding = true;
    try {
      const decision = await this.options.onObservation(observation);
      if (this.closed) return;
      const valid: SnowdomeIntent[] = [];
      for (const intent of decision.intents) {
        const checked = parseSnowdomeIntent(intent, this.session?.actorId ?? '');
        if (checked) valid.push(checked);
        else this.options.onError?.('第三方返回的意图不合法，已拒绝。');
      }
      this.enqueue(valid);
      const notice = decision.notice?.trim();
      if (notice && this.noticeAllowed(notice)) this.options.onNotice?.(notice);
    } catch (cause) {
      this.options.onError?.(cause instanceof Error ? cause.message : String(cause));
    } finally {
      this.deciding = false;
      if (this.pendingHeard) void this.runDriver();
    }
  }

  /** Safety valve for proactive notices: at least a minute apart, and never the same text twice in a row. */
  private noticeAllowed(text: string, now = Date.now()): boolean {
    const last = this.lastNotice;
    if (last && (last.text === text || now - last.at < NOTICE_MIN_GAP_MS)) return false;
    this.lastNotice = { text, at: now };
    return true;
  }

  /** Replaces any unsent batch: the newest observation supersedes intents planned for an older one. */
  private enqueue(intents: SnowdomeIntent[]): void {
    this.outbox = intents;
    void this.drain();
  }

  /** Sends queued intents at the server's pace, and holds off while cooling down after rate_limited. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.outbox.length > 0 && !this.closed && this.socket) {
        const wait = this.waitMs();
        if (wait > 0) {
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              this.wake = undefined;
              resolve();
            };
            const timer = setTimeout(done, wait);
            this.wake = done;
          });
          continue;
        }
        const intent = this.outbox.shift();
        if (!intent) break;
        this.sentAt.push(Date.now());
        if (this.sentAt.length > BURST_LIMIT) this.sentAt.shift();
        await this.send(intent);
      }
    } catch (cause) {
      this.options.onError?.(cause instanceof Error ? cause.message : String(cause));
    } finally {
      this.draining = false;
    }
  }

  /** Milliseconds until the next send is allowed under the 1/s rule, the 5/10 s rule and any rate_limited cooldown. */
  private waitMs(): number {
    const last = this.sentAt.at(-1) ?? 0;
    const burst = this.sentAt.length >= BURST_LIMIT ? (this.sentAt[0] ?? 0) + BURST_WINDOW_MS : 0;
    return Math.max(0, this.cooldownUntil, last + MIN_INTERVAL_MS, burst) - Date.now();
  }
}
