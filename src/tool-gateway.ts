import { randomUUID } from 'node:crypto';
import { z, type ZodType } from 'zod';
import { error, type EvidenceRecord, type PermissionMode } from './contracts.js';
import { categoryOf, DEFAULT_CATEGORY_RULES, type CategoryRules } from './tool-category-policy.js';

/**
 * Where a tool's effects land. `workspace` effects stay inside the task workspace and need approval
 * by default (the `write` category rule); `external` effects (commands, network, deletion) always need approval outside auto.
 */
export type ToolEffect = 'read' | 'workspace' | 'external';

export interface RegisteredTool<TInput, TResult, TExecutable = TInput> {
  name: string;
  inputSchema: ZodType<TInput>;
  execute(input: TExecutable): Promise<TResult> | TResult;
  irreversible?: boolean;
  effect?: ToolEffect;
  networkAccess?: boolean;
  /**
   * Optional preview for approval. Runs on the validated model input and returns what the operator sees
   * plus a builder for the executable input from the hunks they accepted. Null means nothing would change.
   */
  review?: (input: TInput) => Promise<ReviewPlan<TExecutable>> | ReviewPlan<TExecutable>;
}

export interface ReviewPlan<TExecutable> {
  /** Shown to the operator, e.g. one entry per hunk. */
  preview: unknown;
  /** Hunk ids the operator may accept or reject. */
  hunkIds: number[];
  /** Builds the executable input from the accepted hunk ids, or null when no change remains. */
  apply: (acceptedHunks: ReadonlySet<number>) => TExecutable | null;
}

/** Asks a human to approve an irreversible tool call. `accepted_hunks` limits a reviewed change to chosen hunks. */
export type ApprovalHook = (toolName: string, input: unknown) => Promise<{ approved: boolean; accepted_hunks?: number[] | undefined }>;

export class ToolGateway {
  private readonly tools = new Map<string, RegisteredTool<unknown, unknown, unknown>>();
  private approver: ApprovalHook | undefined;
  private breakpoints: ReadonlySet<string> = new Set();
  private categoryRules: CategoryRules = DEFAULT_CATEGORY_RULES;

  public setApprover(approver: ApprovalHook | undefined): void {
    this.approver = approver;
  }

  /** Per-category approval rules; `ask` pauses non-read calls for approval outside auto mode. */
  public setCategoryRules(rules: CategoryRules): void {
    this.categoryRules = rules;
  }

  /** Tools that always pause for approval outside `auto` mode, whatever their effect (human-in-the-loop breakpoints). */
  public setBreakpoints(toolNames: Iterable<string>): void {
    this.breakpoints = new Set(toolNames);
  }

  /** Removes a tool so the model never sees it and it cannot be executed. Returns false when the name is unknown. */
  public unregister(toolName: string): boolean {
    return this.tools.delete(toolName);
  }

  public registeredNames(): string[] {
    return [...this.tools.keys()];
  }

  public register<TInput, TResult, TExecutable = TInput>(tool: RegisteredTool<TInput, TResult, TExecutable>): void {
    this.tools.set(tool.name, tool as RegisteredTool<unknown, unknown, unknown>);
  }

  /** MCP tools may have arbitrary external effects, so they are treated as irreversible external tools by default. */
  public registerMcpTool(name: string, schema: ZodType<unknown>, execute: (input: unknown) => Promise<unknown> | unknown, irreversible = true): void {
    this.register({ name, inputSchema: schema, execute, irreversible, effect: 'external' });
  }

  public registerMcpClient(client: { callTool(name: string, args: unknown): Promise<unknown> }, tools: readonly { name: string; inputSchema: unknown }[]): void {
    for (const tool of tools) this.registerMcpTool(tool.name, z.unknown(), (input) => client.callTool(tool.name, input));
  }

  public async execute<TInput, TResult>(
    toolName: string,
    rawInput: unknown,
    intentId: string,
    permissionMode: PermissionMode,
  ): Promise<EvidenceRecord> {
    const tool = this.tools.get(toolName) as RegisteredTool<TInput, TResult, unknown> | undefined;
    if (!tool) throw error('GOV-001', 'blocker', `Tool '${toolName}' is not registered.`, 'Register the tool before attempting execution.');
    const parsed = tool.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw error('GOV-002', 'blocker', `Invalid parameters for tool '${toolName}'.`, 'Correct the tool arguments to match its schema.');
    }

    const categoryAsks = this.categoryRules[categoryOf(tool)] === 'ask';
    const needsApproval = tool.networkAccess === true
      || (tool.irreversible === true && (tool.effect ?? 'external') === 'external')
      || (tool.irreversible === true && permissionMode === 'strict')
      || (categoryAsks && tool.effect !== 'read')
      || this.breakpoints.has(toolName);
    const requiresApproval = needsApproval && permissionMode !== 'auto';
    const approver = this.approver;
    if (requiresApproval && !approver) {
      throw error('GOV-001', 'blocker', `Tool '${toolName}' requires approval${this.breakpoints.has(toolName) ? ' (breakpoint)' : ' for irreversible effects'}.`, 'Obtain human approval or use an allowed permission mode.');
    }

    // Tools with a review always run it, so the executable input is built the same way in every mode.
    let executable: unknown = parsed.data;
    if (tool.review) {
      const plan = await tool.review(parsed.data);
      let accepted = new Set(plan.hunkIds);
      if (requiresApproval && approver) {
        const decision = await approver(toolName, { ...parsed.data, review: plan.preview, hunk_ids: plan.hunkIds });
        if (!decision.approved) {
          throw error('GOV-001', 'blocker', `Tool '${toolName}' was denied by the operator.`, 'Choose a different approach or ask for approval again.');
        }
        accepted = new Set(decision.accepted_hunks ?? plan.hunkIds);
      }
      const next = plan.apply(accepted);
      if (next === null) {
        throw error('GOV-001', 'blocker', `Tool '${toolName}' made no change: no hunks were accepted or nothing differs.`, 'Choose a different approach or ask for approval again.');
      }
      executable = next;
    } else if (requiresApproval && approver) {
      const decision = await approver(toolName, parsed.data);
      if (!decision.approved) {
        throw error('GOV-001', 'blocker', `Tool '${toolName}' was denied by the operator.`, 'Choose a different approach or ask for approval again.');
      }
    }

    try {
      const result = await tool.execute(executable as TInput);
      return {
        evidence_id: randomUUID(),
        intent_id: intentId,
        tool_name: toolName,
        result,
        success: true,
        created_at: new Date().toISOString(),
      };
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : undefined;
      throw error('GOV-003', 'degradation', `Tool '${toolName}' failed during execution${reason ? `: ${reason}` : '.'}`, 'Inspect the tool evidence and retry if safe.', reason);
    }
  }
}

export const stringInput = z.object({ value: z.string().min(1) });
