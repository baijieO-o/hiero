/**
 * Two independent status dimensions for a task reply, so that "the operation finished" is never shown as "the result is correct".
 */
export type ExecutionStatus = 'completed' | 'failed' | 'cancelled';
export type VerificationStatus = 'not_run' | 'passed' | 'failed';

export interface TaskStatus {
  execution: ExecutionStatus;
  verification: VerificationStatus;
  /** Fixed four-line summary: 已完成 / 未完成 / 已验证 / 未验证. */
  summary: string[];
}

export interface TaskStatusInput {
  execution: ExecutionStatus;
  /** Result of the `cmd:` acceptance checks; undefined when none were run. */
  verified?: boolean | undefined;
  /** Short description of what was produced, shown on the 已完成 line. */
  produced?: string | undefined;
}

/** Builds the status pair and the fixed summary. A failed or cancelled run never reports as completed. */
export function buildTaskStatus(input: TaskStatusInput): TaskStatus {
  const verification: VerificationStatus = input.verified === undefined ? 'not_run' : input.verified ? 'passed' : 'failed';
  const finished = input.execution === 'completed';
  const summary = [
    `已完成：${finished ? input.produced ?? '回复已生成' : '无'}`,
    `未完成：${finished ? '无' : input.execution === 'cancelled' ? '已取消' : '执行失败'}`,
    `已验证：${verification === 'passed' ? '通过 cmd: 验证' : '无'}`,
    `未验证：${verification === 'passed' ? '无' : verification === 'failed' ? 'cmd: 验证未通过' : '未运行验证命令'}`,
  ];
  return { execution: input.execution, verification, summary };
}