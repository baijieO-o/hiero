import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatModelOptions, DEFAULT_CHAT_MODEL } from '../frontend/src/model-catalog-store.js';

test('chatModelOptions 在目录为空时退回默认模型', () => {
  assert.deepEqual(chatModelOptions([], DEFAULT_CHAT_MODEL), [DEFAULT_CHAT_MODEL]);
});

test('chatModelOptions 返回整个目录', () => {
  assert.deepEqual(chatModelOptions(['a', 'b'], 'a'), ['a', 'b']);
});

test('chatModelOptions 保证当前选中值在选项中', () => {
  assert.deepEqual(chatModelOptions(['a', 'b'], 'x'), ['x', 'a', 'b']);
});
