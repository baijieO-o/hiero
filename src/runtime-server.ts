import { WebSocketServer, WebSocket } from 'ws';
import type { ErrorRecord, HandoffDocument } from './contracts.js';
import { AgentStateMachine, type AgentState, type StateTransition } from './state-machine.js';
import type { VerificationResult } from './verification.js';
import type { ChatTraceEvent } from './chat-trace.js';
import type { StoredChatTrace } from './trace-store.js';
import type { McpServerEntry } from './mcp-config.js';
import type { McpServerStatus } from './mcp-client.js';
import { isAllowedOrigin, isLoopbackAddress } from './ws-guard.js';
export type RuntimeEvent =
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
  | { type: 'CHAT_CANCELLED'; payload: { request_id: string } }
  | { type: 'SETTINGS'; payload: { endpoint: string; model: string; token_count: number } }
  | { type: 'SETTINGS_SAVE_RESULT'; payload: { ok: true; settings: { endpoint: string; model: string; token_count: number } } | { ok: false; message: string } }
  | { type: 'MCP_CONFIG'; payload: { servers: McpServerEntry[]; statuses: McpServerStatus[]; path: string } }
  | { type: 'MCP_CONFIG_SAVE_RESULT'; payload: { ok: true; servers: McpServerEntry[]; statuses: McpServerStatus[]; path: string } | { ok: false; message: string } }
  | { type: 'WORKSPACE_RESULT'; payload: Record<string, unknown> & { request_id: string; kind: string } }
  | { type: 'APPROVAL_REQUIRED'; payload: { approval_id: string; tool_name: string; summary: string; input: unknown } }
  | { type: 'ROLLBACK_RESULT'; payload: { ok: true; restored: string[]; skipped: string[]; warning?: unknown } | { ok: false; message: string } };

export class RuntimeWebSocketServer {
  private readonly server: WebSocketServer;
  private readonly clients = new Set<WebSocket>();

  public constructor(private readonly machine: AgentStateMachine, port = 8080) {
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
    });
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

  public broadcast(event: RuntimeEvent): void {
    for (const client of this.clients) this.send(event, client);
  }

  public send(event: RuntimeEvent, client?: WebSocket): void {
    const message = JSON.stringify(event);
    const targets = client ? [client] : this.clients;
    for (const target of targets) {
      if (target.readyState === WebSocket.OPEN) target.send(message);
    }
  }

  public transition(to: AgentState, verified = false): StateTransition {
    const transition = this.machine.transition(to, verified);
    this.broadcast({ type: 'STATE_CHANGE', payload: { node: transition.to, status: 'running' } });
    return transition;
  }

  public completeState(node: AgentState): void {
    this.broadcast({ type: 'STATE_CHANGE', payload: { node, status: 'completed' } });
  }

  public reportError(exception: unknown): ErrorRecord {
    const record = this.machine.toErrorRecord(exception);
    this.broadcast({ type: 'ERROR', payload: record });
    return record;
  }

  public async close(): Promise<void> {
    for (const client of this.clients) client.close();
    await new Promise<void>((resolve, reject) => this.server.close((cause) => cause ? reject(cause) : resolve()));
  }
}

