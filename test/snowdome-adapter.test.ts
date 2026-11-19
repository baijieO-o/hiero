import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { HotPlugRegistry } from '../src/hot-plug.js';
import { readSnowdomeConfig } from '../src/snowdome-config.js';
import { McpToolClient } from '../src/mcp-client.js';
import { SnowdomeAdapter, fetchSnowdomeHistory, fetchSnowdomeRecent, historyUrlFor, heartbeatUrlFor, isSingleEmoji, loginSnowdome, parseSnowdomeIntent, recentUrlFor, snowdomeAdapterPlug, type SnowdomeObservation, type SnowdomeSocket } from '../src/snowdome-adapter.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class FakeSocket implements SnowdomeSocket {
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  protected closeHandler: (() => void) | undefined;
  private messageHandler: ((data: string) => void) | undefined;
  send(data: string): void {
    const message = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(message);
    this.emit({ accepted: true, reason_code: 'ok', state_delta: {}, cooldown_ms: 0 });
  }
  close(): void { this.closed = true; }
  onMessage(handler: (data: string) => void): void { this.messageHandler = handler; }
  onClose(handler: () => void): void { this.closeHandler = handler; }
  emit(value: unknown): void { this.messageHandler?.(JSON.stringify(value)); }
}

const observation = { kind: 'observation' as const, tick: 1, time: 0, self: { id: 'hiero', position: { x: 0, y: 0, z: 0 }, room: 0, group: 'plaza' }, nearby: [], heard: [] };
const heardObservation = { ...observation, heard: [{ speakerId: 'alice', mode: 'talk', text: '你从哪里来？' }] };

// Keeps `recent` reads off the network; the recent endpoint has its own tests.
const fakeRecentFetch = (async () => new Response(JSON.stringify({ actorId: 'visitor-1', utterances: [], last_seq: 0 }), { status: 200 })) as typeof fetch;

const fakeLogin = async (): Promise<{ token: string; actorId: string }> => ({ token: 'tok', actorId: 'visitor-1' });

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('parseSnowdomeIntent accepts only the adapter protocol intents', () => {
  assert.deepEqual(parseSnowdomeIntent({ kind: 'move', target: { x: 1, y: 0, z: 2 } }, 'hiero'), { kind: 'move', actorId: 'hiero', target: { x: 1, y: 0, z: 2 } });
  assert.deepEqual(parseSnowdomeIntent({ kind: 'speak', mode: 'talk', text: '你好' }, 'hiero'), { kind: 'speak', actorId: 'hiero', mode: 'talk', text: '你好' });
  assert.equal(parseSnowdomeIntent({ kind: 'place', block: 'stone' }, 'hiero'), null);
  assert.equal(parseSnowdomeIntent({ kind: 'move', target: { x: 1.5, y: 0, z: 0 } }, 'hiero'), null);
  assert.equal(parseSnowdomeIntent({ kind: 'speak', mode: 'yell', text: 'hi' }, 'hiero'), null);
  assert.equal(parseSnowdomeIntent({ kind: 'speak', mode: 'talk', text: '   ' }, 'hiero'), null);
});

test('start logs in, connects with the issued token, and subscribes to the server-assigned actorId', async () => {
  const socket = new FakeSocket();
  const urls: string[] = [];
  const logins: string[] = [];
  const adapter = new SnowdomeAdapter({ chooseBaselineEmote: () => '🙂',
    fetch: fakeRecentFetch,
    name: 'hiero',
    url: 'ws://localhost:3000/agent',
    loginUrl: 'http://localhost:3000/api/login',
    connect: async (url) => { urls.push(url); return socket; },
    login: async (loginUrl, name) => { logins.push(`${loginUrl} ${name}`); return { token: 'a b', actorId: 'visitor-9' }; },
    onObservation: () => ({ intents: [] }),
    onError: () => {},
  });
  await adapter.start();
  assert.deepEqual(logins, ['http://localhost:3000/api/login hiero']);
  assert.deepEqual(urls, ['ws://localhost:3000/agent?token=a%20b']);
  assert.deepEqual(socket.sent[0], { kind: 'subscribe', actorId: 'visitor-9' });
  assert.equal(adapter.actorId, 'visitor-9');
  adapter.stop();
});

