import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { shortcutFromEvent, type KeyEventLike } from '../frontend/src/shortcut-model.js';

const press = (code: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, code, ...mods,
});

test('Ctrl+Shift letter shortcuts map to their actions', () => {
  assert.equal(shortcutFromEvent(press('KeyY', { ctrlKey: true, shiftKey: true })), 'newChat');
  assert.equal(shortcutFromEvent(press('KeyL', { ctrlKey: true, shiftKey: true })), 'focusChatInput');
  assert.equal(shortcutFromEvent(press('KeyP', { ctrlKey: true, shiftKey: true })), 'focusCommand');
  assert.equal(shortcutFromEvent(press('KeyE', { ctrlKey: true, shiftKey: true })), 'toggleRail');
  assert.equal(shortcutFromEvent(press('KeyU', { ctrlKey: true, shiftKey: true })), 'openDocs');
});

test('Ctrl+Shift+Comma opens settings', () => {
  assert.equal(shortcutFromEvent(press('Comma', { ctrlKey: true, shiftKey: true })), 'openSettings');
});

test('Meta acts as Ctrl', () => {
  assert.equal(shortcutFromEvent(press('KeyY', { metaKey: true, shiftKey: true })), 'newChat');
});

test('plain keys, missing Shift, or Alt do not trigger shortcuts', () => {
  assert.equal(shortcutFromEvent(press('KeyY')), null);
  assert.equal(shortcutFromEvent(press('KeyY', { ctrlKey: true })), null);
  assert.equal(shortcutFromEvent(press('KeyY', { ctrlKey: true, shiftKey: true, altKey: true })), null);
});

test('unbound combos return null', () => {
  assert.equal(shortcutFromEvent(press('KeyZ', { ctrlKey: true, shiftKey: true })), null);
});
