import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildTaskStatus } from '../src/task-status.js';

test('completed reply without cmd verification never claims it is verified', () => {
  const status = buildTaskStatus({ execution: 'completed' });
  assert.equal(status.execution, 'completed');
  assert.equal(status.verification, 'not_run');
  assert.deepEqual(status.summary, ['已完成：回复已生成', '未完成：无', '已验证：无', '未验证：未运行验证命令']);
});

test('a failing cmd check keeps the run unverified even though execution completed', () => {
  const status = buildTaskStatus({ execution: 'completed', verified: false, produced: '修改了 2 个文件' });
  assert.equal(status.verification, 'failed');
  assert.equal(status.summary[0], '已完成：修改了 2 个文件');
  assert.equal(status.summary[3], '未验证：cmd: 验证未通过');
});

test('a cancelled run is reported as unfinished, not completed', () => {
  const status = buildTaskStatus({ execution: 'cancelled' });
  assert.equal(status.summary[0], '已完成：无');
  assert.equal(status.summary[1], '未完成：已取消');
});