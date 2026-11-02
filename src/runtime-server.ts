import { WebSocketServer, WebSocket } from 'ws';
import type { ErrorRecord, HandoffDocument } from './contracts.js';
import { AgentStateMachine, type AgentState, type StateTransition } from './state-machine.js';
import type { McpStdioServerEntry } from './mcp-config.js';
import type { McpServerStatus } from './mcp-client.js';
export type RuntimeEvent =
  | { type: 'STATE_CHANGE'; payload: { node: AgentState; status: 'running' | 'completed' } }
  | { type: 'FILE_DIFF'; payload: { path: string; original: string; modified: string } }
  | { type: 'HANDOFF_TRIGGERED'; payload: HandoffDocument }
  | { type: 'EXTENSION_READY'; payload: { request_id: string; plugin_path: string; mcp_config_path: string } }
  | { type: 'ERROR'; payload: ErrorRecord }
  | { type: 'CHAT_DELTA'; payload: { request_id: string; text: string } }
  | { type: 'CHAT_RESET'; payload: { request_id: string } }
  | { type: 'CHAT_TOOL'; payload: { request_id: string; name: string; arguments: string; result: string } }
  | { type: 'CHAT_REPLY'; payload: { request_id: string; content: string; model: string } }
  | { type: 'CHAT_ERROR'; payload: { request_id: string; code: string; message: string } }
  | { type: 'SETTINGS'; payload: { endpoint: string; model: string; token_count: number } }
  | { type: 'SETTINGS_SAVE_RESULT'; payload: { ok: true; settings: { endpoint: string; model: string; token_count: number } } | { ok: false; message: string } }
  | { type: 'MCP_CONFIG'; payload: { servers: McpStdioServerEntry[]; statuses: McpServerStatus[]; path: string } }
  | { type: 'MCP_CONFIG_SAVE_RESULT'; payload: { ok: true; servers: McpStdioServerEntry[]; statuses: McpServerStatus[]; path: string } | { ok: false; message: string } }
  | { type: 'WORKSPACE_RESULT'; payload: Record<string, unknown> & { request_id: string; kind: string } }
  | { type: 'APPROVAL_REQUIRED'; payload: { approval_id: string; tool_name: string; summary: string; input: unknown } }
  | { type: 'ROLLBACK_RESULT'; payload: { ok: true; restored: string[]; skipped: string[]; warning?: unknown } | { ok: false; message: string } };

export class RuntimeWebSocketServer {
  private readonly server: WebSocketServer;
  private readonly clients = new Set<WebSocket>();

  public constructor(private readonly machine: AgentStateMachine, port = 8080) {
    this.server = new WebSocketServer({ port });
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
