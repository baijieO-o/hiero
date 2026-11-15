import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HieroRuntime } from '../src/hiero-runtime.js';

/** Offline stand-in for the model: answers each request with the next scripted reply, or hangs when told to. */
type Script = { kind: 'text'; content: string } | { kind: 'hang' };

async function withScriptedModel(script: Script[], run: (endpoint: string) => Promise<void>): Promise<void> {
  const replies = [...script];
  const pending: ServerResponse[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
        return;
      }
      const next = replies.shift() ?? { kind: 'text', content: 'done' };
      if (next.kind === 'hang') {
        pending.push(res);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'mock', choices: [{ message: { role: 'assistant', content: next.content } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    for (const res of pending) res.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Runs a scheduled goal in a fresh workspace with the scripted model, restoring process state afterwards. */
async function runScheduled(
  script: Script[],
  options: { acceptance: string[]; wallClockMs?: number },
): Promise<{ status?: string; summary?: string }> {
  const workDir = await mkdtemp(join(tmpdir(), 'hiero-e2e-'));
  await writeFile(join(workDir, 'seed.txt'), 'seed', 'utf8');
  const previousCwd = process.cwd();
  const previousEnv = { endpoint: process.env.HIERO_LLM_ENDPOINT, tokens: process.env.HIERO_LLM_TOKENS };
  let result: { status?: string; summary?: string } | undefined;
  await withScriptedModel(script, async (endpoint) => {
    process.env.HIERO_LLM_ENDPOINT = endpoint;
    process.env.HIERO_LLM_TOKENS = 'test-token';
    process.chdir(workDir);
    const runtime = new HieroRuntime(0);
    if (options.wallClockMs !== undefined) runtime.scheduledWallClockMs = options.wallClockMs;
    try {
      result = await runtime.runScheduledTask('check the seed file', options.acceptance);
    } finally {
      await runtime.close();
      process.chdir(previousCwd);
      process.env.HIERO_LLM_ENDPOINT = previousEnv.endpoint;
      process.env.HIERO_LLM_TOKENS = previousEnv.tokens;
    }
  });
  return result ?? {};
}

test('scheduled run whose model call hangs is cut off by the wall-clock limit and recorded as failed', async () => {
  const started = Date.now();
  const result = await runScheduled([{ kind: 'hang' }], { acceptance: [], wallClockMs: 300 });
  assert.equal(result.status, 'failed');
  assert.match(result.summary ?? '', /墙钟上限/);
  assert.ok(Date.now() - started < 5_000, 'the run should end near the limit, not wait for the hung call');
});
