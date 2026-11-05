import { WebSocketServer, WebSocket } from 'ws';
import type { ErrorRecord, HandoffDocument } from './contracts.js';
import { AgentStateMachine, type AgentState, type StateTransition } from './state-machine.js';
import type { VerificationResult } from './verification.js';
import type { ChatTraceEvent } from './chat-trace.js';
import type { StoredChatTrace } from './trace-store.js';
import type { TaskRecord } from './state-store.js';
import type { ContextUsageBreakdown } from './context-usage.js';
import type { McpServerEntry } from './mcp-config.js';
import type { McpServerStatus } from './mcp-client.js';
import { isAllowedOrigin, isLoopbackAddress } from './ws-guard.js';
import { SystemStatsSampler, type SystemStats } from './system-stats.js';
export type RuntimeEvent =
  | { type: 'SYSTEM_STATS'; payload: SystemStats & { timestamp: string } }
  | { type: 'STATE_CHANGE'; payload: { node: AgentState; status: 'running' | 'completed' } }
  | { type: 'FILE_DIFF'; payload: { path: string; original: string; modified: string } }
  | { type: 'HANDOFF_TRIGGERED'; payload: HandoffDocument }
  | { type: 'VERIFY_RESULT'; payload: VerificationResult }
  | { type: 'REWIND_RESULT'; payload: { restored: string[]; skipped: string[] } }
  | { type: 'EXTENSION_READY'; payload: { request_id: string; plugin_path: string; mcp_config_path: string } }
  | { type: 'ERROR'; payload: ErrorRecord }
  | { type: 'CHAT_DELTA'; payload: { request_id: string; text: string } }
  | { type: 'CHAT_RESET'; payload: { request_id: string } }
  | { type: 'CHAT_TOOL'; payload: { request_id: string; name: string; arguments: string; result: string } }
  | { type: 'CHAT_REPLY'; payload: { request_id: string; content: string; model: string; usage?: { input_tokens: number; output_tokens: number; calls: number; duration_ms: number } } }
  | { type: 'CHAT_ERROR'; payload: { request_id: string; code: string; message: string } }
  | { type: 'CHAT_TRACE'; payload: { request_id: string; events: ChatTraceEvent[] } }
  | { type: 'CHAT_TRACE_HISTORY'; payload: { workspace: string; traces: StoredChatTrace[] } }
  | { type: 'TASK_HISTORY'; payload: { tasks: TaskRecord[] } }
  | { type: 'CHAT_CANCELLED'; payload: { request_id: string } }
  | { type: 'CHAT_UNKNOWN'; payload: { request_id: string } }
  | { type: 'CHAT_USAGE'; payload: { request_id: string; usage: ContextUsageBreakdown } }
  | { type: 'MODEL_LIST'; payload: { request_id: string; models: string[]; error?: string } }
  | { type: 'CHAT_COMPACTED'; payload: { request_id: string; summary: string; before_tokens: number; after_tokens: number; kept_messages: number } | { request_id: string; ok: false; message: string } }
  | { type: 'SETTINGS'; payload: { endpoint: string; model: string; token_count: number } }
  | { type: 'SETTINGS_SAVE_RESULT'; payload: { ok: true; settings: { endpoint: string; model: string; token_count: number } } | { ok: false; message: string } }
  | { type: 'MCP_CONFIG'; payload: { servers: McpServerEntry[]; statuses: McpServerStatus[]; path: string } }
  | { type: 'MCP_CONFIG_SAVE_RESULT'; payload: { ok: true; servers: McpServerEntry[]; statuses: McpServerStatus[]; path: string } | { ok: false; message: string } }
  | { type: 'WORKSPACE_RESULT'; payload: Record<string, unknown> & { request_id: string; kind: string } }
  | { type: 'APPROVAL_REQUIRED'; payload: { approval_id: string; tool_name: string; summary: string; input: unknown } }
  | { type: 'ROLLBACK_RESULT'; payload: { ok: true; restored: string[]; skipped: string[]; warning?: unknown } | { ok: false; message: string } };

/** Sent once on connect. Lets a (re)connected panel rebuild its state node instead of waiting for the next transition. */
export type RuntimeSnapshotEvent = { type: 'SNAPSHOT'; payload: { seq: number; node: AgentState } };

/** Client request sent on reconnect with the last seq it saw, asking the server to replay what it missed. */
function parseResumeSince(data: unknown): number | undefined {
  try {
    const message = JSON.parse(String(data)) as { type?: unknown; payload?: { since?: unknown } };
    return message.type === 'RESUME' && typeof message.payload?.since === 'number' ? message.payload.since : undefined;
  } catch {
    return undefined;
  }
}

/** Client request, sent after it detects a seq gap, to resync without a reconnect. */
function isSnapshotRequestData(data: unknown): boolean {
  try {
    const message: unknown = JSON.parse(String(data));
    return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'SNAPSHOT_REQUEST';
  } catch {
    return false;
  }
}

