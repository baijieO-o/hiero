import { WebSocket } from 'ws';
import type { CompletionGateway } from './model-gateway.js';
import type { TaskContract } from './contracts.js';
import type { AdapterPlug } from './hot-plug.js';

export const SNOWDOME_DEFAULT_URL = 'ws://localhost:3000/agent';

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

export function buildDecisionPrompt(observation: SnowdomeObservation): string {
  return [
    '你是 Snowdome 世界中的居民。根据下面的观察包决定下一步动作。',
    '只输出一个 JSON 对象，格式之一：',
    '{"kind":"move","target":{"x":整数,"y":整数,"z":整数}}（每次最多移动 3 格）',
    '{"kind":"speak","mode":"whisper|talk|shout","text":"台词"}',
    '{"kind":"leave","destination":"backyard"}',
    '无需行动时，输出 {"kind":"speak","mode":"whisper","text":"（沉默）"}。',
    `观察包：${JSON.stringify(observation)}`,
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
  actorId: string;
  url?: string;
  autoBehavior: boolean;
  connect: SnowdomeSocketFactory;
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

/** Client for Snowdome's agent WebSocket. Intents are sent only after the server accepts the subscription. */
export class SnowdomeAdapter {
  private socket: SnowdomeSocket | undefined;
  private closed = false;
  private readonly pendingReceipts: ((receipt: SnowdomeReceipt) => void)[] = [];

  public constructor(private readonly options: SnowdomeAdapterOptions) {}

  public async start(): Promise<void> {
    const socket = await this.options.connect(this.options.url ?? SNOWDOME_DEFAULT_URL);
    this.socket = socket;
    socket.onMessage((data) => this.handleMessage(data));
    socket.onClose(() => { this.socket = undefined; });
    await this.request({ kind: 'subscribe', actorId: this.options.actorId });
  }

  /** Sends an intent; the socket is only written after parsing so malformed intents never leave the process. */
  public async send(intent: SnowdomeIntent): Promise<SnowdomeReceipt> {
    if (!this.socket) throw new Error('Snowdome adapter is not connected.');
    return this.request(intent);
  }

  public stop(): void {
    this.closed = true;
    this.socket?.close();
    this.socket = undefined;
  }

  private request(message: Record<string, unknown>): Promise<SnowdomeReceipt> {
    return new Promise((resolve) => {
      this.pendingReceipts.push((receipt) => {
        this.options.onReceipt?.(receipt);
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

  private async decide(observation: SnowdomeObservation): Promise<void> {
    if (!this.options.gateway || this.closed) return;
    try {
      const prompt = buildDecisionPrompt(observation);
      const response = await this.options.gateway.complete(this.options.task, { prompt, messages: [{ role: 'user', content: prompt }] });
      const intent = parseModelIntent(response.content, this.options.actorId);
      if (!intent) {
        this.options.onError?.('模型输出不是合法的 Snowdome 意图，已拒绝。');
        return;
      }
      await this.send(intent);
    } catch (cause) {
      this.options.onError?.(cause instanceof Error ? cause.message : String(cause));
    }
  }
}
