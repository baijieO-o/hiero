import { randomUUID } from 'node:crypto';
import { z, type ZodType } from 'zod';
import { error, type EvidenceRecord, type PermissionMode } from './contracts.js';

/**
 * Where a tool's effects land. `workspace` effects stay inside the task workspace and are
 * auto-allowed in standard mode; `external` effects (commands, network, deletion) always need approval outside auto.
 */
export type ToolEffect = 'read' | 'workspace' | 'external';

export interface RegisteredTool<TInput, TResult> {
  name: string;
  inputSchema: ZodType<TInput>;
  execute(input: TInput): Promise<TResult> | TResult;
  irreversible?: boolean;
  effect?: ToolEffect;
  networkAccess?: boolean;
}

/** Asks a human to approve an irreversible tool call. Resolves true to allow the call. */
export type ApprovalHook = (toolName: string, input: unknown) => Promise<{ approved: boolean }>;

export class ToolGateway {
  private readonly tools = new Map<string, RegisteredTool<unknown, unknown>>();
  private approver: ApprovalHook | undefined;

  public setApprover(approver: ApprovalHook | undefined): void {
    this.approver = approver;
  }

  public register<TInput, TResult>(tool: RegisteredTool<TInput, TResult>): void {
    this.tools.set(tool.name, tool as RegisteredTool<unknown, unknown>);
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
    const tool = this.tools.get(toolName) as RegisteredTool<TInput, TResult> | undefined;
    if (!tool) throw error('GOV-001', 'blocker', `Tool '${toolName}' is not registered.`, 'Register the tool before attempting execution.');
    const parsed = tool.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw error('GOV-002', 'blocker', `Invalid parameters for tool '${toolName}'.`, 'Correct the tool arguments to match its schema.');
    }

    const needsApproval = tool.networkAccess === true
      || (tool.irreversible === true && (tool.effect ?? 'external') === 'external')
      || (tool.irreversible === true && permissionMode === 'strict');
    if (needsApproval && permissionMode !== 'auto') {
      if (!this.approver) {
        throw error('GOV-001', 'blocker', `Tool '${toolName}' requires approval for irreversible effects.`, 'Obtain human approval or use an allowed permission mode.');
      }
      const decision = await this.approver(toolName, parsed.data);
      if (!decision.approved) {
        throw error('GOV-001', 'blocker', `Tool '${toolName}' was denied by the operator.`, 'Choose a different approach or ask for approval again.');
      }
    }

    try {
      const result = await tool.execute(parsed.data);
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
