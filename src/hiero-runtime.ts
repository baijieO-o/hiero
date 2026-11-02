import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { AgentExecutor } from './agent-executor.js';
import { AgentWorkflow } from './agent-workflow.js';
import { AgentStateMachine, AgentState } from './state-machine.js';
import { ModelGateway, OpenAICompatibleTransport, parseTokenList } from './model-gateway.js';
import { ToolGateway } from './tool-gateway.js';
import { CapabilityRouter } from './capability-router.js';
import { mcpConfigPath, readMcpConfig, saveMcpConfig, toClientConfig } from './mcp-config.js';
import type { McpServerStatus } from './mcp-client.js';
import { RuntimeWebSocketServer } from './runtime-server.js';
import type { ModelMessage, ModelResponse, ModelToolDefinition } from './model-gateway.js';
import type { TaskContract, ErrorRecord, PermissionMode } from './contracts.js';
import { z } from 'zod';
import { WriteSnapshotStore, humanModifiedWarning } from './write-snapshots.js';
import { SystemAgentClient } from './system-agent-client.js';
import { diffSnapshots, snapshotTextFiles } from './workspace-diff.js';
import { normalizeEndpoint, writeLocalEnv } from './llm-env.js';
import { checkCommandPolicy, parsePermissionMode } from './permission-policy.js';
import { ApprovalBroker } from './approval-broker.js';

export interface ModelSettingsInput {
  endpoint: string;
  model: string;
  tokens: string;
}

function isModelSettingsSave(message: unknown): message is { type: 'settings_save'; payload: ModelSettingsInput } {
  if (typeof message !== 'object' || message === null) return false;
  const candidate = message as { type?: unknown; payload?: Partial<ModelSettingsInput> };
  return candidate.type === 'settings_save' && typeof candidate.payload?.endpoint === 'string' && typeof candidate.payload?.model === 'string' && typeof candidate.payload?.tokens === 'string';
}
import { createListDirTool, createReadFileTool, createWriteFileTool } from './basic-tools.js';
import { listDirectory, pickFolder, readTextFile, runCommand } from './workspace-services.js';
import { deleteSkill, listSkills, readSkill, saveSkill, type SkillScope } from './skill-store.js';
import { appendMemory, memoryContext, readMemory, saveMemory, type MemoryScope } from './memory-store.js';
import { addDeepMemory, deepRecallContext, deleteDeepMemory, listDeepMemory, searchDeepMemory } from './deep-memory.js';
import type { ExtensionReady, SystemAgentError } from './system_agent.js';
import type { WebSocket } from 'ws';

export interface RuntimeTaskRequest {
  goal?: string;
  task?: Partial<TaskContract>;
  tools?: readonly ModelToolDefinition[];
  handoff?: { completed_steps?: string[]; decisions_and_rationale?: { decision: string; reason: string }[]; next_steps?: string[]; active_mcp_servers?: string[]; deferred_tool_subset?: string[]; mrtr_pending?: boolean; human_modified_files?: string[] };
  extension?: { github_url: string; install_root?: string };
}

export interface RuntimeChatRequest {
  type: 'chat';
  request_id: string;
  messages: { role: 'user' | 'assistant'; content: string; images?: string[] }[];
  model?: string;
  permission?: string;
  workspace?: string;
  context_mode?: string;
}

