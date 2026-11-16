import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { HotPlugRegistry } from '../src/hot-plug.js';
import { McpToolClient } from '../src/mcp-client.js';
import { SnowdomeAdapter, parseModelIntent, parseSnowdomeIntent, snowdomeAdapterPlug, type SnowdomeSocket } from '../src/snowdome-adapter.js';
import type { CompletionGateway } from '../src/model-gateway.js';
import type { TaskContract } from '../src/contracts.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const task = { task_id: 't', workspace_path: '.', model_config: { preferred_model: 'm', fallback_chain: [] } } as unknown as TaskContract;

class FakeSocket implements SnowdomeSocket {
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  private messageHandler: ((data: string) => void) | undefined;
  send(data: string): void {
    const message = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(message);
    this.emit({ accepted: true, reason_code: 'ok', state_delta: {}, cooldown_ms: 0 });
  }
  close(): void { this.closed = true; }
  onMessage(handler: (data: string) => void): void { this.messageHandler = handler; }
  onClose(): void {}
  emit(value: unknown): void { this.messageHandler?.(JSON.stringify(value)); }
}

const observation = { kind: 'observation', tick: 1, time: 0, self: { id: 'hiero', position: { x: 0, y: 0, z: 0 }, room: 0, group: 'plaza' }, nearby: [], heard: [] };

function gatewayReturning(content: string): CompletionGateway {
  return { complete: async () => ({ model: 'm', token_id: 'x', content }) };
}

test('parseSnowdomeIntent accepts only the adapter protocol intents', () => {
  assert.deepEqual(parseSnowdomeIntent({ kind: 'move', target: { x: 1, y: 0, z: 2 } }, 'hiero'), { kind: 'move', actorId: 'hiero', target: { x: 1, y: 0, z: 2 } });
  assert.deepEqual(parseSnowdomeIntent({ kind: 'speak', mode: 'talk', text: '你好' }, 'hiero'), { kind: 'speak', actorId: 'hiero', mode: 'talk', text: '你好' });
  assert.equal(parseSnowdomeIntent({ kind: 'place', block: 'stone' }, 'hiero'), null);
  assert.equal(parseSnowdomeIntent({ kind: 'move', target: { x: 1.5, y: 0, z: 0 } }, 'hiero'), null);
  assert.equal(parseSnowdomeIntent({ kind: 'speak', mode: 'yell', text: 'hi' }, 'hiero'), null);
  assert.equal(parseSnowdomeIntent({ kind: 'speak', mode: 'talk', text: '   ' }, 'hiero'), null);
});

test('parseModelIntent extracts JSON from prose and rejects non-intents', () => {
  assert.deepEqual(parseModelIntent('好的：{"kind":"leave","destination":"backyard"}', 'hiero'), { kind: 'leave', actorId: 'hiero', destination: 'backyard' });
  assert.equal(parseModelIntent('我想去公园', 'hiero'), null);
  assert.equal(parseModelIntent('{"kind":"pickup"}', 'hiero'), null);
});

test('autoBehavior sends a valid model intent and drops an illegal one', async () => {
  const socket = new FakeSocket();
  const errors: string[] = [];
  const legal = new SnowdomeAdapter({ actorId: 'hiero', autoBehavior: true, connect: async () => socket, gateway: gatewayReturning('{"kind":"move","target":{"x":2,"y":0,"z":0}}'), task, onError: (m) => errors.push(m) });
  await legal.start();
  socket.emit(observation);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(socket.sent.at(-1), { kind: 'move', actorId: 'hiero', target: { x: 2, y: 0, z: 0 } });
  legal.stop();

  const illegalSocket = new FakeSocket();
  const rejecting = new SnowdomeAdapter({ actorId: 'hiero', autoBehavior: true, connect: async () => illegalSocket, gateway: gatewayReturning('{"kind":"place","block":"stone"}'), task, onError: (m) => errors.push(m) });
  await rejecting.start();
  const before = illegalSocket.sent.length;
  illegalSocket.emit(observation);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(illegalSocket.sent.length, before);
  assert.equal(errors.length, 1);
  rejecting.stop();
});

test('hot-plug enables and disables a Snowdome adapter, closing its socket on disable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hiero-snowdome-'));
  const mcp = new McpToolClient();
  const registry = new HotPlugRegistry(mcp, root);
  const socket = new FakeSocket();
  registry.defineAdapter('snowdome', () => snowdomeAdapterPlug({ actorId: 'hiero', autoBehavior: false, connect: async () => socket, task }));

  const enabled = await registry.enableAdapter('snowdome');
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.error, undefined);
  assert.deepEqual(socket.sent[0], { kind: 'subscribe', actorId: 'hiero' });

  await registry.disable('adapter:snowdome');
  assert.equal(socket.closed, true);
  assert.deepEqual(registry.list(), []);

  await registry.disposeAll();
  await mcp.close();
  rmSync(root, { recursive: true, force: true });
});
