import { ChildProcess, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ErrorRecord } from './contracts.js';
import type { ExtensionRequest, ExtensionReady, SystemAgentError } from './system_agent.js';

type SystemAgentMessage = ExtensionReady | SystemAgentError;
type PendingRequest = { resolve: (message: SystemAgentMessage) => void; reject: (cause: Error) => void; timer: NodeJS.Timeout };

export class SystemAgentClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, PendingRequest>();
  private buffer = '';
  private closed = false;

  public constructor(private readonly requestTimeoutMs = 120_000) {
    this.child = fork(join(import.meta.dirname, 'system_agent.js'), [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.handleOutput(chunk));
    this.child.on('error', (cause) => this.failPending(cause instanceof Error ? cause : new Error(String(cause))));
    this.child.on('exit', (code, signal) => {
      if (!this.closed) this.failPending(new Error(`SystemAgent exited unexpectedly (${signal ?? code ?? 'unknown'}).`));
    });
  }

  public install(githubUrl: string, installRoot?: string): Promise<ExtensionReady | SystemAgentError> {
    if (this.closed || !this.child.stdin?.writable) return Promise.reject(new Error('SystemAgent is closed.'));
    const request: ExtensionRequest = { request_id: randomUUID(), github_url: githubUrl, ...(installRoot ? { install_root: installRoot } : {}) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.request_id);
        reject(new Error(`SystemAgent request timed out after ${this.requestTimeoutMs}ms.`));
      }, this.requestTimeoutMs);
      this.pending.set(request.request_id, { resolve, reject, timer });
      this.child.stdin?.write(`${JSON.stringify(request)}\n`, (cause) => {
        if (cause) {
          clearTimeout(timer);
          this.pending.delete(request.request_id);
          reject(cause);
        }
      });
    });
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failPending(new Error('SystemAgent closed.'));
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return resolve();
      const timer = setTimeout(() => { this.child.kill(); resolve(); }, 1000);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
      this.child.stdin?.end();
    });
  }

  private handleOutput(output: string): void {
    this.buffer += output;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as SystemAgentMessage;
        const request = this.pending.get(message.request_id);
        if (!request) continue;
        clearTimeout(request.timer);
        this.pending.delete(message.request_id);
        request.resolve(message);
      } catch { /* Ignore malformed child output; the request timeout remains authoritative. */ }
    }
  }

  private failPending(cause: Error): void {
    for (const [requestId, request] of this.pending) {
      clearTimeout(request.timer);
      this.pending.delete(requestId);
      request.reject(cause);
    }
  }
}
