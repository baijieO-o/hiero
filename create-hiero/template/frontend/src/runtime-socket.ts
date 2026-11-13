export type RuntimeSocketMessage = {
  type?: string;
  payload?: Record<string, unknown>;
  seq?: number;
};

type Listener = (message: RuntimeSocketMessage) => void;

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 5000;

/**
 * One shared, auto-reconnecting subscription to the runtime. Panels subscribe by message type,
 * so a single connection feeds every read-only panel. Each (re)connect starts with a SNAPSHOT,
 * which panels use to resync instead of trusting events missed while disconnected.
 */
export class RuntimeSocket {
  private socket: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private snapshotListeners = new Set<(seq: number) => void>();
  private gapListeners = new Set<(fromSeq: number, toSeq: number) => void>();
  private statusListeners = new Set<(connected: boolean) => void>();
  private connected = false;
  private refCount = 0;
  private retryTimer: number | undefined;
  private attempts = 0;
  private lastSeq = -1;
  private awaitingResync = false;

  private readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  /** Starts the shared connection when the first subscriber arrives. */
  public subscribe(type: string, listener: Listener): () => void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
    return this.retain(() => {
      set.delete(listener);
    });
  }

  /** Fires when server seq numbers skip ahead, meaning events were missed; listeners should resync. */
  public onGap(listener: (fromSeq: number, toSeq: number) => void): () => void {
    this.gapListeners.add(listener);
    return this.retain(() => {
      this.gapListeners.delete(listener);
    });
  }

  /** Receives the snapshot seq on every (re)connect, so a panel can resync its state. */
  public onSnapshot(listener: (seq: number) => void): () => void {
    this.snapshotListeners.add(listener);
    return this.retain(() => {
      this.snapshotListeners.delete(listener);
    });
  }

  /** Fires when the socket opens or closes, so the UI can show a real connection state. */
  public onStatus(listener: (connected: boolean) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.connected);
    return this.retain(() => {
      this.statusListeners.delete(listener);
    });
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    for (const listener of this.statusListeners) listener(connected);
  }

  private retain(cleanup: () => void): () => void {
    this.refCount += 1;
    this.ensureConnected();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      cleanup();
      this.refCount -= 1;
      if (this.refCount === 0) this.disconnect();
    };
  }

  private ensureConnected(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.onopen = () => {
      this.attempts = 0;
      this.setConnected(true);
      // Ask the server to replay events after the last seq we saw before the drop.
      if (this.lastSeq >= 0) socket.send(JSON.stringify({ type: 'RESUME', payload: { since: this.lastSeq } }));
    };
    socket.onmessage = (event) => this.dispatch(event.data);
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.setConnected(false);
      if (this.refCount > 0) this.scheduleReconnect();
    };
    socket.onerror = () => { /* onclose follows and handles reconnect. */ };
  }

  private scheduleReconnect(): void {
    if (this.retryTimer !== undefined) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.attempts);
    this.attempts += 1;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined;
      if (this.refCount > 0) this.ensureConnected();
    }, delay);
  }

  private disconnect(): void {
    if (this.retryTimer !== undefined) { window.clearTimeout(this.retryTimer); this.retryTimer = undefined; }
    const socket = this.socket;
    this.socket = null;
    this.setConnected(false);
    socket?.close();
  }

  private dispatch(raw: unknown): void {
    let message: RuntimeSocketMessage;
    try { message = JSON.parse(String(raw)) as RuntimeSocketMessage; } catch { return; }
    if (message.type === 'SNAPSHOT') {
      const seq = typeof message.payload?.seq === 'number' ? message.payload.seq : 0;
      // Only re-base lastSeq when no baseline exists or a gap resync was requested. On a plain reconnect
      // keep the pre-drop lastSeq so the RESUME replay is not treated as stale.
      if (this.lastSeq < 0 || this.awaitingResync) {
        this.lastSeq = seq;
        this.awaitingResync = false;
      }
      for (const listener of this.snapshotListeners) listener(seq);
    }
    if (typeof message.seq === 'number') {
      if (this.lastSeq >= 0 && message.seq > this.lastSeq + 1) {
        for (const listener of this.gapListeners) listener(this.lastSeq, message.seq);
        // Ask the server for a fresh SNAPSHOT so panels resync and lastSeq is re-based.
        this.awaitingResync = true;
        this.socket?.send(JSON.stringify({ type: 'SNAPSHOT_REQUEST' }));
      }
      this.lastSeq = message.seq;
    }
    if (!message.type) return;
    for (const listener of this.listeners.get(message.type) ?? []) listener(message);
    for (const listener of this.listeners.get('*') ?? []) listener(message);
  }

  /** Last server sequence number seen on this connection. Useful for debugging ordering issues. */
  public get currentSeq(): number { return this.lastSeq; }
}

const sharedSockets = new Map<string, RuntimeSocket>();

/** Returns the one RuntimeSocket for a URL, so every panel shares a single connection. */
export function runtimeSocketFor(url: string): RuntimeSocket {
  let socket = sharedSockets.get(url);
  if (!socket) {
    socket = new RuntimeSocket(url);
    sharedSockets.set(url, socket);
  }
  return socket;
}