test('heartbeat endpoint keeps the login path prefix and rejects unexpected login URLs', () => {
  assert.equal(heartbeatUrlFor('http://localhost:3000/api/login'), 'http://localhost:3000/api/visitor/heartbeat');
  assert.equal(heartbeatUrlFor('https://example.com/snow/api/login'), 'https://example.com/snow/api/visitor/heartbeat');
  assert.throws(() => heartbeatUrlFor('https://example.com/login'), /必须以 \/api\/login 结尾/);
});

test('stop() during login leaves no socket connected and no heartbeat running', async () => {
  let releaseLogin: (() => void) | undefined;
  const sockets: FakeSocket[] = [];
  const beats: string[] = [];
  const adapter = new SnowdomeAdapter({ chooseBaselineEmote: () => '🙂',
    fetch: fakeRecentFetch,
    name: 'hiero',
    heartbeatIntervalMs: 5,
    connect: async () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    login: () => new Promise((resolve) => { releaseLogin = () => resolve({ token: 'tok', actorId: 'visitor-1' }); }),
    heartbeat: async (url) => { beats.push(url); return true; },
    onObservation: () => ({ intents: [] }),
  });
  const starting = adapter.start();
  adapter.stop();
  releaseLogin?.();
  await starting;
  await wait(20);
  assert.equal(sockets.length, 0);
  assert.equal(beats.length, 0);
});

test('start does not connect when login is rejected', async () => {
  let connected = false;
  const adapter = new SnowdomeAdapter({ chooseBaselineEmote: () => '🙂',
    fetch: fakeRecentFetch,
    name: 'hiero',
    connect: async () => { connected = true; return new FakeSocket(); },
    login: async () => { throw new Error('Snowdome 登录失败：name_taken'); },
    onObservation: () => ({ intents: [] }),
    onError: () => {},
  });
  await assert.rejects(adapter.start(), /name_taken/);
  assert.equal(connected, false);
});

test('a returning resident whose entrance is occupied keeps retrying until login succeeds', async () => {
  let logins = 0;
  const adapter = new SnowdomeAdapter({ chooseBaselineEmote: () => '🙂',
    fetch: fakeRecentFetch,
    name: 'hiore',
    reconnectDelayMs: 1,
    connect: async () => new FakeSocket(),
    login: async () => {
      logins += 1;
      if (logins < 3) throw new Error('Snowdome 登录失败：entrance_occupied');
      return { token: 'tok', actorId: 'agent-hiore' };
    },
    onObservation: () => ({ intents: [] }),
    onError: () => {},
  });
  await assert.rejects(adapter.start(), /entrance_occupied/);
  await wait(50);
  assert.equal(logins, 3);
  assert.equal(adapter.actorId, 'agent-hiore');
  adapter.stop();
});

test('a visitor adapter beats for its token and stops beating after stop()', async () => {
  const beats: string[] = [];
  const adapter = new SnowdomeAdapter({ chooseBaselineEmote: () => '🙂',
    fetch: fakeRecentFetch,
    name: 'hiero',
    heartbeatIntervalMs: 5,
    connect: async () => new FakeSocket(),
    login: fakeLogin,
    heartbeat: async (url, token) => { beats.push(`${url}|${token}`); return true; },
    onObservation: () => ({ intents: [] }),
  });
  await adapter.start();
  await wait(100);
  adapter.stop();
  const count = beats.length;
  assert.ok(count >= 2);
  assert.equal(beats[0], 'http://localhost:3000/api/visitor/heartbeat|tok');
  await wait(20);
  assert.equal(beats.length, count);
});

test('a rejected heartbeat (401) drops the session and re-logs in', async () => {
  let logins = 0;
  const sockets: FakeSocket[] = [];
  const adapter = new SnowdomeAdapter({ chooseBaselineEmote: () => '🙂',
    fetch: fakeRecentFetch,
    name: 'hiero',
    heartbeatIntervalMs: 5,
    reconnectDelayMs: 1,
    connect: async () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    login: async () => { logins += 1; return { token: `tok${logins}`, actorId: `visitor-${logins}` }; },
    heartbeat: async () => false,
    onObservation: () => ({ intents: [] }),
    onError: () => {},
  });
  await adapter.start();
  await wait(30);
  adapter.stop();
  assert.ok(logins >= 2);
  assert.equal(sockets[0]?.closed, true);
});