const CHAT_SYSTEM_PROMPT = 'You are Hiero, a helpful AI assistant. You can call list_dir to list the entries of a directory in the current workspace (use "." for the workspace root), and read_file to read a file in the workspace when it helps answer the user. Use write_file to create or overwrite a UTF-8 text file in the workspace when the user asks for file changes. Use memory_recall to look up long-term memory, and memory_remember to store durable facts or preferences the user states. Use memory_append only for rules that must always apply.';
const CHAT_TOOL_ROUNDS = 5;
const WRITE_FILE_TOOL_DEFINITION: ModelToolDefinition = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Create or overwrite a UTF-8 text file inside the current workspace. Paths are relative to the workspace root. Requires user approval in strict mode.',
    parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
};
const CHAT_TOOL_DEFINITIONS: ModelToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file inside the current workspace. Paths are relative to the workspace root. Fails on directories; use list_dir for those.',
      parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List the entries (files and directories) of a directory inside the current workspace. Use "." for the workspace root.',
      parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', default: '.' } } },
    },
  },
  WRITE_FILE_TOOL_DEFINITION,
  {
    type: 'function',
    function: {
      name: 'memory_recall',
      description: 'Search long-term memory (layer 2) for entries relevant to a query. Use when earlier decisions, user preferences, or project facts may matter.',
      parameters: { type: 'object', additionalProperties: false, properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_remember',
      description: 'Store one short fact, preference, or decision in long-term memory (layer 2, max 500 characters). Use scope "project" for workspace facts and "global" for user-wide preferences.',
      parameters: { type: 'object', additionalProperties: false, properties: { content: { type: 'string' }, scope: { type: 'string', enum: ['global', 'project'] }, tags: { type: 'array', items: { type: 'string' } } }, required: ['content', 'scope'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_append',
      description: 'Append a line to the always-injected memory file (layer 0 global rules or layer 1 project memory). Append only; existing content cannot be rewritten or removed.',
      parameters: { type: 'object', additionalProperties: false, properties: { content: { type: 'string' }, scope: { type: 'string', enum: ['global', 'project'] } }, required: ['content', 'scope'] },
    },
  },
];

/**
 * Maps the workspace selected in the chat UI to a directory the read tool may use.
 * Only existing directories are accepted; anything else falls back to the runtime's working directory.
 */
export function resolveChatWorkspace(workspace: string | undefined): string {
  const trimmed = workspace?.trim();
  if (!trimmed) return process.cwd();
  const candidate = isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
  let isDirectory = false;
  try {
    isDirectory = statSync(candidate).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) throw new Error(`工作区不存在或不是文件夹：${trimmed}`);
  return candidate;
}

function isChatRequest(message: unknown): message is RuntimeChatRequest {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'chat';
}

const MAX_CHAT_IMAGES = 4;
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/;

function sanitizeChatImages(images: unknown): string[] {
  if (!Array.isArray(images)) return [];
  return images.filter((item): item is string => typeof item === 'string' && IMAGE_DATA_URL.test(item)).slice(0, MAX_CHAT_IMAGES);
}

interface ApprovalResponse { type: 'approval_response'; payload: { approval_id: string; approved: boolean } }

function isApprovalResponse(message: unknown): message is ApprovalResponse {
  if (typeof message !== 'object' || message === null) return false;
  const candidate = message as { type?: unknown; payload?: { approval_id?: unknown; approved?: unknown } };
  return candidate.type === 'approval_response' && typeof candidate.payload?.approval_id === 'string' && typeof candidate.payload?.approved === 'boolean';
}

function isWriteRollbackRequest(message: unknown): boolean {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'write_rollback';
}

function isSettingsRequest(message: unknown): boolean {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'settings_get';
}

function isMcpConfigGet(message: unknown): boolean {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'mcp_config_get';
}

function isMcpConfigSave(message: unknown): message is { type: 'mcp_config_save'; payload: unknown } {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'mcp_config_save';
}

type WorkspaceRequest = { workspace?: string } & (
  | { type: 'folder_pick'; request_id: string; initialPath?: string }
  | { type: 'fs_list'; request_id: string; path?: string }
  | { type: 'fs_read'; request_id: string; path: string }
  | { type: 'term_exec'; request_id: string; command: string; cwd?: string; permission?: string }
  | { type: 'skill_list'; request_id: string }
  | { type: 'skill_read'; request_id: string; scope: SkillScope; name: string }
  | { type: 'skill_save'; request_id: string; scope: SkillScope; name: string; content: string }
  | { type: 'skill_delete'; request_id: string; scope: SkillScope; name: string }
  | { type: 'memory_read'; request_id: string; scope: MemoryScope }
  | { type: 'memory_save'; request_id: string; scope: MemoryScope; content: string }
  | { type: 'deep_memory_list'; request_id: string }
  | { type: 'deep_memory_delete'; request_id: string; scope: MemoryScope; id: string }
);

function isWorkspaceRequest(message: unknown): message is WorkspaceRequest {
  if (typeof message !== 'object' || message === null) return false;
  const type = (message as { type?: unknown }).type;
  return type === 'folder_pick' || type === 'fs_list' || type === 'fs_read' || type === 'term_exec' || type === 'skill_list' || type === 'skill_read' || type === 'skill_save' || type === 'skill_delete' || type === 'memory_read' || type === 'memory_save' || type === 'deep_memory_list' || type === 'deep_memory_delete';
}

export class HieroRuntime {
  private readonly machine = new AgentStateMachine();
  private gateway: ModelGateway;
  private readonly runtime: RuntimeWebSocketServer;
  private workflow: AgentWorkflow;
  private readonly systemAgent = new SystemAgentClient();
  private readonly capabilityRouter = new CapabilityRouter();
  private readonly approvals: ApprovalBroker;
  private readonly writeSnapshots = new WriteSnapshotStore();

  public constructor(port = 8080) {
    this.runtime = new RuntimeWebSocketServer(this.machine, port);
    this.approvals = new ApprovalBroker((request) => this.runtime.broadcast({ type: 'APPROVAL_REQUIRED', payload: request }));
    this.gateway = this.createGateway();
    this.workflow = this.createWorkflow();
    this.runtime.onMessage(async (message, client) => {
      if (isApprovalResponse(message)) this.approvals.respond(message.payload.approval_id, message.payload.approved);
      else if (isWriteRollbackRequest(message)) await this.handleWriteRollback(client);
      else if (isChatRequest(message)) await this.handleChat(message, client);
      else if (isSettingsRequest(message)) this.runtime.send({ type: 'SETTINGS', payload: this.readModelSettings() }, client);
      else if (isMcpConfigGet(message)) this.sendMcpConfig(client);
      else if (isMcpConfigSave(message)) await this.handleMcpConfigSave(message.payload, client);
      else if (isWorkspaceRequest(message)) await this.handleWorkspaceRequest(message, client);
      else if (isModelSettingsSave(message)) {
        try {
          const payload = this.saveModelSettings(message.payload);
          this.runtime.send({ type: 'SETTINGS_SAVE_RESULT', payload: { ok: true, settings: payload } }, client);
        } catch (cause) {
          this.runtime.send({ type: 'SETTINGS_SAVE_RESULT', payload: { ok: false, message: cause instanceof Error ? cause.message : String(cause) } }, client);
        }
      }
      else await this.handleMessage(message as RuntimeTaskRequest);
    });
  }

  /** Rewinds agent file writes. Files a human changed after the agent wrote them are skipped and reported as RBK-006. */
  private async handleWriteRollback(client: WebSocket): Promise<void> {
    try {
      const result = await this.writeSnapshots.rollback();
      const warning = result.skipped.length > 0 ? humanModifiedWarning(result.skipped).record : undefined;
      this.runtime.send({ type: 'ROLLBACK_RESULT', payload: { ok: true, restored: result.restored, skipped: result.skipped, warning } }, client);
    } catch (cause) {
      this.runtime.send({ type: 'ROLLBACK_RESULT', payload: { ok: false, message: cause instanceof Error ? cause.message : String(cause) } }, client);
    }
  }

  private async handleWorkspaceRequest(request: WorkspaceRequest, client: WebSocket): Promise<void> {
    const reply = (payload: Record<string, unknown>) => this.runtime.send({ type: 'WORKSPACE_RESULT', payload: { request_id: request.request_id, kind: request.type, ...payload } }, client);
    try {
      if (request.type === 'folder_pick') {
        reply({ ok: true, path: await pickFolder(request.initialPath) });
        return;
      }
      const root = resolveChatWorkspace(request.workspace);
      if (request.type === 'fs_list') reply({ ok: true, root, ...(await listDirectory(root, request.path ?? '')) });
      else if (request.type === 'fs_read') reply({ ok: true, ...(await readTextFile(root, request.path)) });
      else if (request.type === 'skill_list') reply({ ok: true, skills: await listSkills(root, { dedupe: true }) });
      else if (request.type === 'skill_read') reply({ ok: true, ...(await readSkill(root, request.scope, request.name)) });
      else if (request.type === 'skill_save') reply({ ok: true, skill: await saveSkill(root, request.scope, request.name, request.content) });
      else if (request.type === 'skill_delete') { await deleteSkill(root, request.scope, request.name); reply({ ok: true }); }
      else if (request.type === 'memory_read') reply({ ok: true, memory: await readMemory(root, request.scope) });
      else if (request.type === 'memory_save') reply({ ok: true, memory: await saveMemory(root, request.scope, request.content) });
      else if (request.type === 'deep_memory_list') reply({ ok: true, entries: await listDeepMemory(root) });
      else if (request.type === 'deep_memory_delete') { await deleteDeepMemory(root, request.scope, request.id); reply({ ok: true }); }
      else {
        const mode = parsePermissionMode(request.permission, 'standard');
        const policy = checkCommandPolicy(request.command, mode);
        if (!policy.allowed) {
          if (mode !== 'standard') throw new Error(policy.reason);
          const decision = await this.approvals.request('term_exec', `在工作区执行命令：${request.command}`, { command: request.command, cwd: request.cwd ?? '' });
          if (!decision.approved) throw new Error('操作员拒绝了该命令，或审批已超时。');
        }
        reply({ ok: true, root, ...(await runCommand(root, request.command, request.cwd ?? '')) });
      }
    } catch (cause) {
      reply({ ok: false, message: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  private createGateway(): ModelGateway {
    const tokens = parseTokenList(process.env.HIERO_LLM_TOKENS);
    if (tokens.length === 0) console.warn('[hiero] HIERO_LLM_TOKENS is empty; model calls will fail until a token is configured.');
    return new ModelGateway(new OpenAICompatibleTransport(normalizeEndpoint(process.env.HIERO_LLM_ENDPOINT ?? '')), tokens);
  }

  private requestToolApproval(toolName: string, input: unknown): Promise<{ approved: boolean }> {
    return this.approvals.request(toolName, `执行不可逆工具：${toolName}`, input);
  }

  private createWorkflow(workspacePath: string = process.cwd()): AgentWorkflow {
    const tools = new ToolGateway();
    tools.register(createWriteFileTool(workspacePath, this.writeSnapshots));
    tools.setApprover((toolName, input) => this.requestToolApproval(toolName, input));
    return new AgentWorkflow(this.machine, new AgentExecutor(this.gateway, tools, 8, this.capabilityRouter), (to, verified) => this.runtime.transition(to, verified), (document) => this.runtime.broadcast({ type: 'HANDOFF_TRIGGERED', payload: document }));
  }

  /** Returns model settings for display. API tokens are never returned, only their count. */
  public readModelSettings(): { endpoint: string; model: string; token_count: number } {
    const endpoint = process.env.HIERO_LLM_ENDPOINT ?? '';
    return {
      endpoint,
      model: process.env.HIERO_LLM_MODEL ?? 'gpt-5.6-luna',
      token_count: parseTokenList(process.env.HIERO_LLM_TOKENS).length,
    };
  }

  /**
   * Writes endpoint/model/tokens to the local .env file and applies them to the running process.
   * An empty token field keeps the existing tokens so the UI never has to echo them back.
   */
  public saveModelSettings(input: ModelSettingsInput, root = process.cwd()): { endpoint: string; model: string; token_count: number } {
    const endpoint = normalizeEndpoint(input.endpoint) || normalizeEndpoint(process.env.HIERO_LLM_ENDPOINT ?? '');
    const model = input.model.trim() || 'gpt-5.6-luna';
    const newTokens = parseTokenList(input.tokens);
    const tokens = newTokens.length > 0 ? newTokens : parseTokenList(process.env.HIERO_LLM_TOKENS);
    const values: Record<string, string> = {
      HIERO_LLM_ENDPOINT: endpoint,
      HIERO_LLM_MODEL: model,
      HIERO_LLM_TOKENS: tokens.join(','),
    };
    writeLocalEnv(values, root);
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    this.gateway = this.createGateway();
    this.workflow = this.createWorkflow();
    return this.readModelSettings();
  }

  private sendMcpConfig(client?: WebSocket, statuses?: McpServerStatus[]): void {
    const config = readMcpConfig();
    const current = statuses ?? this.capabilityRouter.mcpStatuses(config.servers.filter((server) => server.enabled).map((server) => server.name));
    this.runtime.send({ type: 'MCP_CONFIG', payload: { servers: config.servers, statuses: current, path: mcpConfigPath() } }, client);
  }

  /** Saves the MCP config, then reconnects every enabled server and reports the result per server. */
  private async handleMcpConfigSave(input: unknown, client?: WebSocket): Promise<void> {
    try {
      const saved = saveMcpConfig(input);
      const statuses = await this.capabilityRouter.reloadMcp(saved.servers.filter((server) => server.enabled).map(toClientConfig));
      this.runtime.send({ type: 'MCP_CONFIG_SAVE_RESULT', payload: { ok: true, servers: saved.servers, statuses, path: mcpConfigPath() } }, client);
    } catch (cause) {
      this.runtime.send({ type: 'MCP_CONFIG_SAVE_RESULT', payload: { ok: false, message: cause instanceof Error ? cause.message : String(cause) } }, client);
    }
  }

  /** Connects enabled MCP servers from the saved config. Runs in the background so a slow server never blocks startup. */
  public startMcpServers(): void {
    try {
      const enabled = readMcpConfig().servers.filter((server) => server.enabled).map(toClientConfig);
      if (enabled.length > 0) void this.capabilityRouter.reloadMcp(enabled);
    } catch (cause) {
      console.warn(`MCP config ignored: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  public async handleChat(request: RuntimeChatRequest, client?: WebSocket): Promise<void> {
    const model = request.model ?? process.env.HIERO_LLM_MODEL ?? 'gpt-5.6-luna';
    try {
      await this.runChat(request, model, client);
    } catch (cause) {
      const record = this.machine.toErrorRecord(cause);
      this.runtime.send({ type: 'CHAT_ERROR', payload: { request_id: request.request_id, code: record.code, message: record.message } }, client);
    }
  }

  private async runChat(request: RuntimeChatRequest, model: string, client?: WebSocket): Promise<void> {
    const workspacePath = resolveChatWorkspace(request.workspace);
    const task: TaskContract = {
      task_id: randomUUID(),
      workspace_path: workspacePath,
      model_config: { preferred_model: model, fallback_chain: [] },
      permission_mode: parsePermissionMode(request.permission, 'strict'),
      context_mode: 'ephemeral',
      acceptance_criteria: [],
      budget_envelope: { max_tokens: 4000, max_time_ms: 120_000 },
    };
    const memory = await memoryContext(workspacePath);
    const lastUser = [...request.messages].reverse().find((item) => item.role === 'user')?.content ?? '';
    const recalled = await deepRecallContext(workspacePath, lastUser);
    const memorySections = [memory ? `Memory:\n${memory}` : '', recalled ? `Relevant long-term memory:\n${recalled}` : ''].filter(Boolean);
    const systemContent = [CHAT_SYSTEM_PROMPT, ...memorySections].join('\n\n');
    const messages: ModelMessage[] = [
      { role: 'system', content: systemContent },
      ...request.messages.map((item) => {
        const images = sanitizeChatImages(item.images);
        return { role: item.role, content: item.content, ...(images.length > 0 ? { images } : {}) };
      }),
    ];
    try {
      const onDelta = (text: string) => this.runtime.send({ type: 'CHAT_DELTA', payload: { request_id: request.request_id, text } }, client);
      let response: ModelResponse | undefined;
      for (let step = 0; step < CHAT_TOOL_ROUNDS; step += 1) {
        response = await this.gateway.complete(task, { prompt: '', messages, tools: CHAT_TOOL_DEFINITIONS, onDelta });
        if (!response.tool_calls || response.tool_calls.length === 0) break;
        this.runtime.send({ type: 'CHAT_RESET', payload: { request_id: request.request_id } }, client);
        messages.push({ role: 'assistant', content: response.content, tool_calls: response.tool_calls });
        for (const call of response.tool_calls) {
          const result = await this.runChatTool(call.function.name, call.function.arguments, workspacePath, task.permission_mode);
          messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: result });
          this.runtime.send({ type: 'CHAT_TOOL', payload: { request_id: request.request_id, name: call.function.name, arguments: call.function.arguments, result } }, client);
        }
        response = undefined;
      }
      if (!response) {
        response = await this.gateway.complete(task, { prompt: '', messages, onDelta });
      }
      this.runtime.send({ type: 'CHAT_REPLY', payload: { request_id: request.request_id, content: response.content, model: response.model } }, client);
    } catch (cause) {
      const record = this.machine.toErrorRecord(cause);
      this.runtime.send({ type: 'CHAT_ERROR', payload: { request_id: request.request_id, code: record.code, message: record.message } }, client);
    }
  }

  /**
   * Chat tools run through a per-request ToolGateway so they share schema checks and the approval policy.
   * Memory writes change persistent state, so they are irreversible and need approval outside auto mode.
   */
  private createChatToolGateway(workspacePath: string): ToolGateway {
    const tools = new ToolGateway();
    tools.register(createReadFileTool(workspacePath));
    tools.register(createListDirTool(workspacePath));
    tools.register(createWriteFileTool(workspacePath, this.writeSnapshots));
    tools.register({
      name: 'memory_recall',
      inputSchema: z.object({ query: z.string().default('') }),
      effect: 'read',
      execute: async ({ query }) => {
        const hits = await searchDeepMemory(workspacePath, query);
        return { hits: hits.map(({ id, scope, content, tags, score }) => ({ id, scope, content, tags, score })) };
      },
    });
    tools.register({
      name: 'memory_remember',
      inputSchema: z.object({ scope: z.string().optional(), content: z.string().default(''), tags: z.array(z.string()).optional() }),
      irreversible: true,
      effect: 'workspace',
      execute: async (args) => {
        const entry = await addDeepMemory(workspacePath, args.scope === 'global' ? 'global' : 'project', args.content, args.tags ?? []);
        return { ok: true, id: entry.id };
      },
    });
    tools.register({
      name: 'memory_append',
      inputSchema: z.object({ scope: z.string().optional(), content: z.string().default('') }),
      irreversible: true,
      effect: 'workspace',
      execute: async (args) => {
        const record = await appendMemory(workspacePath, args.scope === 'global' ? 'global' : 'project', args.content);
        return { ok: true, length: record.content.length, limit: record.limit };
      },
    });
    tools.setApprover((toolName, input) => this.requestToolApproval(toolName, input));
    return tools;
  }

  private async runChatTool(name: string, rawArguments: string, workspacePath: string, mode: PermissionMode): Promise<string> {
    try {
      const args = JSON.parse(rawArguments) as unknown;
      const record = await this.createChatToolGateway(workspacePath).execute(name, args, randomUUID(), mode);
      return JSON.stringify(record.result);
    } catch (cause) {
      return JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  public async handleMessage(message: RuntimeTaskRequest): Promise<void> {
    if (message.extension?.github_url) {
      const result = await this.systemAgent.install(message.extension.github_url, message.extension.install_root).catch((cause): SystemAgentError => ({ type: 'ERROR', request_id: 'unknown', error: { code: 'SYS-001', level: 'blocker', message: cause instanceof Error ? cause.message : String(cause), suggestion: 'Inspect the extension repository and retry.' } }));
      if (result.type === 'ERROR') this.runtime.broadcast({ type: 'ERROR', payload: result.error as ErrorRecord });
      else this.runtime.broadcast({ type: 'EXTENSION_READY', payload: { request_id: result.request_id, plugin_path: result.plugin_path, mcp_config_path: result.mcp_config_path } });
      return;
    }
    if (!message.goal?.trim()) return;
    try {
      const task: TaskContract = {
        task_id: message.task?.task_id ?? randomUUID(),
        workspace_path: resolveChatWorkspace(message.task?.workspace_path),
        model_config: message.task?.model_config ?? { preferred_model: process.env.HIERO_LLM_MODEL ?? 'gpt-5.6-luna', fallback_chain: [] },
        permission_mode: message.task?.permission_mode ?? 'standard',
        context_mode: message.task?.context_mode ?? 'ephemeral',
        acceptance_criteria: message.task?.acceptance_criteria ?? [],
        budget_envelope: message.task?.budget_envelope ?? { max_tokens: 4000, max_time_ms: 120_000 },
      };
      await this.capabilityRouter.discoverSkills(task.workspace_path);
      if (message.handoff) {
        const document = await this.createWorkflow(task.workspace_path).handoff(task, message.goal, message.handoff);
        this.runtime.broadcast({ type: 'HANDOFF_TRIGGERED', payload: { ...document } });
        this.runtime.completeState(AgentState.Handoff);
        return;
      }
      const before = await snapshotTextFiles(task.workspace_path);
      const outcome = await this.createWorkflow(task.workspace_path).run(task, message.goal, [WRITE_FILE_TOOL_DEFINITION, ...(message.tools ?? [])]);
      if ('handoff' in outcome) {
        this.runtime.completeState(AgentState.Handoff);
        return;
      }
      const after = await snapshotTextFiles(task.workspace_path);
      for (const diff of await diffSnapshots(before, after)) this.runtime.broadcast({ type: 'FILE_DIFF', payload: diff });
      this.runtime.completeState(AgentState.Verify);
    } catch (cause) {
      this.runtime.reportError(cause);
    }
  }

  public async close(): Promise<void> { await this.runtime.close(); await this.systemAgent.close(); }
}
