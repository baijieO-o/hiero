import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserSessions, createBrowserActionTools, createBrowserReadTools } from '../src/browser-session.js';

test('browser open refuses private targets before launching any browser', async () => {
  const sessions = new BrowserSessions();
  await assert.rejects(sessions.open('visible', 'http://127.0.0.1:8080/'), /not allowed/);
  await assert.rejects(sessions.open('headless', 'file:///etc/passwd'), /Only http and https/);
  await sessions.close();
});

test('browser tools mark clicks and typing as irreversible while reads stay read-only', () => {
  const sessions = new BrowserSessions();
  const reads = createBrowserReadTools(sessions);
  const actions = createBrowserActionTools(sessions);
  assert.deepEqual(reads.map((tool) => tool.name), ['browser_open', 'browser_snapshot', 'browser_screenshot', 'headless_extract']);
  assert.ok(reads.every((tool) => tool.effect === 'read' && !tool.irreversible));
  assert.deepEqual(actions.map((tool) => tool.name), ['browser_click', 'browser_type']);
  assert.ok(actions.every((tool) => tool.irreversible === true));
});
