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

test('shared browser needs the desktop shell and refuses agent actions while paused', async () => {
  const unconfigured = new BrowserSessions();
  await assert.rejects(unconfigured.open('shared', 'https://example.com/'), /共享浏览器未配置/);
  await unconfigured.close();

  const sessions = new BrowserSessions({ sharedCdpUrl: 'http://127.0.0.1:1' });
  sessions.setAgentPaused(true);
  assert.equal(sessions.isAgentPaused(), true);
  await assert.rejects(sessions.click('shared', 'button', 'Go'), /已暂停/);
  await assert.rejects(sessions.type('shared', 'textbox', 'Q', 'x'), /已暂停/);
  sessions.setAgentPaused(false);
  await sessions.close();
});
