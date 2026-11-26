import type { PlanStepInput } from './chat-plan.js';

/**
 * 聊天运行中的“补充信息”队列。
 *
 * 用户在模型生成或工具执行期间提交的补充，先进入这里；每次调用模型前由运行循环取出，
 * 作为 user 消息并入上下文。运行结束时仍未取出的补充会被标记为未应用，不会静默丢失。
 */
export interface SteerItem {
  steer_id: string;
  text: string;
  /** Set for a user edit of the plan. It replaces the whole plan, and `text` describes the edit for the model. */
  plan?: PlanStepInput[];
}

export type SteerStatus = 'queued' | 'applied' | 'rejected';

export class ChatSteerQueue {
  private pending: SteerItem[] = [];
  private closed = false;
  /** 入队；运行已结束时返回 undefined。steerId 由客户端生成，便于界面把乐观气泡与服务端回执对应。 */
  push(steerId: string, text: string, plan?: PlanStepInput[]): SteerItem | undefined {
    if (this.closed) return undefined;
    const item: SteerItem = plan ? { steer_id: steerId, text, plan } : { steer_id: steerId, text };
    this.pending.push(item);
    return item;
  }

  /** 取出全部待处理补充（按入队顺序）。 */
  drain(): SteerItem[] {
    const items = this.pending;
    this.pending = [];
    return items;
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  /** 关闭队列并返回仍未应用的补充，调用方应把它们标记为 rejected。 */
  close(): SteerItem[] {
    this.closed = true;
    return this.drain();
  }
}

/** Describes a user's plan edit. The whole plan is replaced, and the model should continue from it. */
function planEditText(text: string, plan: PlanStepInput[]): string {
  const steps = plan.map((step, index) => `   ${index + 1}) [${step.status}] ${step.title}`).join('\n');
  return `${text}\n   用户修改后的完整计划（请以此为准继续执行，并在后续 update_plan 中沿用这些步骤）：\n${steps}`;
}

/** 把一组补充拼成一条 user 消息。 */
export function steerMessage(items: SteerItem[]): { role: 'user'; content: string } {
  const body = items.map((item, index) => `${index + 1}. ${item.plan ? planEditText(item.text, item.plan) : item.text}`).join('\n');
  return { role: 'user', content: `[用户在执行过程中补充的信息，请据此调整后续步骤]\n${body}` };
}
