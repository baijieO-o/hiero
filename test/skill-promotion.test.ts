import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { EvidenceRecord } from '../src/contracts.js';
import { ApprovalBroker, type ApprovalRequest } from '../src/approval-broker.js';
import { buildSkillCandidate, promoteSkillWithApproval } from '../src/skill-promotion.js';

const source = { task_id: 'task-1', goal: 'Add a health endpoint', generated_at: '2026-01-01T00:00:00.000Z' };

function record(tool_name: string, success: boolean): EvidenceRecord {
  return { evidence_id: `e-${tool_name}-${success}`, intent_id: 'i', tool_name, result: {}, success, created_at: '2026-01-01T00:00:00.000Z' };
}

test('a candidate is built only from successful write steps', () => {
  const candidate = buildSkillCandidate([record('read_file', true), record('write_file', false), record('edit_file', true)], source);
  assert.ok(candidate);
  assert.deepEqual(candidate.steps, ['edit_file']);
});

test('pure read tasks produce no candidate', () => {
  assert.equal(buildSkillCandidate([record('read_file', true), record('list_dir', true)], source), undefined);
});

test('approval writes SKILL.md with provenance and the operator-chosen name', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hiero-skill-promote-'));
  try {
    const candidate = buildSkillCandidate([record('write_file', true)], source);
    assert.ok(candidate);
    const seen: ApprovalRequest[] = [];
    const broker = new ApprovalBroker((request) => {
      seen.push(request);
      broker.respond(request.approval_id, true);
    });
    const outcome = await promoteSkillWithApproval(broker, workspace, candidate);
    assert.equal(outcome.saved, true);
    assert.equal(seen[0]?.tool_name, 'skill_promote');
    const saved = await readFile(join(workspace, '.agent', 'skills', candidate.name, 'SKILL.md'), 'utf8');
    assert.match(saved, /task_id: task-1/);
    assert.match(saved, /status: approved-by-operator/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('denial leaves the workspace untouched', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hiero-skill-deny-'));
  try {
    const candidate = buildSkillCandidate([record('write_file', true)], source);
    assert.ok(candidate);
    const broker = new ApprovalBroker((request) => broker.respond(request.approval_id, false));
    const outcome = await promoteSkillWithApproval(broker, workspace, candidate);
    assert.equal(outcome.saved, false);
    await assert.rejects(readFile(join(workspace, '.agent', 'skills', candidate.name, 'SKILL.md'), 'utf8'));
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
