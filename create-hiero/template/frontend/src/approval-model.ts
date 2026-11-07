export type ApprovalRisk = 'high' | 'medium';

export interface ApprovalExplanation {
  title: string;
  effect: string;
  risk: ApprovalRisk;
  reversible: boolean;
}

/** Explains in plain Chinese what a tool approval will do, so the user can decide without reading raw JSON. */
export function explainApproval(toolName: string, input: unknown): ApprovalExplanation {
  const record = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const path = typeof record.path === 'string' ? record.path : '';
  switch (toolName) {
    case 'term_exec': {
      const command = typeof record.command === 'string' ? record.command : '';
      return {
        title: '在工作区执行命令',
        effect: command ? `将运行：${command}` : '将在工作区运行一条命令',
        risk: 'high',
        reversible: false,
      };
    }
    case 'write_file':
      return {
        title: '写入文件',
        effect: path ? `将覆盖或创建：${path}（写入后可用“回滚”恢复 Hiero 改动，但手工改动会保留）` : '将覆盖或创建一个工作区文件',
        risk: 'medium',
        reversible: true,
      };
    case 'deep_memory_add':
    case 'memory_save':
    case 'memory_append':
      return {
        title: '修改长期记忆',
        effect: '内容会被保存，之后的对话可能会读取它',
        risk: 'medium',
        reversible: false,
      };
    case 'skill_save':
    case 'skill_delete':
      return {
        title: toolName === 'skill_delete' ? '删除技能' : '保存技能',
        effect: '将修改技能目录中的 SKILL.md，之后的对话可能会加载它',
        risk: 'medium',
        reversible: false,
      };
    default:
      return {
        title: `执行不可逆工具：${toolName}`,
        effect: '该操作会产生外部副作用，无法自动撤销',
        risk: 'high',
        reversible: false,
      };
  }
}

/** Remaining seconds rounded up, never below zero. */
export function secondsLeft(deadlineMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}