class StaleSocket extends FakeSocket {
  constructor(private readonly staleOnMove: boolean) { super(); }
  override close(): void { if (!this.closed) { this.closed = true; this.closeHandler?.(); } }
  override send(data: string): void {
    const message = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(message);
    if (this.staleOnMove && message.kind === 'move') {
      this.emit({ accepted: false, reason_code: 'login_required', state_delta: {}, cooldown_ms: 0 });
      this.close();
      return;
    }
    this.emit({ accepted: true, reason_code: 'ok', state_delta: {}, cooldown_ms: 0 });
  }
}

test('a stale-session receipt triggers re-login and reconnect with the new token', async () => {
  const sockets: StaleSocket[] = [];
  const tokens: string[] = [];
  let logins = 0;
  const adapter = new SnowdomeAdapter({ chooseBaselineEmote: () => '🙂',
    fetch: fakeRecentFetch,
    name: 'hiero',
    reconnectDelayMs: 1,
    connect: async (url) => { tokens.push(url.split('token=')[1] ?? ''); const socket = new StaleSocket(sockets.length === 0); sockets.push(socket); return socket; },
    login: async () => { logins += 1; return { token: `tok${logins}`, actorId: `visitor-${logins}` }; },
    onObservation: () => ({ intents: [] }),
    onError: () => {},
  });
  await adapter.start();
  const receipt = await adapter.send({ kind: 'move', actorId: 'visitor-1', target: { x: 1, y: 0, z: 0 } });
  assert.equal(receipt.reason_code, 'login_required');
  await wait(20);
  assert.equal(logins, 2);
  assert.deepEqual(tokens, ['tok1', 'tok2']);
  assert.equal(adapter.actorId, 'visitor-2');
  assert.deepEqual(sockets[1]?.sent[0], { kind: 'subscribe', actorId: 'visitor-2' });
  adapter.stop();
  await wait(20);
  assert.equal(logins, 2);
});

test('login asks for an agent resident with a stable agentId derived from its name', async () => {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ accepted: true, token: 't', actorId: 'agent-hiero-main' }), { status: 200 });
  }) as typeof fetch;
  await loginSnowdome('http://x/api/login', 'hiero main', '🙂', fetchImpl);
  assert.deepEqual(body, { name: 'hiero main', kind: 'agent', agentId: 'hiero-main', baselineEmote: '🙂' });
});

test('a login uses the emoji chosen just before it, and a non-emoji choice never reaches Snowdome', async () => {
  const sent: string[] = [];
  const login = async (_url: string, _name: string, baselineEmote: string) => {
    sent.push(baselineEmote);
    return { token: 't', actorId: 'agent-hiero' };
  };
  const socket = new FakeSocket();
  const adapter = new SnowdomeAdapter({ name: 'hiero', chooseBaselineEmote: () => '🙂', login, connect: async () => socket, onObservation: () => ({ intents: [] }) });
  await adapter.start();
  assert.deepEqual(sent, ['🙂']);
  adapter.stop();
  const rejected: string[] = [];
  const badLogin = async (_url: string, _name: string, baselineEmote: string) => {
    rejected.push(baselineEmote);
    return { token: 't', actorId: 'agent-hiero' };
  };
  const bad = new SnowdomeAdapter({ name: 'hiero', chooseBaselineEmote: () => 'not-emoji', login: badLogin, connect: async () => new FakeSocket(), onObservation: () => ({ intents: [] }) });
  await assert.rejects(() => bad.start(), /单个 emoji/);
  bad.stop();
  assert.deepEqual(rejected, []);
  assert.equal(isSingleEmoji('😀'), true);
  assert.equal(isSingleEmoji('👍🏽'), true);
  assert.equal(isSingleEmoji('hi'), false);
  assert.equal(isSingleEmoji('😀😀'), false);
  assert.equal(isSingleEmoji(''), false);
});

