import { AgentExecutor, HandoffRequiredError, type ReActResult } from './agent-executor.js';
import type { ModelToolDefinition } from './model-gateway.js';
import type { HandoffDocument, TaskContract } from './contracts.js';
import { AgentState, AgentStateMachine, type StateTransition } from './state-machine.js';
import { ContextManager } from './context-manager.js';
import { runVerification, type VerificationResult } from './verification.js';
import { parsePlanDag, runPlanDag, type PlanDag, type PlanTask } from './plan-dag.js';

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
export interface WorkflowOutcome extends ReActResult {
  /** Set when verification passed, so the caller can report the Verify result. */
  verification: VerificationResult;
  /** Number of Rewind→Plan retries performed before this outcome. */
  retries: number;
}

export interface WorkflowOptions {
  transition?: WorkflowTransition;
  onHandoff?: (document: HandoffDocument) => void;
  onVerification?: (result: VerificationResult) => void;
  /** Runs Verify. Defaults to running `cmd:` acceptance criteria in the workspace. */
  verify?: (task: TaskContract) => Promise<VerificationResult>;
  /** Restores file writes made by the failed attempt. Rewind is a no-op when omitted. */
  rewind?: () => Promise<void>;
  /** Maximum Rewind→Plan retries after a failed verification or execution. */
  maxRetries?: number;
  /**
   * Asks the Planner for a task DAG and runs it layer by layer. Falls back to linear Exec when the plan is not a valid DAG.
   */
  useDagPlan?: boolean;
  /** Upper bound on parallel read-only DAG tasks. */
  maxParallel?: number;
}

function tryParsePlanDag(content: string): PlanDag | undefined {
  try {
    return parsePlanDag(content);
  } catch {
    return undefined;
  }
}

export const DEFAULT_MAX_RETRIES = 2;

export class AgentWorkflow {
  private readonly transitionState: WorkflowTransition;
  private readonly options: WorkflowOptions;
  public constructor(private readonly machine: AgentStateMachine, private readonly executor: AgentExecutor, transition?: WorkflowTransition, onHandoff?: (document: HandoffDocument) => void, options: WorkflowOptions = {}) {
    this.transitionState = transition ?? ((to, verified) => this.machine.transition(to, verified));
    this.options = onHandoff && !options.onHandoff ? { ...options, onHandoff } : options;
  }

  /**
   * Runs Plan → Exec → Verify. A failed Exec or Verify rewinds file writes and replans, up to maxRetries times.
   * When retries are exhausted the task is handed off instead of failing silently.
   */
  public async run(task: TaskContract, goal: string, tools: readonly ModelToolDefinition[] = []): Promise<WorkflowOutcome | AutomaticHandoffResult> {
    const maxRetries = this.options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const verify = this.options.verify ?? ((t: TaskContract) => runVerification({ workspacePath: t.workspace_path, acceptanceCriteria: t.acceptance_criteria, permissionMode: t.permission_mode }));
    let retries = 0;
    let lastFailure = '';
    let previousFailure = '';
    for (;;) {
      try {
        const planGoal = previousFailure ? `${goal}\n\nThe previous attempt failed. Fix these problems:\n${previousFailure}` : goal;
        const planned = await this.executor.planWithCapabilities(task, planGoal, tools, { dag: this.options.useDagPlan === true });
        this.transitionState(AgentState.Exec);
        const dag = this.options.useDagPlan ? tryParsePlanDag(planned.response.content) : undefined;
        const result = dag
          ? await this.execDag(task, dag, planned.tools)
          : await this.executor.exec(task, planned.response.content || planGoal, planned.tools);
        this.transitionState(AgentState.Verify);
        const verification = await verify(task);
        this.options.onVerification?.(verification);
        if (verification.verified) return { ...result, verification, retries };
        const failed = verification.checks.filter((check) => check.status === 'failed');
        lastFailure = failed.map((check) => check.criterion).join('; ');
        previousFailure = failed.map((check) => `- ${check.criterion}\n${check.errorSummary ?? check.reason ?? ''}`).join('\n');
      } catch (cause) {
        if (cause instanceof HandoffRequiredError) {
          const document = await this.handoff(task, goal, { completed_steps: ['Context limit checked before model request.'], next_steps: ['Resume the task from the saved handoff document.'] });
          this.options.onHandoff?.(document);
          return { handoff: document, usedTokens: cause.usedTokens };
        }
        if (this.machine.state !== AgentState.Exec && this.machine.state !== AgentState.Verify) throw cause;
        lastFailure = cause instanceof Error ? cause.message : String(cause);
        previousFailure = lastFailure;
      }
      if (retries >= maxRetries) {
        const document = await this.handoff(task, goal, { completed_steps: [`Verification failed after ${retries + 1} attempt(s): ${lastFailure}`], next_steps: ['Review the failed checks and resume from the handoff checkpoint.'] });
        this.options.onHandoff?.(document);
        return { handoff: document, usedTokens: 0 };
      }
      retries += 1;
      this.transitionState(AgentState.Rewind);
      await this.options.rewind?.();
      this.transitionState(AgentState.Plan);
    }
  }
  /** Runs each DAG task through the executor, passing dependency outputs as context. Evidence is merged across tasks. */
  private async execDag(task: TaskContract, dag: PlanDag, tools: readonly ModelToolDefinition[]): Promise<ReActResult> {
    const evidence: ReActResult['evidence'] = [];
    const messages: ReActResult['messages'] = [];
    const outputText = new Map<string, string>();
    let last: ReActResult | undefined;
    await runPlanDag(dag, async (planTask: PlanTask) => {
      const upstream = planTask.depends_on.map((dep) => `${dep}: ${outputText.get(dep) ?? ''}`).join('\n');
      const goal = upstream ? `${planTask.goal}\n\nResults of prerequisite tasks:\n${upstream}` : planTask.goal;
      const result = await this.executor.exec(task, goal, tools);
      evidence.push(...result.evidence);
      messages.push(...result.messages);
      last = result;
      const text = result.response.content ?? '';
      outputText.set(planTask.id, text);
      return text;
    }, this.options.maxParallel === undefined ? {} : { maxParallel: this.options.maxParallel });
    if (!last) throw new Error('Plan DAG contained no tasks.');
    return { ...last, evidence, messages };
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
