import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { classifyFailure, summarizeErrors } from '../src/error-parser.js';
import { AgentWorkflow, type WorkflowOutcome } from '../src/agent-workflow.js';
import type { AgentExecutor, ReActResult } from '../src/agent-executor.js';
import type { TaskContract } from '../src/contracts.js';
import { AgentStateMachine } from '../src/state-machine.js';

test('extracts TypeScript compiler errors with file, line and code', () => {
  const output = [
    'src/a.ts(12,5): error TS2322: Type "string" is not assignable to type "number".',
    'src/b.ts(3,1): error TS1005: \';\' expected.',
  ].join('\n');
  const summary = summarizeErrors(output);
  assert.equal(summary.format, 'typescript');
  assert.deepEqual(summary.errors, [
    { file: 'src/a.ts', line: 12, message: 'TS2322: Type "string" is not assignable to type "number".' },
    { file: 'src/b.ts', line: 3, message: 'TS1005: \';\' expected.' },
  ]);
  assert.match(summary.text, /src\/a\.ts:12: TS2322/);
});

test('extracts the innermost frame and exception from a Python traceback', () => {
  const output = [
    'Traceback (most recent call last):',
    '  File "main.py", line 3, in <module>',
    '    run()',
    '  File "lib/core.py", line 9, in run',
    '    return 1 / 0',
    'ZeroDivisionError: division by zero',
  ].join('\n');
  const summary = summarizeErrors(output);
  assert.equal(summary.format, 'python');
  assert.deepEqual(summary.errors, [
    { file: 'lib/core.py', line: 9, message: 'ZeroDivisionError: division by zero' },
  ]);
});

test('extracts Rust errors and their --> location', () => {
  const output = [
    'error[E0308]: mismatched types',
    ' --> src/main.rs:4:5',
    '  |',
  ].join('\n');
  const summary = summarizeErrors(output);
  assert.equal(summary.format, 'rust');
  assert.deepEqual(summary.errors, [{ file: 'src/main.rs', line: 4, message: 'mismatched types' }]);
});

test('extracts GCC-style errors', () => {
  const summary = summarizeErrors('main.c:7:3: error: expected \';\' before \'}\' token');
  assert.equal(summary.format, 'gnu');
  assert.deepEqual(summary.errors, [{ file: 'main.c', line: 7, message: 'expected \';\' before \'}\' token' }]);
});

test('unrecognised output is returned raw and truncated, keeping head and tail', () => {
  const output = `START${'x'.repeat(5000)}END`;
  const summary = summarizeErrors(output);
  assert.equal(summary.format, 'raw');
  assert.equal(summary.errors.length, 0);
  assert.ok(summary.text.length < 1800);
  assert.ok(summary.text.startsWith('START'));
  assert.ok(summary.text.endsWith('END'));
  assert.match(summary.text, /truncated/);
});

test('empty output is reported explicitly', () => {
  assert.equal(summarizeErrors('   ').text, '(no output)');
});

test('a retry plans with the previous failure details in its goal', async () => {
  const seenGoals: string[] = [];
  let planCalls = 0;
  const executor = {
    planWithCapabilities: async (_task: TaskContract, goal: string) => {
      seenGoals.push(goal);
      planCalls += 1;
      return { response: { content: 'plan' }, tools: [] };
    },
    exec: async (): Promise<ReActResult> => ({ response: 'done', evidence: [], messages: [] }) as unknown as ReActResult,
  } as unknown as AgentExecutor;
  const results = [false, true];
  const workflow = new AgentWorkflow(new AgentStateMachine(), executor, undefined, undefined, {
    verify: async () => ({
      verified: results.shift() ?? true,
      checks: [{ criterion: 'cmd: npx tsc -p .', status: 'failed', errorSummary: 'src/a.ts:12: TS2322: bad type' }],
    }),
    rewind: async () => {},
  });
  const task: TaskContract = {
    task_id: 'retry-context',
    workspace_path: process.cwd(),
    model_config: { preferred_model: 'test', fallback_chain: [] },
    permission_mode: 'standard',
    context_mode: 'ephemeral',
    acceptance_criteria: [],
    budget_envelope: { max_tokens: 4000, max_time_ms: 120_000 },
  };
  const outcome = await workflow.run(task, 'add feature') as WorkflowOutcome;
  assert.equal(outcome.retries, 1);
  assert.equal(planCalls, 2);
  assert.equal(seenGoals[0], 'add feature');
  assert.match(seenGoals[1] ?? '', /previous attempt failed/);
  assert.match(seenGoals[1] ?? '', /src\/a\.ts:12: TS2322: bad type/);
});

test('classifies failed verification output into an actionable kind', () => {
  assert.equal(classifyFailure("SyntaxError: Unexpected token '}'").kind, 'syntax');
  assert.equal(classifyFailure("src/a.ts(1,1): error TS2322: Type 'string' is not assignable").kind, 'type');
  assert.equal(classifyFailure('AssertionError [ERR_ASSERTION]: Expected values to be strictly equal').kind, 'test_assertion');
  assert.equal(classifyFailure('bash: pytest: command not found').kind, 'environment');
  assert.equal(classifyFailure('still running', true).kind, 'timeout');
  assert.equal(classifyFailure('something odd').kind, 'unknown');
  assert.equal(classifyFailure('AssertionError').kind, 'test_assertion');
});