test('observations arriving while a decision is in flight do not stack driver calls', async () => {
  const socket = new FakeSocket();
  let calls = 0;
  let release: () => void = () => {};
  const adapter = new SnowdomeAdapter({ chooseBaselineEmote: () => '🙂',
    fetch: fakeRecentFetch,
    name: 'hiero',
    connect: async () => socket,
    login: fakeLogin,
    onObservation: () => {
      calls += 1;
      return new Promise((resolve) => { release = () => resolve({ intents: [] }); });
    },
  });
  await adapter.start();
  socket.emit(heardObservation);
  socket.emit(heardObservation);
  socket.emit(heardObservation);
  await wait(5);
  assert.equal(calls, 1);
  release();
  await wait(5);
  adapter.stop();
});

test('a speaker re-triggers a plan at most once per gap, and own echoes never trigger one', async () => {
  const socket = new FakeSocket();
  let calls = 0;
  const adapter = new SnowdomeAdapter({ chooseBaselineEmote: () => '🙂',
    fetch: fakeRecentFetch,
    name: 'hiero',
    connect: async () => socket,
    login: fakeLogin,
    onObservation: () => { calls += 1; return { intents: [] }; },
  });
  await adapter.start();
  const echo = { ...observation, heard: [{ speakerId: 'visitor-1', mode: 'talk', text: '你好' }] };
  socket.emit(echo);
  await wait(5);
  const baseline = calls;
  socket.emit(echo);
  await wait(5);
  assert.equal(calls, baseline);
  const residentHeard = { ...observation, heard: [{ speakerId: 'agent-alice', mode: 'talk', text: '你从哪里来？' }] };
  const beforeResident = calls;
  socket.emit(residentHeard);
  await wait(5);
  socket.emit(residentHeard);
  await wait(5);
  assert.equal(calls, beforeResident + 1);
  adapter.stop();
});

test('a visitor who keeps talking always gets a plan, even inside the resident gap', async () => {
  const socket = new FakeSocket();
  let calls = 0;
  const adapter = new SnowdomeAdapter({ chooseBaselineEmote: () => '🙂',
    fetch: fakeRecentFetch,
    name: 'hiero',
    connect: async () => socket,
    login: fakeLogin,
    onObservation: () => { calls += 1; return { intents: [] }; },
  });
  await adapter.start();
  const visitorHeard = { ...observation, heard: [{ speakerId: 'visitor-81340826', mode: 'talk', text: '你好你好' }] };
  socket.emit(visitorHeard);
  await wait(5);
  const baseline = calls;
  socket.emit(visitorHeard);
  await wait(5);
  assert.equal(calls, baseline + 1);
  adapter.stop();
});

test('onDayStart fires once per new game day, from day_index', async () => {
  const socket = new FakeSocket();
  const days: number[] = [];
  const adapter = new SnowdomeAdapter({ chooseBaselineEmote: () => '🙂', fetch: fakeRecentFetch, name: 'hiero', connect: async () => socket, login: fakeLogin, onObservation: () => ({ intents: [] }), onDayStart: (day) => { days.push(day); } });
  await adapter.start();
  socket.emit({ ...observation, day_index: 3, phase: 'day' });
  socket.emit({ ...observation, day_index: 3, phase: 'dusk' });
  socket.emit({ ...observation, day_index: 4, day_start: 4, phase: 'dawn' });
  socket.emit({ ...observation, day_index: 4, phase: 'day' });
  await wait(10);
  assert.deepEqual(days, [3, 4]);
  adapter.stop();
});

test('onObservation intents are validated and sent; illegal ones are dropped', async () => {
  const socket = new FakeSocket();
  const errors: string[] = [];
  const adapter = new SnowdomeAdapter({ chooseBaselineEmote: () => '🙂',
    fetch: fakeRecentFetch,
    name: 'hiero',
    connect: async () => socket,
    login: fakeLogin,
    onError: (m) => errors.push(m),
    onObservation: () => ({ intents: [{ kind: 'speak', actorId: '', mode: 'talk', text: '早上好' }] }),
  });
  await adapter.start();
  socket.emit(heardObservation);
  await wait(10);
  assert.deepEqual(socket.sent.at(-1), { kind: 'speak', actorId: 'visitor-1', mode: 'talk', text: '早上好' });
  assert.equal(errors.length, 0);
  adapter.stop();
});

