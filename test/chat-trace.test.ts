import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatTrace, isToolErrorResult, summarizeForTrace } from '../src/chat-trace.js';

test('ChatTrace records steps in order and closes a step once', () => {
  const trace = new ChatTrace();
  const end = trace.begin('tool_call', 'read_file', '{"path":"a.ts"}');
  const closed = end({ ok: true, detail: 'done' });
  end({ ok: false });
  const events = trace.snapshot();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.seq, 1);
  assert.equal(events[0]?.label, 'read_file');
  assert.equal(events[0]?.ok, true);
  assert.equal(events[0]?.detail, 'done');
  assert.equal(closed.durationMs, events[0]?.durationMs);
  assert.ok((events[0]?.durationMs ?? -1) >= 0);
});

test('closeOpen fails only unfinished model and tool steps', () => {
  const trace = new ChatTrace();
  trace.begin('model_call', '模型调用 1');
  const done = trace.begin('tool_call', 'list_dir');
  done({ ok: true });
  trace.closeOpen();
  const [model, tool] = trace.snapshot();
  assert.equal(model?.ok, false);
  assert.ok(model?.durationMs !== undefined);
  assert.equal(tool?.ok, true);
});

test('mark records an instantaneous step with a sequence number', () => {
  const trace = new ChatTrace();
  trace.mark('reply', '完成回复', true);
  const [event] = trace.snapshot();
  assert.equal(event?.kind, 'reply');
  assert.equal(event?.durationMs, undefined);
});

test('isToolErrorResult detects JSON error payloads and sub-agent limits', () => {
  assert.equal(isToolErrorResult('{"error":"boom"}'), true);
  assert.equal(isToolErrorResult('{"content":"ok"}'), false);
  assert.equal(isToolErrorResult('plain text'), false);
  assert.equal(isToolErrorResult('子代理调用被限制：每轮最多 2 个'), true);
});

test('summarizeForTrace collapses whitespace and truncates', () => {
  assert.equal(summarizeForTrace('a\n\n  b'), 'a b');
  assert.equal(summarizeForTrace('x'.repeat(300), 10), 'xxxxxxxxxx…');
});
