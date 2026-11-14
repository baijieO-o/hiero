import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export type ProcessStatus = 'running' | 'exited' | 'stopped';
export type ProcessOrigin = 'agent' | 'manual';

export interface ManagedProcessInfo {
  id: string;
  command: string;
  cwd: string;
  origin: ProcessOrigin;
  status: ProcessStatus;
  exitCode: number | null;
  startedAt: string;
  /** Total error-looking lines since start, including lines already dropped from the buffer. */
  errorLines: number;
}

export interface ManagedProcessLine {
  stream: 'stdout' | 'stderr';
  text: string;
  error: boolean;
}

interface Entry {
  info: ManagedProcessInfo;
  child: ChildProcess;
  lines: ManagedProcessLine[];
  partial: Record<'stdout' | 'stderr', string>;
}

/** Lines matching this are flagged as errors in the panel. Heuristic, not a parser. */
const ERROR_PATTERN = /\b(error|err!|exception|traceback|fatal|failed|failure)\b|\berror TS\d+/i;

/**
 * Tracks long-running processes started by the agent or by the user. Output is kept in a
 * bounded buffer so a chatty dev server cannot grow memory without limit.
 */
export class ProcessManager {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly maxLines = 4000, private readonly onChange: () => void = () => undefined) {}

  start(command: string, cwd: string, origin: ProcessOrigin): ManagedProcessInfo {
    const shell = process.platform === 'win32' ? { file: 'powershell.exe', args: ['-NoProfile', '-Command', command] } : { file: '/bin/sh', args: ['-c', command] };
    const child = spawn(shell.file, shell.args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const id = randomUUID();
    const info: ManagedProcessInfo = { id, command, cwd, origin, status: 'running', exitCode: null, startedAt: new Date().toISOString(), errorLines: 0 };
    const entry: Entry = { info, child, lines: [], partial: { stdout: '', stderr: '' } };
    this.entries.set(id, entry);
    child.stdout?.on('data', (chunk: Buffer) => this.consume(entry, 'stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.consume(entry, 'stderr', chunk));
    child.on('error', (error) => this.push(entry, 'stderr', error.message));
    child.on('exit', (code) => {
      this.flushPartial(entry);
      if (entry.info.status === 'running') entry.info.status = 'exited';
      entry.info.exitCode = code;
      this.onChange();
    });
    this.onChange();
    return info;
  }

  /** Stops a process. Returns false when the id is unknown or the process already ended. */
  stop(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.info.status !== 'running') return false;
    entry.info.status = 'stopped';
    if (entry.child.pid !== undefined) {
      // Kill the whole tree on Windows, where the shell spawns the real server as a child.
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(entry.child.pid), '/T', '/F'], { windowsHide: true });
      else entry.child.kill('SIGTERM');
    }
    this.onChange();
    return true;
  }

  list(): ManagedProcessInfo[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.info }));
  }

  output(id: string, tail = 200): ManagedProcessLine[] {
    const entry = this.entries.get(id);
    return entry ? entry.lines.slice(-tail) : [];
  }

  /** Stops every running process. Called on runtime shutdown so no server outlives Hiero. */
  stopAll(): void {
    for (const entry of this.entries.values()) this.stop(entry.info.id);
  }

  private consume(entry: Entry, stream: 'stdout' | 'stderr', chunk: Buffer): void {
    const text = entry.partial[stream] + chunk.toString('utf8');
    const parts = text.split(/\r?\n/);
    entry.partial[stream] = parts.pop() ?? '';
    for (const line of parts) this.push(entry, stream, line);
  }

  private flushPartial(entry: Entry): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      if (entry.partial[stream]) this.push(entry, stream, entry.partial[stream]);
      entry.partial[stream] = '';
    }
  }

  private push(entry: Entry, stream: 'stdout' | 'stderr', text: string): void {
    const error = ERROR_PATTERN.test(text);
    if (error) entry.info.errorLines += 1;
    entry.lines.push({ stream, text, error });
    if (entry.lines.length > this.maxLines) entry.lines.splice(0, entry.lines.length - this.maxLines);
  }
}