test('an illegal driver intent is rejected and reported', async () => {
  const socket = new FakeSocket();
  const errors: string[] = [];
  const adapter = new SnowdomeAdapter({ chooseBaselineEmote: () => '🙂',
    fetch: fakeRecentFetch,
    name: 'hiero',
    connect: async () => socket,
    login: fakeLogin,
    onError: (m) => errors.push(m),
    onObservation: () => ({ intents: [{ kind: 'place', block: 'stone' } as unknown as { kind: 'move'; actorId: string; target: { x: number; y: number; z: number } }] }),
  });
  await adapter.start();
  const before = socket.sent.length;
  socket.emit(heardObservation);
  await wait(10);
  assert.equal(socket.sent.length, before);
  assert.equal(errors.length, 1);
  adapter.stop();
});

test('a rate_limited receipt pauses driver intents for cooldown_ms', async () => {
  class LimitedSocket extends FakeSocket {
    override send(data: string): void {
      const message = JSON.parse(data) as Record<string, unknown>;
      this.sent.push(message);
      const reason = message.kind === 'subscribe' || message.kind === 'login' ? 'ok' : 'rate_limited';
      this.emit({ accepted: reason === 'ok', reason_code: reason, state_delta: {}, cooldown_ms: 5000 } as never);
    }
  }
  const socket = new LimitedSocket();
  const adapter = new SnowdomeAdapter({ chooseBaselineEmote: () => '🙂',
    fetch: fakeRecentFetch,
    name: 'hiero',
    connect: async () => socket,
    login: fakeLogin,
    onObservation: () => ({ intents: [{ kind: 'speak', actorId: '', mode: 'talk', text: '第一句' }, { kind: 'speak', actorId: '', mode: 'talk', text: '第二句' }] }),
  });
  await adapter.start();
  const before = socket.sent.length;
  socket.emit(heardObservation);
  await wait(10);
  socket.emit(heardObservation);
  await wait(10);
  assert.equal(socket.sent.length - before, 1);
  adapter.stop();
});

test('a driver notice is forwarded to onNotice only when non-empty', async () => {
  const socket = new FakeSocket();
  const notices: string[] = [];
  let calls = 0;
  const adapter = new SnowdomeAdapter({ chooseBaselineEmote: () => '🙂',
    fetch: fakeRecentFetch,
    name: 'hiero',
    connect: async () => socket,
    login: fakeLogin,
    onObservation: () => {
      calls += 1;
      return calls === 1 ? { intents: [], notice: '遇到了新朋友' } : { intents: [], notice: '' };
    },
    onNotice: (notice) => notices.push(notice),
  });
  await adapter.start();
  socket.emit(heardObservation);
  await wait(10);
  socket.emit(heardObservation);
  await wait(10);
  assert.deepEqual(notices, ['遇到了新朋友']);
  adapter.stop();
});

test('proactive notices are spaced at least a minute apart and never repeat back-to-back', async () => {
  const socket = new FakeSocket();
  const notices: string[] = [];
  const texts = ['第一条', '第一条', '第二条'];
  let calls = 0;
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const adapter = new SnowdomeAdapter({ chooseBaselineEmote: () => '🙂',
    fetch: fakeRecentFetch,
      name: 'hiero',
      connect: async () => socket,
      login: fakeLogin,
      onObservation: () => ({ intents: [], notice: texts[calls++] ?? '' }),
      onNotice: (notice) => notices.push(notice),
    });
    await adapter.start();
    const feed = async () => {
      socket.emit(heardObservation);
      await wait(10);
    };
    await feed();
    now += 10_000;
    await feed();
    now += 120_000;
    await feed();
    assert.deepEqual(notices, ['第一条', '第二条']);
    adapter.stop();
  } finally {
    Date.now = realNow;
  }
});

