import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HieroRuntime } from '../src/hiero-runtime.js';

/** Offline model stand-in that answers every chat request with the same text. */
async function withTextModel(content: string, run: (endpoint: string, calls: () => number) => Promise<void>): Promise<void> {
  let calls = 0;
  const server: Server = createServer((req, res) => {
    req.on('data', () => undefined);
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
        return;
      }
      calls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'mock', choices: [{ message: { role: 'assistant', content } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${address.port}/v1`, () => calls);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'hiero-branch-e2e-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'user.name', 'test']);
  writeFileSync(join(root, 'seed.txt'), 'seed\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'seed']);
  return root;
}

/** Runs one goal through the runtime with the given branch width and returns the model call count. */
async function runOnce(repo: string, width: string | undefined): Promise<{ result: { status: string; summary: string } | undefined; calls: number }> {
  const previous = { endpoint: process.env.HIERO_LLM_ENDPOINT, tokens: process.env.HIERO_LLM_TOKENS, width: process.env.HIERO_BRANCH_WIDTH };
  let output: { result: { status: string; summary: string } | undefined; calls: number } = { result: undefined, calls: 0 };
  await withTextModel('branch answer', async (endpoint, calls) => {
    process.env.HIERO_LLM_ENDPOINT = endpoint;
    process.env.HIERO_LLM_TOKENS = 'test-token';
    if (width === undefined) delete process.env.HIERO_BRANCH_WIDTH; else process.env.HIERO_BRANCH_WIDTH = width;
    const runtime = new HieroRuntime(0);
    try {
      output = { result: await runtime.handleMessage({ goal: 'summarize the seed file', task: { workspace_path: repo, permission_mode: 'standard' } } as never), calls: 0 };
      output.calls = calls();
    } finally {
      await runtime.close();
      if (previous.endpoint === undefined) delete process.env.HIERO_LLM_ENDPOINT; else process.env.HIERO_LLM_ENDPOINT = previous.endpoint;
      if (previous.tokens === undefined) delete process.env.HIERO_LLM_TOKENS; else process.env.HIERO_LLM_TOKENS = previous.tokens;
      if (previous.width === undefined) delete process.env.HIERO_BRANCH_WIDTH; else process.env.HIERO_BRANCH_WIDTH = previous.width;
    }
  });
  return output;
}

test('branch retry runs candidates through the runtime, returns a result, and leaves no branches or worktrees behind', async () => {
  const repo = makeRepo();
  try {
    const headBefore = git(repo, ['rev-parse', 'HEAD']);
    const single = await runOnce(repo, undefined);
    const branched = await runOnce(repo, '2');
    // The branch path must issue more model calls than the single path, otherwise it silently fell back.
    assert.ok(branched.calls > single.calls, `branch path should call the model more (single=${single.calls}, branched=${branched.calls})`);
    assert.equal(branched.result?.status, 'completed');
    assert.equal(branched.result?.summary, 'branch answer');
    assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore, 'main branch head must be unchanged when nothing was written');
    assert.equal(git(repo, ['branch', '--list', 'hiero/branch-*']), '', 'candidate branches must be deleted');
    assert.equal(existsSync(join(repo, '.hiero', 'branches')) ? git(repo, ['worktree', 'list']).split('\n').filter((line) => line.includes('branches')).length : 0, 0, 'candidate worktrees must be removed');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
