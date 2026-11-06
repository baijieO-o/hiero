import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { compactionBoundary, insertDivider, KEEP_RECENT_MESSAGES, sendableMessages } from '../frontend/src/compaction.js';

type Msg = { role: string; content: string; compactedMarker?: boolean };
const msg = (content: string): Msg => ({ role: 'user', content });
const DIVIDER: Msg = { role: 'assistant', content: '', compactedMarker: true };

const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(msg);

test('first compaction keeps the last KEEP_RECENT_MESSAGES visible messages verbatim', () => {
  const upTo = compactionBoundary(seven);
  assert.equal(upTo, 1);
  const conv = { messages: insertDivider(seven, upTo, DIVIDER), compactedSummary: 'S1', compactedUpTo: upTo };
  assert.deepEqual(sendableMessages(conv).map((m) => m.content), ['b', 'c', 'd', 'e', 'f', 'g']);
});

test('the boundary matches the backend keep-recent count', () => {
  assert.equal(KEEP_RECENT_MESSAGES, 6);
  assert.equal(compactionBoundary([msg('a')]), 0);
});

test('second compaction does not count the first divider and summarizes the right range', () => {
  const first = seven;
  const upTo1 = compactionBoundary(first);
  let conv: { messages: Msg[]; compactedSummary?: string; compactedUpTo?: number } = {
    messages: insertDivider(first, upTo1, DIVIDER),
    compactedSummary: 'S1',
    compactedUpTo: upTo1,
  };
  conv = { ...conv, messages: [...conv.messages, msg('h'), msg('i')] };
  // Visible history is a..i (9 messages). The second summary covers a..c, and b..i are sent after it.
  const upTo2 = compactionBoundary(conv.messages);
  assert.equal(upTo2, 3);
  conv = { ...conv, messages: insertDivider(conv.messages, upTo2, DIVIDER), compactedSummary: 'S2', compactedUpTo: upTo2 };
  assert.deepEqual(sendableMessages(conv).map((m) => m.content), ['d', 'e', 'f', 'g', 'h', 'i']);
});

test('no compaction sends every visible message and skips dividers', () => {
  const conv = { messages: [msg('a'), DIVIDER, msg('b')] };
  assert.deepEqual(sendableMessages(conv).map((m) => m.content), ['a', 'b']);
});