test('history endpoint is derived from the login URL and clamps since and limit', async () => {
  assert.equal(historyUrlFor('http://localhost:3000/api/login'), 'http://localhost:3000/api/agent/history');
  assert.throws(() => historyUrlFor('http://localhost:3000/login'));
  const calls: string[] = [];
  const fakeFetch = (async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ events: [{ seq: 7, type: 'speak' }] }), { status: 200 });
  }) as typeof fetch;
  const events = await fetchSnowdomeHistory('http://localhost:3000/api/agent/history', 'tok', { since: -5, limit: 5000 }, fakeFetch);
  assert.deepEqual(events, [{ seq: 7, type: 'speak' }]);
  assert.equal(calls[0], 'http://localhost:3000/api/agent/history?token=tok&since=0&limit=1000');
});

test('hot-plug enables and disables a Snowdome adapter, closing its socket on disable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hiero-snowdome-'));
  const mcp = new McpToolClient();
  const registry = new HotPlugRegistry(mcp, root);
  const socket = new FakeSocket();
  registry.defineAdapter('snowdome', () => snowdomeAdapterPlug({ chooseBaselineEmote: () => '🙂', name: 'hiero', connect: async () => socket, login: fakeLogin, onObservation: () => ({ intents: [] }) }));

  try {
    const enabled = await registry.enableAdapter('snowdome');
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.error, undefined);
    assert.deepEqual(socket.sent[0], { kind: 'subscribe', actorId: 'visitor-1' });

    await registry.disable('adapter:snowdome');
    assert.equal(socket.closed, true);
    assert.deepEqual(registry.list(), []);
  } finally {
    await registry.disposeAll();
    await mcp.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('two residents keep separate logins and sockets when enabled together', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hiero-snowdome-'));
  const mcp = new McpToolClient();
  const registry = new HotPlugRegistry(mcp, root);
  const sockets = new Map<string, FakeSocket>();
  const login = async (_url: string, name: string) => ({ token: `tok-${name}`, actorId: `visitor-${name}` });
  const connect = async (url: string) => {
    const socket = new FakeSocket();
    sockets.set(url, socket);
    return socket;
  };
  registry.defineAdapter('snowdome:alice', () => snowdomeAdapterPlug({ chooseBaselineEmote: () => '🙂', name: 'alice', login, heartbeat: async () => true, heartbeatIntervalMs: 1000, connect, onObservation: () => ({ intents: [] }) }));
  registry.defineAdapter('snowdome:bob', () => snowdomeAdapterPlug({ chooseBaselineEmote: () => '🙂', name: 'bob', login, heartbeat: async () => true, heartbeatIntervalMs: 1000, connect, onObservation: () => ({ intents: [] }) }));

  try {
    assert.equal((await registry.enableAdapter('snowdome:alice')).enabled, true);
    assert.equal((await registry.enableAdapter('snowdome:bob')).enabled, true);
    assert.equal(sockets.size, 2);
    assert.ok([...sockets.keys()].some((url) => url.includes('tok-alice')));
    assert.ok([...sockets.keys()].some((url) => url.includes('tok-bob')));

    await registry.disable('adapter:snowdome:alice');
    assert.equal(registry.status('adapter:snowdome:bob').enabled, true);
    assert.equal(registry.status('adapter:snowdome:alice').enabled, false);
  } finally {
    await registry.disposeAll();
    await mcp.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a driver that fails to load leaves the resident offline with an error, not silently on builtin', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hiero-snowdome-'));
  const mcp = new McpToolClient();
  const registry = new HotPlugRegistry(mcp, root);
  let connected = false;
  registry.defineAdapter('snowdome:ghost', () => snowdomeAdapterPlug({ chooseBaselineEmote: () => '🙂',
    name: 'ghost',
    connect: async () => { connected = true; return new FakeSocket(); },
    login: async () => { throw new Error('driver failed to load'); },
    onObservation: () => ({ intents: [] }),
  }));
  try {
    const record = await registry.enableAdapter('snowdome:ghost');
    assert.equal(connected, false);
    assert.match(record.error ?? '', /driver failed to load/);
  } finally {
    await registry.disposeAll();
    await mcp.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseSnowdomeIntent accepts one emoji for emote and rejects anything else', () => {
  assert.deepEqual(parseSnowdomeIntent({ kind: 'emote', emoji: '😀' }, 'hiero'), { kind: 'emote', actorId: 'hiero', emoji: '😀' });
  assert.deepEqual(parseSnowdomeIntent({ kind: 'emote', emoji: '👍🏽' }, 'hiero'), { kind: 'emote', actorId: 'hiero', emoji: '👍🏽' });
  assert.equal(parseSnowdomeIntent({ kind: 'emote', emoji: 'ab' }, 'hiero'), null);
  assert.equal(parseSnowdomeIntent({ kind: 'emote', emoji: '😀😀' }, 'hiero'), null);
  assert.equal(parseSnowdomeIntent({ kind: 'emote', emoji: '' }, 'hiero'), null);
});

