import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AskUserBroker } from '../src/ask-user-broker.js';

test('AskUserBroker resolves submitted and declined answers, ignores unknown or duplicate ids', async () => {
  const seen: string[] = [];
  const broker = new AskUserBroker((request) => seen.push(request.ask_id));
  const first = broker.ask('pick one', [{ key: 'choice', type: 'enum', title: 'Choice', options: [{ value: 'a', label: 'A' }] }]);
  const second = broker.ask('confirm?', [{ key: 'ok', type: 'boolean', title: 'OK' }]);
  assert.equal(broker.respond('missing', { status: 'declined' }), false);
  assert.equal(broker.respond(seen[0]!, { status: 'submitted', values: { choice: 'a' } }), true);
  assert.equal(broker.respond(seen[0]!, { status: 'declined' }), false);
  assert.deepEqual(await first, { status: 'submitted', values: { choice: 'a' } });
  assert.equal(broker.respond(seen[1]!, { status: 'declined' }), true);
  assert.deepEqual(await second, { status: 'declined' });
});

test('AskUserBroker treats a timeout as cancelled', async () => {
  const broker = new AskUserBroker(() => undefined, 5);
  assert.deepEqual(await broker.ask('wait', [{ key: 'n', type: 'number', title: 'N' }]), { status: 'cancelled' });
});
