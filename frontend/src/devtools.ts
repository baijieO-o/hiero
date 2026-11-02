import { RUNTIME_WS_URL } from './runtime-url';
export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export type ConsoleEntry = { id: number; time: number; level: LogLevel; text: string; source: 'console' | 'uncaught' | 'eval' };
export type NetworkEntry = { id: number; time: number; method: string; url: string; status: number | null; ok: boolean; durationMs: number };
export type RuntimeEntry = { id: number; time: number; type: string; detail: string };

export type DevtoolsSnapshot = { console: ConsoleEntry[]; network: NetworkEntry[]; runtime: RuntimeEntry[] };

const MAX_ENTRIES = 500;
const RUNTIME_URL = RUNTIME_WS_URL;

let nextId = 1;
let snapshot: DevtoolsSnapshot = { console: [], network: [], runtime: [] };
const listeners = new Set<() => void>();

function commit(next: Partial<DevtoolsSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((listener) => listener());
}

function append<T>(list: T[], entry: T): T[] {
  return [...list, entry].slice(-MAX_ENTRIES);
}

export function subscribeDevtools(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getDevtoolsSnapshot(): DevtoolsSnapshot {
  return snapshot;
}

export function clearConsoleEntries(): void {
  commit({ console: [] });
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (value === undefined) return 'undefined';
  if (typeof value === 'function') return `ƒ ${value.name || 'anonymous'}()`;
  if (typeof value !== 'object' || value === null) return String(value);
  try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return String(value); }
}

function recordConsole(level: LogLevel, text: string, source: ConsoleEntry['source'] = 'console'): void {
  commit({ console: append(snapshot.console, { id: nextId++, time: Date.now(), level, text, source }) });
}

function recordNetwork(entry: Omit<NetworkEntry, 'id' | 'time'>): void {
  commit({ network: append(snapshot.network, { id: nextId++, time: Date.now(), ...entry }) });
}

function recordRuntime(type: string, detail: string): void {
  commit({ runtime: append(snapshot.runtime, { id: nextId++, time: Date.now(), type, detail }) });
}

export function evaluateInPage(code: string): void {
  recordConsole('log', `> ${code}`, 'eval');
  try {
    // Indirect eval runs in the global scope, like the DevTools console prompt.
    const result: unknown = (0, eval)(code);
    recordConsole('log', `< ${formatValue(result)}`, 'eval');
  } catch (cause) {
    recordConsole('error', formatValue(cause), 'eval');
  }
}

type DevtoolsWindow = Window & { __hieroDevtoolsInstalled?: boolean };

// Hooks the page's console, uncaught errors, fetch and the runtime socket. Runs once per page load.
export function installDevtools(): void {
  const host = window as DevtoolsWindow;
  if (host.__hieroDevtoolsInstalled) return;
  host.__hieroDevtoolsInstalled = true;

  const levels: LogLevel[] = ['log', 'info', 'warn', 'error', 'debug'];
  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      recordConsole(level, args.map(formatValue).join(' '));
    };
  }

  window.addEventListener('error', (event) => {
    const text = event.error instanceof Error ? formatValue(event.error) : `${event.message} (${event.filename}:${event.lineno}:${event.colno})`;
    recordConsole('error', text, 'uncaught');
  });
  window.addEventListener('unhandledrejection', (event) => {
    recordConsole('error', `Uncaught (in promise) ${formatValue(event.reason)}`, 'uncaught');
  });

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const started = performance.now();
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const elapsed = () => Math.round(performance.now() - started);
    try {
      const response = await originalFetch(input, init);
      recordNetwork({ method, url, status: response.status, ok: response.ok, durationMs: elapsed() });
      return response;
    } catch (cause) {
      recordNetwork({ method, url, status: null, ok: false, durationMs: elapsed() });
      throw cause;
    }
  };

  const socket = new WebSocket(RUNTIME_URL);
  socket.onmessage = (event) => {
    try {
      const message = JSON.parse(String(event.data)) as { type?: string; payload?: unknown };
      const detail = JSON.stringify(message.payload ?? {});
      recordRuntime(message.type ?? 'UNKNOWN', detail.length > 300 ? `${detail.slice(0, 300)}…` : detail);
    } catch {
      recordRuntime('NON_JSON', String(event.data).slice(0, 300));
    }
  };
}
