import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ModelGateway, type ModelRequest, type ModelResponse, type ModelTransport } from '../src/model-gateway.js';
import type { TaskContract } from '../src/contracts.js';

const task: TaskContract = { task_id: 'cancel', workspace_path: '.', model_config: { preferred_model: 'mock', fallback_chain: [] }, permission_mode: 'auto', context_mode: 'ephemeral', acceptance_criteria: [], budget_envelope: { max_tokens: 100_000, max_time_ms: 60_000 } };

/** Transport that never resolves on its own and rejects with AbortError when the request signal fires. */
function hangingTransport(seenTokens: string[]): ModelTransport {
  return {
    complete: (request: ModelRequest, token: string) => {
      seenTokens.push(token);
      return new Promise<ModelResponse>((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (request.signal?.aborted) fail();
        else request.signal?.addEventListener('abort', fail, { once: true });
      });
    },
  };
}

test('user cancel rejects with MOD-007 without rotating tokens or retrying', async () => {
  const seen: string[] = [];
  const gateway = new ModelGateway(hangingTransport(seen), ['tok-a', 'tok-b']);
  const controller = new AbortController();
  const pending = gateway.complete(task, { prompt: '', messages: [{ role: 'user', content: 'hi' }], signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, /MOD-007/);
  assert.deepEqual(seen, ['tok-a'], 'a cancelled request must not fall through to the next token');
});

test('an already-aborted signal fails before any token is used', async () => {
  const seen: string[] = [];
  const gateway = new ModelGateway(hangingTransport(seen), ['tok-a']);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(gateway.complete(task, { prompt: '', signal: controller.signal }), /MOD-007|aborted/);
});
