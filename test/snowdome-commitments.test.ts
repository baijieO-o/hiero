import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { assertCommitmentAccepted, fetchReputation, postCommitment, snowdomeBaseUrl } from '../src/snowdome-commitments.js';

function recordingFetch(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test('a commitment is posted to the agent route with the token and body', async () => {
  const { calls, fetchImpl } = recordingFetch({ accepted: true, reason_code: 'ok', state_delta: { commitment_id: 'c1' }, cooldown_ms: 0 });
  const receipt = await postCommitment('http://localhost:3000', 'tok/1', 'commitment', { counterparty: 'hiroe', content: '明天见' }, fetchImpl);
  const call = calls[0]!;
  assert.equal(call.url, 'http://localhost:3000/api/agent/commitment?token=tok%2F1');
  assert.equal(call.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(call.init.body)), { counterparty: 'hiroe', content: '明天见' });
  assert.equal(receipt.state_delta.commitment_id, 'c1');
});

test('a refused commitment is reported as a refusal, not a transport error', async () => {
  const { fetchImpl } = recordingFetch({ accepted: false, reason_code: 'not_counterparty', state_delta: {}, cooldown_ms: 0 }, 403);
  const receipt = await postCommitment('http://localhost:3000', 'tok', 'commitment/accept', { commitment_id: 'c1' }, fetchImpl);
  assert.throws(() => assertCommitmentAccepted(receipt), /not_counterparty/);
});

test('a server failure on a commitment call throws', async () => {
  const { fetchImpl } = recordingFetch({}, 500);
  await assert.rejects(postCommitment('http://localhost:3000', 'tok', 'commitment/report', { commitment_id: 'c1', outcome: 'fulfilled' }, fetchImpl), /500/);
});

test('reputation keeps the counts side by side and never synthesizes a score', async () => {
  const body = { id: 'hiroe', reputation: { parties_reported: { commitments: 3, fulfilled: 2, breached: 1 }, system_verified: null }, commitments: [] };
  const { calls, fetchImpl } = recordingFetch(body);
  const result = await fetchReputation('http://localhost:3000', 'hiroe', fetchImpl);
  assert.equal(calls[0]!.url, 'http://localhost:3000/api/agent/reputation?id=hiroe');
  assert.deepEqual(result.reputation.parties_reported, { commitments: 3, fulfilled: 2, breached: 1 });
  assert.equal(result.reputation.system_verified, null);
});

test('reputation lookup fails on an error status', async () => {
  const { fetchImpl } = recordingFetch({}, 404);
  await assert.rejects(fetchReputation('http://localhost:3000', 'ghost', fetchImpl), /404/);
});

test('the commitment base URL is derived only from a login URL', () => {
  assert.equal(snowdomeBaseUrl('http://localhost:3000/api/login'), 'http://localhost:3000');
  assert.throws(() => snowdomeBaseUrl('http://localhost:3000/elsewhere'), /必须以 \/api\/login 结尾/);
});
