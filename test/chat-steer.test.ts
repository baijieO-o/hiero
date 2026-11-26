import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatSteerQueue, steerMessage } from '../src/chat-steer.js';

test('drain returns queued supplements in order and empties the queue', () => {
  const queue = new ChatSteerQueue();
  queue.push('s1', '改用 TypeScript');
  queue.push('s2', '不要改测试');
  assert.equal(queue.hasPending(), true);
  assert.deepEqual(queue.drain().map((item) => item.steer_id), ['s1', 's2']);
  assert.equal(queue.hasPending(), false);
  assert.deepEqual(queue.drain(), []);
});

test('close returns supplements that were never drained and rejects later pushes', () => {
  const queue = new ChatSteerQueue();
  queue.push('s1', '先别提交');
  const leftover = queue.close();
  assert.equal(leftover.length, 1);
  assert.equal(queue.push('s2', '太晚了'), undefined);
});

test('steerMessage numbers the supplements into one user message', () => {
  const message = steerMessage([{ steer_id: 'a', text: '第一点' }, { steer_id: 'b', text: '第二点' }]);
  assert.equal(message.role, 'user');
  assert.match(message.content, /1\. 第一点\n2\. 第二点/);
});