test('parseSnowdomeIntent keeps emote kind as live, baseline, or absent, and rejects other values', () => {
  assert.deepEqual(parseSnowdomeIntent({ kind: 'emote', emoji: '😀', emoteKind: 'baseline' }, 'hiero'), { kind: 'emote', actorId: 'hiero', emoji: '😀', emoteKind: 'baseline' });
  assert.deepEqual(parseSnowdomeIntent({ kind: 'emote', emoji: '😀', emoteKind: 'live' }, 'hiero'), { kind: 'emote', actorId: 'hiero', emoji: '😀', emoteKind: 'live' });
  assert.equal(parseSnowdomeIntent({ kind: 'emote', emoji: '😀', emoteKind: 'forever' }, 'hiero'), null);
});

test('parseSnowdomeIntent keeps mood inside [-1, 1]', () => {
  assert.deepEqual(parseSnowdomeIntent({ kind: 'mood', valence: -1, arousal: 0.5 }, 'hiero'), { kind: 'mood', actorId: 'hiero', valence: -1, arousal: 0.5 });
  assert.equal(parseSnowdomeIntent({ kind: 'mood', valence: 1.01, arousal: 0 }, 'hiero'), null);
  assert.equal(parseSnowdomeIntent({ kind: 'mood', valence: 0, arousal: Number.NaN }, 'hiero'), null);
  assert.equal(parseSnowdomeIntent({ kind: 'mood', valence: 0 }, 'hiero'), null);
});

test('mood is sent only after it moves past the 0.3 threshold from the last accepted mood', async () => {
  const socket = new FakeSocket();
  const adapter = new SnowdomeAdapter({ chooseBaselineEmote: () => '🙂',
    fetch: fakeRecentFetch,
    name: 'hiero',
    url: 'ws://localhost:3000/agent',
    loginUrl: 'http://localhost:3000/api/login',
    connect: async () => socket,
    login: fakeLogin,
    onObservation: (observation) => ({ intents: observation.tick === 1
      ? [{ kind: 'mood', actorId: 'visitor-1', valence: 0.5, arousal: 0 }]
      : [{ kind: 'mood', actorId: 'visitor-1', valence: 0.6, arousal: 0.1 }, { kind: 'mood', actorId: 'visitor-1', valence: 0.9, arousal: 0 }] }),
    onError: () => {},
  });
  try {
    await adapter.start();
    socket.emit(observation);
    await wait(50);
    socket.emit({ ...observation, tick: 2, heard: [{ speakerId: 'alice', mode: 'say', text: 'hi' }] });
    await wait(1200);
    const moods = socket.sent.filter((message) => message.kind === 'mood');
    // tick 1 sends 0.5; tick 2's 0.6 is within 0.3 and is dropped; 0.9 is 0.4 away and is sent.
    assert.deepEqual(moods.map((message) => message.valence), [0.5, 0.9]);
  } finally {
    adapter.stop();
  }
});
test('recent endpoint is derived from the login URL and reads incrementally by since', async () => {
  assert.equal(recentUrlFor('http://localhost:3000/api/login'), 'http://localhost:3000/api/agent/recent');
  assert.throws(() => recentUrlFor('http://localhost:3000/login'));
  const calls: string[] = [];
  const fakeFetch = (async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ actorId: 'hiero', utterances: [{ seq: 8, kind: 'heard', speakerId: 'v1', text: 'hi' }], last_seq: 8 }), { status: 200 });
  }) as typeof fetch;
  const result = await fetchSnowdomeRecent('http://localhost:3000/api/agent/recent', 'tok', 7, fakeFetch);
  assert.deepEqual(result, { utterances: [{ seq: 8, kind: 'heard', speakerId: 'v1', text: 'hi' }], last_seq: 8 });
  assert.equal(calls[0], 'http://localhost:3000/api/agent/recent?token=tok&since=7');
});

