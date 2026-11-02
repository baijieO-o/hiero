import { AgentExecutor, HandoffRequiredError, type ReActResult } from './agent-executor.js';
import type { ModelToolDefinition } from './model-gateway.js';
import type { HandoffDocument, TaskContract } from './contracts.js';
import { AgentState, AgentStateMachine, type StateTransition } from './state-machine.js';
import { ContextManager } from './context-manager.js';

export interface WorkflowTransition { (to: AgentState, verified?: boolean): StateTransition; }
export interface HandoffRequest {
  completed_steps?: string[];
  decisions_and_rationale?: { decision: string; reason: string }[];
  next_steps?: string[];
  active_mcp_servers?: string[];
  deferred_tool_subset?: string[];
  mrtr_pending?: boolean;
  human_modified_files?: string[];
}
export interface AutomaticHandoffResult { handoff: HandoffDocument; usedTokens: number; }

export class AgentWorkflow {
  private readonly transitionState: WorkflowTransition;
  public constructor(private readonly machine: AgentStateMachine, private readonly executor: AgentExecutor, transition?: WorkflowTransition, private readonly onHandoff?: (document: HandoffDocument) => void) {
    this.transitionState = transition ?? ((to, verified) => this.machine.transition(to, verified));
  }
  public async run(task: TaskContract, goal: string, tools: readonly ModelToolDefinition[] = []): Promise<ReActResult | AutomaticHandoffResult> {
    try {
      const planned = await this.executor.planWithCapabilities(task, goal, tools);
      this.transitionState(AgentState.Exec);
      const result = await this.executor.exec(task, planned.response.content || goal, planned.tools);
      this.transitionState(AgentState.Verify);
      return result;
    } catch (cause) {
      if (!(cause instanceof HandoffRequiredError)) throw cause;
      const document = await this.handoff(task, goal, { completed_steps: ['Context limit checked before model request.'], next_steps: ['Resume the task from the saved handoff document.'] });
      this.onHandoff?.(document);
      return { handoff: document, usedTokens: cause.usedTokens };
    }
  }
  public async handoff(task: TaskContract, goal: string, request: HandoffRequest = {}): Promise<HandoffDocument> {
    const document: HandoffDocument = {
      checkpoint_id: `${task.task_id}-${Date.now()}`, task_goal: goal,
      completed_steps: request.completed_steps ?? [], current_state: AgentState.Handoff,
      decisions_and_rationale: request.decisions_and_rationale ?? [], next_steps: request.next_steps ?? ['Resume from the handoff checkpoint.'],
      active_mcp_servers: request.active_mcp_servers ?? [], deferred_tool_subset: request.deferred_tool_subset ?? [],
      mrtr_pending: request.mrtr_pending ?? false, human_modified_files: request.human_modified_files ?? [],
    };
    await new ContextManager(task.workspace_path).save(document);
    if (this.machine.state !== AgentState.Handoff) this.transitionState(AgentState.Handoff);
    return document;
  }
}
