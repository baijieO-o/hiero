import { randomUUID } from 'node:crypto';
import { error, type EvidenceRecord, type TaskContract } from './contracts.js';
import { memoryContext } from './memory-store.js';
import { deepRecallContext } from './deep-memory.js';
import type { ModelGateway, ModelMessage, ModelResponse, ModelToolDefinition } from './model-gateway.js';
import type { ToolGateway } from './tool-gateway.js';
import { ContextManager } from './context-manager.js';
import type { CapabilityRouter } from './capability-router.js';

const searchToolsDefinition: ModelToolDefinition = { type: 'function', function: { name: 'search_tools', description: 'Find available tools by capability. Full schemas are returned only for matching tools.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } };
export interface ReActResult { response: ModelResponse; evidence: EvidenceRecord[]; messages: ModelMessage[]; }
export interface PlanResult { response: ModelResponse; tools: readonly ModelToolDefinition[]; }
export class HandoffRequiredError extends Error {
  public constructor(public readonly usedTokens: number) { super(`Context reached the handoff threshold at ${usedTokens} tokens.`); this.name = 'HandoffRequiredError'; }
}
function estimateTokenCount(text: string): number { return Math.ceil(text.length / 4); }
const MAX_REPEATED_CALLS = 3;

export class AgentExecutor {
  public constructor(private readonly modelGateway: ModelGateway, private readonly toolGateway: ToolGateway, private readonly maxTurns = 8, private readonly capabilityRouter?: CapabilityRouter, private readonly contextThreshold = 0.8) {
    if (contextThreshold <= 0 || contextThreshold > 1) throw error('CTX-003', 'blocker', 'Invalid context threshold.', 'Use a threshold in the range (0, 1].');
  }
  private assertWithinContextBudget(task: TaskContract, messages: readonly ModelMessage[], prompt: string, tools: readonly ModelToolDefinition[] = []): void {
    const serialized = `${prompt}\n${messages.map((message) => `${message.role}: ${message.content}`).join('\n')}\n${JSON.stringify(tools)}`;
    const usedTokens = estimateTokenCount(serialized);
    const contextManager = new ContextManager(task.workspace_path, this.contextThreshold);
    if (contextManager.shouldHandoff(usedTokens, task.budget_envelope.max_tokens)) throw new HandoffRequiredError(usedTokens);
  }
  public async plan(task: TaskContract, goal: string, tools: readonly ModelToolDefinition[] = []): Promise<ModelResponse> { return (await this.planWithCapabilities(task, goal, tools)).response; }
  public async planWithCapabilities(task: TaskContract, goal: string, tools: readonly ModelToolDefinition[] = []): Promise<PlanResult> {
    if (!this.capabilityRouter) {
      const prompt = `Create an execution plan for: ${goal}`;
      const memory = await memoryContext(task.workspace_path);
      const recalled = await deepRecallContext(task.workspace_path, goal);
      const memoryText = [memory ? `Memory:\n${memory}` : '', recalled ? `Relevant long-term memory:\n${recalled}` : ''].filter(Boolean).join('\n\n');
      const messages: ModelMessage[] = [...(memoryText ? [{ role: 'system' as const, content: memoryText }] : []), { role: 'user', content: goal }];
      this.assertWithinContextBudget(task, messages, prompt, tools);
      return { response: await this.modelGateway.complete(task, { prompt, messages, tools }), tools };
    }
    const metadata = this.capabilityRouter.systemPromptMetadata();
    const prompt = `Create an execution plan for: ${goal}`;
    const memory = await memoryContext(task.workspace_path);
    const recalled = await deepRecallContext(task.workspace_path, goal);
    const systemParts = [memory ? `Memory:\n${memory}` : '', recalled ? `Relevant long-term memory:\n${recalled}` : '', `Available skills (load on demand):\n${metadata}`].filter(Boolean);
    const messages: ModelMessage[] = [{ role: 'system', content: systemParts.join('\n\n') }, { role: 'user', content: goal }];
    this.assertWithinContextBudget(task, messages, prompt, [searchToolsDefinition]);
    const response = await this.modelGateway.complete(task, { prompt, messages, tools: [searchToolsDefinition, ...tools] });
    const searchCall = response.tool_calls?.find((call) => call.function.name === 'search_tools');
    if (!searchCall) return { response, tools };
    let parsed: unknown;
    try { parsed = JSON.parse(searchCall.function.arguments) as unknown; } catch { throw error('MOD-004', 'blocker', 'Unable to parse search_tools arguments.', 'Return valid JSON in the function call arguments.'); }
    const query = typeof parsed === 'object' && parsed !== null && 'query' in parsed && typeof parsed.query === 'string' ? parsed.query : '';
    if (!query) throw error('MOD-004', 'blocker', 'search_tools requires a query.', 'Provide a non-empty capability query.');
    return { response, tools: [...tools, ...await this.capabilityRouter.registerTools(this.toolGateway, query)] };
  }
  public async exec(task: TaskContract, goal: string, tools: readonly ModelToolDefinition[] = []): Promise<ReActResult> {
    const messages: ModelMessage[] = [{ role: 'user', content: goal }];
    const evidence: EvidenceRecord[] = [];
    const startedAt = Date.now();
    let lastSignature = '';
    let repeatCount = 0;
    for (let turn = 0; turn < this.maxTurns; turn += 1) {
      if (Date.now() - startedAt > task.budget_envelope.max_time_ms) {
        throw error('MOD-006', 'blocker', 'Task exceeded its time budget.', 'Narrow the goal or raise budget_envelope.max_time_ms.');
      }
      this.assertWithinContextBudget(task, messages, goal, tools);
      const response = await this.modelGateway.complete(task, { prompt: goal, messages, tools });
      if (!response.tool_calls || response.tool_calls.length === 0) return { response, evidence, messages };
      messages.push({ role: 'assistant', content: response.content });
      for (const call of response.tool_calls) {
        let args: unknown;
        try { args = JSON.parse(call.function.arguments) as unknown; } catch { throw error('MOD-004', 'blocker', `Unable to parse arguments for tool '${call.function.name}'.`, 'Return valid JSON in the function call arguments.'); }
        const signature = `${call.function.name}:${JSON.stringify(args)}`;
        repeatCount = signature === lastSignature ? repeatCount + 1 : 1;
        lastSignature = signature;
        if (repeatCount >= MAX_REPEATED_CALLS) {
          throw error('MOD-005', 'blocker', `Tool '${call.function.name}' was called ${repeatCount} times in a row with identical arguments.`, 'Change the arguments or approach instead of repeating the same call.');
        }
        const record = await this.toolGateway.execute(call.function.name, args, call.id || randomUUID(), task.permission_mode);
        evidence.push(record);
        messages.push({ role: 'tool', content: JSON.stringify(record), tool_call_id: call.id, name: call.function.name });
      }
    }
    throw error('MOD-004', 'blocker', 'Model exceeded the maximum ReAct turns.', 'Reduce tool-call loops or increase the execution limit.');
  }
}