export class RuntimeWebSocketServer {
  private readonly server: WebSocketServer;
  private readonly clients = new Set<WebSocket>();
  private seq = 0;
  /** Recent broadcast messages keyed by seq, so a reconnecting client can replay what it missed. */
  private readonly replayBuffer: { seq: number; message: string }[] = [];
  private readonly statsSampler = new SystemStatsSampler();
  private statsTimer: NodeJS.Timeout | undefined;

  public constructor(private readonly machine: AgentStateMachine, port = 8080, private readonly replayCapacity = 500) {
    this.server = new WebSocketServer({
      port,
      verifyClient: ({ origin, req }, done) => {
        if (!isLoopbackAddress(req.socket.remoteAddress)) return done(false, 403, 'Forbidden: loopback clients only');
        if (!isAllowedOrigin(origin)) return done(false, 403, 'Forbidden: origin not allowed');
        done(true);
      },
    });
    this.server.on('connection', (client) => {
      this.clients.add(client);
      client.on('close', () => this.clients.delete(client));
      client.on('error', () => this.clients.delete(client));
      this.sendRaw({ type: 'SNAPSHOT', payload: { seq: this.seq, node: this.machine.state } }, client);
      client.on('message', (data) => {
        if (isSnapshotRequestData(data)) {
          this.sendRaw({ type: 'SNAPSHOT', payload: { seq: this.seq, node: this.machine.state } }, client);
          return;
        }
        const since = parseResumeSince(data);
        if (since !== undefined) this.resume(since, client);
      });
      this.ensureStatsTimer();
    });
  }

  /** Samples system stats only while at least one client is connected. */
  private ensureStatsTimer(): void {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(() => {
      if (this.clients.size === 0) {
        clearInterval(this.statsTimer);
        this.statsTimer = undefined;
        return;
      }
      void this.statsSampler.sample().then((stats) => {
        this.broadcast({ type: 'SYSTEM_STATS', payload: { ...stats, timestamp: new Date().toISOString() } });
      });
    }, 2000);
  }

  public onMessage(handler: (message: unknown, client: WebSocket) => void | Promise<void>): void {
    this.server.on('connection', (client) => {
      client.on('message', (data) => {
        try {
          const message: unknown = JSON.parse(data.toString());
          void handler(message, client);
        } catch {
          this.reportError(new Error('Invalid WebSocket message JSON.'));
        }
      });
    });
  }

  public get currentSeq(): number {
    return this.seq;
  }

  public broadcast(event: RuntimeEvent): void {
    this.seq += 1;
    const message = JSON.stringify({ ...event, seq: this.seq });
    this.replayBuffer.push({ seq: this.seq, message });
    if (this.replayBuffer.length > this.replayCapacity) this.replayBuffer.shift();
    for (const client of this.clients) this.sendMessage(message, client);
  }

  /** Sends events after `since`. Falls back to a SNAPSHOT when the buffer no longer covers the gap. */
  private resume(since: number, client: WebSocket): void {
    const oldest = this.replayBuffer[0]?.seq ?? this.seq + 1;
    if (since < oldest - 1) {
      this.sendRaw({ type: 'SNAPSHOT', payload: { seq: this.seq, node: this.machine.state } }, client);
      return;
    }
    for (const entry of this.replayBuffer) {
      if (entry.seq > since) this.sendMessage(entry.message, client);
    }
  }

  public send(event: RuntimeEvent, client?: WebSocket): void {
    const message = JSON.stringify(event);
    const targets = client ? [client] : this.clients;
    for (const target of targets) this.sendMessage(message, target);
  }

  /** Sends an already-serialized message to one client. Used to replay buffered chat events. */
  public sendRawMessage(message: string, client: WebSocket): void {
    this.sendMessage(message, client);
  }

  private sendRaw(event: RuntimeSnapshotEvent, client: WebSocket): void {
    this.sendMessage(JSON.stringify(event), client);
  }

  private sendMessage(message: string, target: WebSocket): void {
    if (target.readyState === WebSocket.OPEN) target.send(message);
  }

  public transition(to: AgentState, verified = false): StateTransition {
    const transition = this.machine.transition(to, verified);
    this.onTransition?.(transition);
    this.broadcast({ type: 'STATE_CHANGE', payload: { node: transition.to, status: 'running' } });
    return transition;
  }

  /** Hook for persisting each state change. */
  public onTransition?: (transition: StateTransition) => void;

  public completeState(node: AgentState): void {
    this.broadcast({ type: 'STATE_CHANGE', payload: { node, status: 'completed' } });
  }

  public reportError(exception: unknown): ErrorRecord {
    const record = this.machine.toErrorRecord(exception);
    this.broadcast({ type: 'ERROR', payload: record });
    return record;
  }

  public async close(): Promise<void> {
    clearInterval(this.statsTimer);
    this.statsTimer = undefined;
    for (const client of this.clients) client.close();
    await new Promise<void>((resolve, reject) => this.server.close((cause) => cause ? reject(cause) : resolve()));
  }
}

