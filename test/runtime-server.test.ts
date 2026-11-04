import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { RuntimeWebSocketServer } from '../src/runtime-server.js';
import { AgentState, type AgentStateMachine } from '../src/state-machine.js';

test('runtime server sends a SNAPSHOT on connect and sequences broadcasts', async () => {
  const machine = { state: AgentState.Exec } as unknown as AgentStateMachine;
  const port = 18000 + Math.floor(Math.random() * 1000);
  const server = new RuntimeWebSocketServer(machine, port);
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const inbox: Record<string, unknown>[] = [];
    const waiters: ((message: Record<string, unknown>) => void)[] = [];
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter) waiter(message); else inbox.push(message);
    });
    const next = (): Promise<Record<string, unknown>> => {
      const queued = inbox.shift();
      return queued ? Promise.resolve(queued) : new Promise((resolve) => waiters.push(resolve));
    };
    const nextOfType = async (type: string): Promise<Record<string, unknown>> => {
      for (;;) {
        const message = await next();
        if (message.type === type) return message;
      }
    };
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    const snapshot = await next();
    assert.equal(snapshot.type, 'SNAPSHOT');
    assert.deepEqual(snapshot.payload, { seq: 0, node: AgentState.Exec });

    server.broadcast({ type: 'STATE_CHANGE', payload: { node: AgentState.Verify, status: 'running' } });
    const firstMessage = await next();
    assert.equal(firstMessage.type, 'STATE_CHANGE');
    assert.equal(firstMessage.seq, 1);

    server.broadcast({ type: 'REWIND_RESULT', payload: { restored: [], skipped: [] } });
    assert.equal((await next()).seq, 2);

    socket.send(JSON.stringify({ type: 'SNAPSHOT_REQUEST' }));
    const resync = await nextOfType('SNAPSHOT');
    assert.deepEqual(resync.payload, { seq: server.currentSeq, node: AgentState.Exec });

    socket.close();
  } finally {
    await server.close();
  }
});
