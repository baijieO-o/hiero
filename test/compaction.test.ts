import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { compactionBoundary, insertDivider, sendableMessages } from '../frontend/src/compaction.js';

type Msg = { role: string; content: string; compactedMarker?: boolean };
const msg = (content: string): Msg => ({ role: 'user', content });
const DIVIDER: Msg = { role: 'assistant', content: '', compactedMarker: true };

test('first compaction keeps the latest message out of the summary', () => {
  const messages = [msg('a'), msg('b'), msg('c')];
  const upTo = compactionBoundary(messages);
  const conv = { messages: insertDivider(messages, upTo, DIVIDER), compactedSummary: 'S1', compactedUpTo: upTo };
  assert.deepEqual(sendableMessages(conv, [msg('d')]).map((m) => m.content), ['c', 'd']);
});

test('second compaction does not count the first divider and summarizes the right range', () => {
  const first = [msg('a'), msg('b'), msg('c')];
  const upTo1 = compactionBoundary(first);
  let conv: { messages: Msg[]; compactedSummary?: string; compactedUpTo?: number } = {
    messages: insertDivider(first, upTo1, DIVIDER),
    compactedSummary: 'S1',
    compactedUpTo: upTo1,
  };
  conv = { ...conv, messages: [...conv.messages, msg('d'), msg('e')] };
  // Visible history is a,b,c,d,e; the summary covers a,b and sends c..e after the earlier summary.
  const upTo2 = compactionBoundary(conv.messages);
  assert.equal(upTo2, 4);
  conv = { ...conv, messages: insertDivider(conv.messages, upTo2, DIVIDER), compactedSummary: 'S2', compactedUpTo: upTo2 };
  assert.deepEqual(sendableMessages(conv).map((m) => m.content), ['e']);
});

test('no compaction sends every visible message and skips dividers', () => {
  const conv = { messages: [msg('a'), DIVIDER, msg('b')] };
  assert.deepEqual(sendableMessages(conv).map((m) => m.content), ['a', 'b']);
});