test('recent lines read while no plan runs are delivered with the next plan', async () => {
  const socket = new FakeSocket();
  const seen: SnowdomeObservation[] = [];
  let serverLastSeq = 0;
  const fakeFetch = (async (url: string) => {
    const since = Number(new URL(String(url)).searchParams.get('since'));
    const utterances = serverLastSeq > since ? [{ seq: serverLastSeq, kind: 'heard', speakerId: 'visitor-2', text: '你好' }] : [];
    return new Response(JSON.stringify({ actorId: 'hiero', utterances, last_seq: serverLastSeq }), { status: 200 });
  }) as typeof fetch;
  const adapter = new SnowdomeAdapter({ chooseBaselineEmote: () => '🙂',
    name: 'hiero',
    url: 'ws://localhost:3000/agent',
    loginUrl: 'http://localhost:3000/api/login',
    connect: async () => socket,
    login: fakeLogin,
    fetch: fakeFetch,
    heartbeat: async () => true,
    onObservation: (observation) => { seen.push(observation); return { intents: [] }; },
    onError: () => {},
  });
  try {
    await adapter.start();
    socket.emit(observation);
    await wait(50);
    // A line arrives on an observation whose plan is not run, so the line must wait for the next plan.
    serverLastSeq = 1;
    socket.emit({ ...observation, tick: 2 });
    await wait(50);
    // A later heard line makes a plan due, and the buffered line is delivered with it.
    socket.emit({ ...observation, tick: 3, heard: [{ speakerId: 'visitor-2', mode: 'talk', text: '你好' }] });
    await wait(50);
    const delivered = seen.flatMap((item) => item.recent ?? []).map((line) => line.seq);
    assert.deepEqual(delivered, [1]);
  } finally {
    await adapter.stop();
  }
});

test('recent utterances are attached only once and the cursor resets when the gateway restarts', async () => {
  const socket = new FakeSocket();
  const sinceSeen: string[] = [];
  const seen: SnowdomeObservation[] = [];
  let serverLastSeq = 5;
  const fakeFetch = (async (url: string) => {
    const since = Number(new URL(String(url)).searchParams.get('since'));
    sinceSeen.push(String(since));
    const utterances = serverLastSeq > since ? [{ seq: serverLastSeq, kind: 'heard', speakerId: 'v1', text: 'hi' }] : [];
    return new Response(JSON.stringify({ actorId: 'hiero', utterances, last_seq: serverLastSeq }), { status: 200 });
  }) as typeof fetch;
  const adapter = new SnowdomeAdapter({ chooseBaselineEmote: () => '🙂',
    name: 'hiero',
    url: 'ws://localhost:3000/agent',
    loginUrl: 'http://localhost:3000/api/login',
    connect: async () => socket,
    login: fakeLogin,
    fetch: fakeFetch,
    heartbeat: async () => true,
    onObservation: (observation) => { seen.push(observation); return { intents: [] }; },
    onError: () => {},
  });
  try {
    await adapter.start();
    socket.emit(observation);
    await wait(50);
    socket.emit({ ...observation, tick: 2 });
    await wait(50);
    serverLastSeq = 2; // gateway restarted and its sequence began again
    socket.emit({ ...observation, tick: 3 });
    await wait(50);
    assert.deepEqual(sinceSeen, ['0', '5', '5']);
    assert.equal(seen[0]?.recent?.length, 1);
    assert.equal(seen[1]?.recent, undefined);
    assert.equal(seen[2]?.recent, undefined);
  } finally {
    adapter.stop();
  }
});

test('readSnowdomeConfig accepts a UTF-8 BOM so a BOM-prefixed snowdome.json does not break hot-plug', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snowdome-bom-'));
  try {
    const path = join(dir, 'snowdome.json');
    writeFileSync(path, '\uFEFF' + JSON.stringify({ enabled: true, residents: [] }), 'utf8');
    assert.equal(readSnowdomeConfig(path).enabled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
