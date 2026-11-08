import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { explainApproval, secondsLeft } from '../frontend/src/approval-model.js';
import { clarifyComplete, clarifyQuestions } from '../frontend/src/clarify-model.js';

test('explainApproval names the command for term_exec and marks it high risk', () => {
  const explanation = explainApproval('term_exec', { command: 'npm test' });
  assert.equal(explanation.risk, 'high');
  assert.equal(explanation.reversible, false);
  assert.match(explanation.effect, /npm test/);
});

test('explainApproval marks write_file as reversible medium risk', () => {
  const explanation = explainApproval('write_file', { path: 'src/a.ts' });
  assert.equal(explanation.risk, 'medium');
  assert.equal(explanation.reversible, true);
  assert.match(explanation.effect, /src\/a\.ts/);
});

test('explainApproval describes skill edits as medium-risk and not auto-reversible', () => {
  const save = explainApproval('skill_save', { scope: 'project', name: 'demo' });
  assert.equal(save.title, '保存技能');
  assert.equal(save.reversible, false);
  assert.equal(explainApproval('skill_delete', {}).title, '删除技能');
});

test('explainApproval falls back to a high-risk irreversible warning for unknown tools', () => {
  const explanation = explainApproval('mystery_tool', null);
  assert.equal(explanation.risk, 'high');
  assert.equal(explanation.reversible, false);
  assert.match(explanation.title, /mystery_tool/);
});

test('secondsLeft rounds up and never goes negative', () => {
  assert.equal(secondsLeft(10_500, 0), 11);
  assert.equal(secondsLeft(1_000, 5_000), 0);
});

test('clarifyQuestions asks for criteria when the goal is vague', () => {
  const keys = clarifyQuestions({ goal: '修 bug', criteria: '' }, '/work/demo').map((q) => q.key);
  assert.deepEqual(keys, ['criteria', 'writes']);
});

test('clarifyQuestions makes criteria optional for a specific goal without criteria', () => {
  const questions = clarifyQuestions({ goal: '把登录页按钮改成蓝色', criteria: '' }, '/work/demo');
  assert.equal(questions[0]?.key, 'criteria');
  assert.equal(questions[0]?.optional, true);
});

test('clarifyQuestions asks for a workspace only when none is set', () => {
  const keys = clarifyQuestions({ goal: '把登录页按钮改成蓝色', criteria: 'x' }, '').map((q) => q.key);
  assert.ok(keys.includes('workspace'));
});

test('clarifyComplete requires criteria from the card and a write choice', () => {
  const questions = clarifyQuestions({ goal: '修 bug', criteria: '' }, '/work/demo');
  assert.equal(clarifyComplete(questions, '', { allowWrites: true }, '/work/demo'), false);
  assert.equal(clarifyComplete(questions, 'npm test 通过', { allowWrites: null }, '/work/demo'), false);
  assert.equal(clarifyComplete(questions, 'npm test 通过', { allowWrites: false }, '/work/demo'), true);
});
