import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { z } from 'zod';
import { ApprovalBroker } from '../src/approval-broker.js';
import { ToolGateway } from '../src/tool-gateway.js';

test('ApprovalBroker resolves approve and deny, ignores unknown or duplicate ids', async () => {
  const seen: string[] = [];
  const broker = new ApprovalBroker((request) => seen.push(request.approval_id));
  const first = broker.request('term_exec', 'run', {});
  const second = broker.request('term_exec', 'run', {});
  assert.equal(broker.respond('missing', true), false);
  assert.equal(broker.respond(seen[0]!, true), true);
  assert.equal(broker.respond(seen[0]!, false), false);
  assert.deepEqual(await first, { approved: true });
  assert.equal(broker.respond(seen[1]!, false), true);
  assert.deepEqual(await second, { approved: false });
  assert.equal(broker.pendingRequests().length, 0);
});

test('ApprovalBroker auto-denies after timeout', async () => {
  const broker = new ApprovalBroker(() => undefined, 5);
  assert.deepEqual(await broker.request('term_exec', 'run', {}), { approved: false });
});

test('ToolGateway waits for approver on irreversible tools and enforces denial', async () => {
  const gateway = new ToolGateway();
  let ran = 0;
  gateway.register({
    name: 'write_file', irreversible: true, inputSchema: z.object({ path: z.string() }),
    execute: async () => { ran += 1; return 'written'; },
  } as never);
  await assert.rejects(() => gateway.execute('write_file', { path: 'a' }, 'i', 'standard'), /GOV-001/);
  gateway.setApprover(async () => ({ approved: true }));
  assert.equal((await gateway.execute('write_file', { path: 'a' }, 'i', 'standard')).result, 'written');
  gateway.setApprover(async () => ({ approved: false }));
  await assert.rejects(() => gateway.execute('write_file', { path: 'a' }, 'i', 'standard'), /GOV-001/);
  assert.equal(ran, 1);
});

