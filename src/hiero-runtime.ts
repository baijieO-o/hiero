import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { AgentExecutor } from './agent-executor.js';
import { COMPACT_SUMMARY_PREFIX, ContextCompactor } from './context-compactor.js';
import { breakdownContextUsage, type ContextUsageBreakdown } from './context-usage.js';
import { AgentWorkflow } from './agent-workflow.js';
import { AgentStateMachine, AgentState } from './state-machine.js';
import { StateStore } from './state-store.js';
import { ModelGateway, OpenAICompatibleTransport, parseTokenList } from './model-gateway.js';
import { ToolGateway } from './tool-gateway.js';
import { CapabilityRouter } from './capability-router.js';
import { mcpConfigPath, readMcpConfig, saveMcpConfig, toClientConfig } from './mcp-config.js';
import type { McpServerStatus } from './mcp-client.js';
import { RuntimeWebSocketServer, type RuntimeEvent } from './runtime-server.js';
import type { ModelMessage, ModelResponse, ModelToolDefinition } from './model-gateway.js';
import type { TaskContract, ErrorRecord, PermissionMode } from './contracts.js';
import { z } from 'zod';
import { WriteSnapshotStore, humanModifiedWarning } from './write-snapshots.js';
import { SystemAgentClient } from './system-agent-client.js';
import { diffSnapshots, snapshotTextFiles } from './workspace-diff.js';
import { modelsEndpoint, normalizeEndpoint, writeLocalEnv } from './llm-env.js';
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
import { createWebFetchTool, createWebSearchTool } from './web-tools.js';
import { LOAD_SKILL_TOOL_DEFINITION, registerLoadSkillTool } from './skill-tool.js';
import { ChatTrace, isToolErrorResult, summarizeForTrace } from './chat-trace.js';
import { appendChatTrace, listChatTraces } from './trace-store.js';
import { LONG_REPLY_THRESHOLD, saveLongReply } from './reply-store.js';
import { canDelegate, DELEGATE_READ_TOOL_DEFINITION, DELEGATE_TASK_TOOL_DEFINITION, DELEGATE_WRITE_TOOL_DEFINITION, normalizeSubagentSettings, runReadOnlySubagent, type SubagentSettings } from './read-only-subagent.js';
import { listDirectory, pickFolder, readTextFile, runCommand } from './workspace-services.js';
import { deleteSkill, listSkills, readSkill, saveSkill, type SkillScope } from './skill-store.js';
import { appendMemory, memoryContext, readMemory, saveMemory, type MemoryScope } from './memory-store.js';
import { addDeepMemory, deepRecallContext, deleteDeepMemory, listDeepMemory, searchDeepMemory, setDeepMemoryEmbedder } from './deep-memory.js';
import { createEmbedder, embeddingConfigFromEnv } from './embedding.js';
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
  /** Summary of earlier history produced by a manual or automatic compaction. Messages it covers are not sent. */
  compacted_summary?: string;
  model?: string;
  permission?: string;
  workspace?: string;
  context_mode?: string;
  /** Sub-agent preferences chosen in the settings page; normalised by the backend before use. */
  subagent?: Partial<SubagentSettings>;
}

const CHAT_SYSTEM_PROMPT = 'You are Hiero, a helpful AI assistant. You can call list_dir to list the entries of a directory in the current workspace (use "." for the workspace root), and read_file to read a file in the workspace when it helps answer the user. Use write_file to create or overwrite a UTF-8 text file in the workspace when the user asks for file changes. Use memory_recall to look up long-term memory, and memory_remember to store durable facts or preferences the user states. Use memory_append (layer 0 rules) only when the user explicitly asks you to save a rule to always-injected memory; never write it on your own initiative.';
const CHAT_TOOL_ROUNDS = 5;
/** Chat has no per-task token cap, so compaction triggers at a fixed estimated size. */
const CHAT_COMPACT_TOKENS = 24_000;

/** Rough token estimate (about 4 characters per token), matching the agent executor. */
function estimateTokens(messages: readonly ModelMessage[], tools: readonly ModelToolDefinition[]): number {
  const text = messages.map((item) => `${item.role}${item.content}`).join('') + JSON.stringify(tools);
  return Math.ceil(text.length / 4);
}
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
      name: 'web_search',
      description: 'Search the public web (Brave when configured, otherwise DuckDuckGo) and return titles, URLs, and short descriptions. Requires user approval outside auto mode. Use web_fetch to read a result in full. For Weibo hot search, web_fetch https://s.weibo.com/top/summary directly instead of searching.',
      parameters: { type: 'object', additionalProperties: false, properties: { query: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 10, default: 5 } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch a public http(s) web page and return its readable text (truncated to 20000 characters). Private, local, and credentialed URLs are refused. Requires user approval outside auto mode.',
      parameters: { type: 'object', additionalProperties: false, properties: { url: { type: 'string' } }, required: ['url'] },
    },
  },
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
      description: 'Append a line to the always-injected memory file (layer 0 global rules or layer 1 project memory). Only call this when the user explicitly asks to save a rule; never on your own initiative. Append only; existing content cannot be rewritten or removed.',
      parameters: { type: 'object', additionalProperties: false, properties: { content: { type: 'string' }, scope: { type: 'string', enum: ['global', 'project'] } }, required: ['content', 'scope'] },
    },
  },
  LOAD_SKILL_TOOL_DEFINITION,
  DELEGATE_READ_TOOL_DEFINITION,
  DELEGATE_WRITE_TOOL_DEFINITION,
  DELEGATE_TASK_TOOL_DEFINITION,
];

const READ_ONLY_SUBAGENT_TOOLS = new Set(['read_file', 'list_dir', 'memory_recall']);
const WRITE_SUBAGENT_TOOLS = new Set(['read_file', 'list_dir', 'write_file', 'memory_recall']);
const SUBAGENT_TOOL_NAMES = new Set(['delegate_read', 'delegate_write', 'delegate_task']);

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

function chatToolDefinitions(subagent: SubagentSettings): ModelToolDefinition[] {
  return subagent.enabled ? CHAT_TOOL_DEFINITIONS : CHAT_TOOL_DEFINITIONS.filter((tool) => !SUBAGENT_TOOL_NAMES.has(tool.function.name));
}

/**
 * Builds the model messages for a chat turn. When the client has compacted earlier history, the summary is placed
 * before the messages the client kept verbatim.
 */
async function buildChatMessages(workspacePath: string, history: RuntimeChatRequest['messages'], compactedSummary?: string, skillMetadata = ''): Promise<ModelMessage[]> {
  const memory = await memoryContext(workspacePath);
  const lastUser = [...history].reverse().find((item) => item.role === 'user')?.content ?? '';
  const recalled = await deepRecallContext(workspacePath, lastUser);
  const memorySections = [memory ? `Memory:\n${memory}` : '', recalled ? `Relevant long-term memory:\n${recalled}` : '', skillMetadata ? `Available skills (call load_skill to read one before following it):\n${skillMetadata}` : ''].filter(Boolean);
  const systemContent = [CHAT_SYSTEM_PROMPT, ...memorySections].join('\n\n');
  const summary = typeof compactedSummary === 'string' && compactedSummary.trim() ? [{ role: 'user' as const, content: `${COMPACT_SUMMARY_PREFIX}\n${compactedSummary.trim()}` }] : [];
  return [
    { role: 'system', content: systemContent },
    ...summary,
    ...history.map((item) => {
      const images = sanitizeChatImages(item.images);
      return { role: item.role, content: item.content, ...(images.length > 0 ? { images } : {}) };
    }),
  ];
}

function isChatRequest(message: unknown): message is RuntimeChatRequest {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'chat';
}

interface ChatTraceHistoryRequest { type: 'chat_trace_history'; workspace?: string }

function isChatTraceHistoryRequest(message: unknown): message is ChatTraceHistoryRequest {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'chat_trace_history';
}

function isTaskHistoryRequest(message: unknown): boolean {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'task_history';
}

interface ChatCancelRequest { type: 'chat_cancel'; request_id: string }

function isChatCancelRequest(message: unknown): message is ChatCancelRequest {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'chat_cancel' && typeof (message as { request_id?: unknown }).request_id === 'string';
}

interface ChatAttachRequest { type: 'chat_attach'; request_id: string }

function isChatAttachRequest(message: unknown): message is ChatAttachRequest {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'chat_attach' && typeof (message as { request_id?: unknown }).request_id === 'string';
}

/** Events for one chat request. They are kept after the client disconnects so a reconnecting client can replay them. */
interface ChatRunBuffer {
  events: string[];
  client: WebSocket | undefined;
  finished: boolean;
  finishedAt?: number;
}

/** Finished runs are kept briefly so a reload right after completion can still recover the reply. */
const CHAT_RUN_RETENTION_MS = 10 * 60_000;

function isCompletedChatEvent(type: string): boolean {
  return type === 'CHAT_REPLY' || type === 'CHAT_ERROR' || type === 'CHAT_CANCELLED';
}

interface ChatUsageRequest { type: 'chat_usage'; request_id: string; messages: RuntimeChatRequest['messages']; workspace?: string; subagent?: Partial<SubagentSettings>; compacted_summary?: string }

function isChatUsageRequest(message: unknown): message is ChatUsageRequest {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'chat_usage' && typeof (message as { request_id?: unknown }).request_id === 'string';
}

interface ChatCompactRequest { type: 'chat_compact'; request_id: string; messages: RuntimeChatRequest['messages']; workspace?: string; model?: string; compacted_summary?: string }

function isChatCompactRequest(message: unknown): message is ChatCompactRequest {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'chat_compact' && typeof (message as { request_id?: unknown }).request_id === 'string';
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

function isModelListRequest(message: unknown): message is { type: 'model_list'; request_id: string; payload?: Partial<ModelSettingsInput> } {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'model_list';
}

/**
 * Asks the OpenAI-compatible provider for its model catalog via GET {base}/models.
 * Uses the endpoint and key from the request when given, otherwise the saved ones.
 */
export async function fetchModelCatalog(endpointRaw: string, tokensRaw: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const url = modelsEndpoint(endpointRaw);
  if (!url) throw new Error('未设置 Base URL。');
  const token = parseTokenList(tokensRaw)[0];
  if (!token) throw new Error('未设置 API Key。');
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`上游返回 HTTP ${response.status}。`);
  const body = (await response.json()) as { data?: { id?: unknown }[] };
  const ids = (body.data ?? []).map((item) => item.id).filter((id): id is string => typeof id === 'string');
  return [...new Set(ids)].sort();
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
  private readonly activeChats = new Map<string, AbortController>();
  private readonly chatRuns = new Map<string, ChatRunBuffer>();
  private readonly stateStore: StateStore;
  private currentTaskId: string | undefined;

  public constructor(port = 8080, storePath?: string) {
    this.stateStore = new StateStore(storePath);
    this.stateStore.markRunningAsInterrupted();
    this.runtime = new RuntimeWebSocketServer(this.machine, port);
    this.runtime.onTransition = (transition) => this.currentTaskId && this.stateStore.recordTransition(this.currentTaskId, transition.from, transition.to);
    this.approvals = new ApprovalBroker((request) => this.runtime.broadcast({ type: 'APPROVAL_REQUIRED', payload: request }));
    this.gateway = this.createGateway();
    this.workflow = this.createWorkflow();
    this.runtime.onMessage(async (message, client) => {
      if (isApprovalResponse(message)) this.approvals.respond(message.payload.approval_id, message.payload.approved);
      else if (isWriteRollbackRequest(message)) await this.handleWriteRollback(client);
      else if (isChatRequest(message)) await this.handleChat(message, client);
      else if (isChatCancelRequest(message)) this.cancelChat(message.request_id, client);
      else if (isChatAttachRequest(message)) this.attachChat(message.request_id, client);
      else if (isChatUsageRequest(message)) await this.handleChatUsage(message, client);
      else if (isChatCompactRequest(message)) await this.handleChatCompact(message, client);
      else if (isTaskHistoryRequest(message)) this.runtime.send({ type: 'TASK_HISTORY', payload: { tasks: this.stateStore.listTasks() } }, client);
      else if (isChatTraceHistoryRequest(message)) this.runtime.send({ type: 'CHAT_TRACE_HISTORY', payload: { workspace: resolveChatWorkspace(message.workspace), traces: await listChatTraces(resolveChatWorkspace(message.workspace)) } }, client);
      else if (isSettingsRequest(message)) this.runtime.send({ type: 'SETTINGS', payload: this.readModelSettings() }, client);
      else if (isModelListRequest(message)) await this.handleModelList(message, client);
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
      else if (request.type === 'skill_save') {
        await this.requireSkillApproval('skill_save', `保存技能：${request.scope}/${request.name}`, request);
        reply({ ok: true, skill: await saveSkill(root, request.scope, request.name, request.content) });
      } else if (request.type === 'skill_delete') {
        await this.requireSkillApproval('skill_delete', `删除技能：${request.scope}/${request.name}`, request);
        await deleteSkill(root, request.scope, request.name);
        reply({ ok: true });
      }
      else if (request.type === 'memory_read') reply({ ok: true, memory: await readMemory(root, request.scope) });
      else if (request.type === 'memory_save') reply({ ok: true, memory: await saveMemory(root, request.scope, request.content) });
      else if (request.type === 'deep_memory_list') reply({ ok: true, entries: (await listDeepMemory(root)).map(({ embedding: _vector, ...entry }) => entry) });
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
    if (tokens.length === 0) console.info('[hiero] HIERO_LLM_TOKENS is empty; using unauthenticated OpenAI-compatible endpoint (suitable for local Ollama/vLLM).');
    const embeddingConfig = embeddingConfigFromEnv();
    setDeepMemoryEmbedder(embeddingConfig ? createEmbedder(embeddingConfig) : undefined);
    const maxTokens = Number.parseInt(process.env.HIERO_LLM_MAX_TOKENS ?? '', 10);
    return new ModelGateway(new OpenAICompatibleTransport(normalizeEndpoint(process.env.HIERO_LLM_ENDPOINT ?? ''), undefined, Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : undefined), tokens);
  }

  /** Summarizes older history with HIERO_COMPACT_MODEL (a cheap or local model) when set, otherwise the main model. */
  private createCompactor(keepRecent = 6): ContextCompactor {
    const compactModel = process.env.HIERO_COMPACT_MODEL || undefined;
    return new ContextCompactor(async (task, transcript) => {
      const summaryTask: TaskContract = { ...task, model_config: { preferred_model: compactModel ?? task.model_config.preferred_model, fallback_chain: [] } };
      const response = await this.gateway.complete(summaryTask, { prompt: transcript });
      return response.content;
    }, keepRecent);
  }

  /** Replies with the provider's model IDs. Errors are returned as text so the form can show them. */
  private async handleModelList(request: { request_id: string; payload?: Partial<ModelSettingsInput> }, client: WebSocket | undefined): Promise<void> {
    const endpoint = request.payload?.endpoint || process.env.HIERO_LLM_ENDPOINT || '';
    const tokens = request.payload?.tokens || process.env.HIERO_LLM_TOKENS || '';
    try {
      const models = await fetchModelCatalog(endpoint, tokens);
      this.runtime.send({ type: 'MODEL_LIST', payload: { request_id: request.request_id, models } }, client);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      this.runtime.send({ type: 'MODEL_LIST', payload: { request_id: request.request_id, models: [], error: message } }, client);
    }
  }

  private async handleChatUsage(request: ChatUsageRequest, client: WebSocket | undefined): Promise<void> {
   const workspacePath = resolveChatWorkspace(request.workspace);
   const subagent = normalizeSubagentSettings(request.subagent);
   const tools = chatToolDefinitions(subagent);
   const messages = await buildChatMessages(workspacePath, request.messages, request.compacted_summary);
   this.runtime.send({ type: 'CHAT_USAGE', payload: { request_id: request.request_id, usage: breakdownContextUsage(messages, tools) } }, client);
  }

  /** Summarizes older history on demand. The client keeps the returned summary and drops the messages it covers. */
  private async handleChatCompact(request: ChatCompactRequest, client: WebSocket | undefined): Promise<void> {
   const workspacePath = resolveChatWorkspace(request.workspace);
   const model = request.model ?? process.env.HIERO_LLM_MODEL ?? 'gpt-5.6-luna';
   const task: TaskContract = {
     task_id: randomUUID(),
     workspace_path: workspacePath,
     model_config: { preferred_model: model, fallback_chain: [] },
     permission_mode: 'standard',
     context_mode: 'ephemeral',
     acceptance_criteria: [],
     budget_envelope: { max_tokens: 4000, max_time_ms: 120_000 },
   };
   try {
     const tools = chatToolDefinitions(normalizeSubagentSettings(undefined));
     const messages = await buildChatMessages(workspacePath, request.messages, request.compacted_summary);
     const beforeTokens = estimateTokens(messages, tools);
     const compacted = await this.createCompactor(1).compact(task, messages);
     const summaryMessage = compacted[1];
     if (compacted.length === messages.length || summaryMessage?.role !== 'user' || !summaryMessage.content.startsWith(COMPACT_SUMMARY_PREFIX)) {
       throw new Error('历史太短，没有可压缩的内容。');
     }
     const summary = summaryMessage.content.slice(COMPACT_SUMMARY_PREFIX.length).trim();
     this.runtime.send({
       type: 'CHAT_COMPACTED',
       payload: { request_id: request.request_id, summary, before_tokens: beforeTokens, after_tokens: estimateTokens(compacted, tools), kept_messages: compacted.length - 2 },
     }, client);
   } catch (cause) {
     this.runtime.send({ type: 'CHAT_COMPACTED', payload: { request_id: request.request_id, ok: false, message: cause instanceof Error ? cause.message : String(cause) } }, client);
   }
  }

  private requestToolApproval(toolName: string, input: unknown): Promise<{ approved: boolean }> {
    return this.approvals.request(toolName, `执行不可逆工具：${toolName}`, input);
  }

  /** Skill edits always need the operator's approval, even in auto mode. */
  private async requireSkillApproval(toolName: string, summary: string, input: unknown): Promise<void> {
    const decision = await this.approvals.request(toolName, summary, input);
    if (!decision.approved) throw new Error('操作员拒绝了该技能修改，或审批已超时。');
  }

  private createWorkflow(workspacePath: string = process.cwd()): AgentWorkflow {
    const tools = new ToolGateway();
    tools.register(createWriteFileTool(workspacePath, this.writeSnapshots));
    tools.setApprover((toolName, input) => this.requestToolApproval(toolName, input));
    return new AgentWorkflow(this.machine, new AgentExecutor(this.gateway, tools, 8, this.capabilityRouter, 0.8, this.createCompactor()), (to, verified) => this.runtime.transition(to, verified), (document) => this.runtime.broadcast({ type: 'HANDOFF_TRIGGERED', payload: document }), {
      useDagPlan: true,
      onVerification: (result) => this.runtime.broadcast({ type: 'VERIFY_RESULT', payload: result }),
      rewind: async () => {
        const result = await this.writeSnapshots.rollback();
        if (result.skipped.length > 0) this.runtime.broadcast({ type: 'ERROR', payload: humanModifiedWarning(result.skipped).record });
        this.runtime.broadcast({ type: 'REWIND_RESULT', payload: { restored: result.restored, skipped: result.skipped } });
      },
    });
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
    const controller = new AbortController();
    this.activeChats.set(request.request_id, controller);
    const run: ChatRunBuffer = { events: [], client, finished: false };
    this.chatRuns.set(request.request_id, run);
    console.log(`[chat ${request.request_id}] start model=${model} client=${client ? 'attached' : 'none'}`);
    try {
      await this.runChat(request, model, run, controller.signal);
    } catch (cause) {
      const record = this.machine.toErrorRecord(cause);
      this.sendChat(request.request_id, run, { type: 'CHAT_ERROR', payload: { request_id: request.request_id, code: record.code, message: record.message } });
    } finally {
      this.activeChats.delete(request.request_id);
      run.finished = true;
      run.finishedAt = Date.now();
      run.client = undefined;
      this.pruneChatRuns();
    }
  }

  /**
   * Sends a chat event to the attached client and buffers it. Buffering means a client that reconnects
   * (for example after a page reload) can ask for the same request and receive everything it missed.
   */
  private sendChat(requestId: string, run: ChatRunBuffer, event: RuntimeEvent): void {
    const message = JSON.stringify(event);
    run.events.push(message);
    if (run.client) this.runtime.send(event, run.client);
    else if (!run.finished) console.log(`[chat ${requestId}] no client attached; buffered ${event.type}`);
    if (isCompletedChatEvent(event.type)) console.log(`[chat ${requestId}] ${event.type} (client ${run.client ? 'attached' : 'detached'})`);
  }

  /** Re-attaches a client to a chat run. Buffered events replay first, then new events stream to this client. */
  private attachChat(requestId: string, client: WebSocket): void {
    const run = this.chatRuns.get(requestId);
    if (!run) {
      this.runtime.send({ type: 'CHAT_UNKNOWN', payload: { request_id: requestId } }, client);
      console.log(`[chat ${requestId}] attach: unknown or expired request`);
      return;
    }
    run.client = run.finished ? undefined : client;
    for (const message of run.events) this.runtime.sendRawMessage(message, client);
    console.log(`[chat ${requestId}] attach: replayed ${run.events.length} events, ${run.finished ? 'run already finished' : 'run still active'}`);
  }

  /** Drops finished runs after the retention window so memory does not grow without bound. */
  private pruneChatRuns(): void {
    const cutoff = Date.now() - CHAT_RUN_RETENTION_MS;
    for (const [id, run] of this.chatRuns) {
      if (run.finished && (run.finishedAt ?? 0) < cutoff) this.chatRuns.delete(id);
    }
  }

  /** Aborts an in-flight chat. The model call stops immediately and the client gets CHAT_CANCELLED. */
  private cancelChat(requestId: string, client?: WebSocket): void {
    const controller = this.activeChats.get(requestId);
    if (!controller) return;
    console.log(`[chat ${requestId}] cancel requested`);
    controller.abort();
    const run = this.chatRuns.get(requestId);
    if (run) this.sendChat(requestId, run, { type: 'CHAT_CANCELLED', payload: { request_id: requestId } });
    else this.runtime.send({ type: 'CHAT_CANCELLED', payload: { request_id: requestId } }, client);
  }

  private async runChat(request: RuntimeChatRequest, model: string, run: ChatRunBuffer, signal: AbortSignal): Promise<void> {
    const requestId = request.request_id;
    const emit = (event: RuntimeEvent) => this.sendChat(requestId, run, event);
    const workspacePath = resolveChatWorkspace(request.workspace);
    const task: TaskContract = {
      task_id: randomUUID(),
      workspace_path: workspacePath,
      model_config: { preferred_model: model, fallback_chain: [] },
      permission_mode: parsePermissionMode(request.permission, 'standard'),
      context_mode: 'ephemeral',
      acceptance_criteria: [],
      budget_envelope: { max_tokens: 4000, max_time_ms: 120_000 },
    };
    const subagent = normalizeSubagentSettings(request.subagent);
    const toolDefinitions = chatToolDefinitions(subagent);
    await this.capabilityRouter.discoverSkills(workspacePath).catch(() => undefined);
    const messages = await buildChatMessages(workspacePath, request.messages, request.compacted_summary, this.capabilityRouter.systemPromptMetadata());
    const trace = new ChatTrace();
    const sendTrace = () => emit({ type: 'CHAT_TRACE', payload: { request_id: request.request_id, events: trace.snapshot() } });
    try {
      const onDelta = (text: string) => emit({ type: 'CHAT_DELTA', payload: { request_id: request.request_id, text } });
      let response: ModelResponse | undefined;
      const startedAt = Date.now();
      const usage = { input_tokens: 0, output_tokens: 0, calls: 0, duration_ms: 0 };
      const track = (item: ModelResponse) => {
        usage.calls += 1;
        usage.input_tokens += item.usage?.input_tokens ?? 0;
        usage.output_tokens += item.usage?.output_tokens ?? 0;
      };
      let delegatedChatTotal = 0;
      let toolRuns = 0;
      const compactor = this.createCompactor();
      for (let step = 0; step < CHAT_TOOL_ROUNDS; step += 1) {
        if (estimateTokens(messages, toolDefinitions) > CHAT_COMPACT_TOKENS) {
          const compacted = await compactor.compact(task, messages);
          messages.splice(0, messages.length, ...compacted);
        }
        const endModelCall = trace.begin('model_call', `模型调用 ${step + 1}`);
        response = await this.gateway.complete(task, { prompt: '', messages, tools: toolDefinitions, onDelta, signal });
        track(response);
        endModelCall({ ok: true, detail: response.usage ? `输入 ${response.usage.input_tokens} / 输出 ${response.usage.output_tokens} tokens` : undefined });
        if (!response.tool_calls || response.tool_calls.length === 0) break;
        emit({ type: 'CHAT_RESET', payload: { request_id: request.request_id } });
        messages.push({ role: 'assistant', content: response.content, tool_calls: response.tool_calls });
        let delegatedThisTurn = 0;
        for (const call of response.tool_calls) {
          if (signal.aborted) return;
          const isDelegate = SUBAGENT_TOOL_NAMES.has(call.function.name);
          let result: string;
          const endToolCall = trace.begin(isDelegate ? 'subagent_call' : 'tool_call', call.function.name, summarizeForTrace(call.function.arguments));
          if (isDelegate && !canDelegate(subagent, delegatedThisTurn, delegatedChatTotal)) {
            result = `子代理调用被限制：每轮最多 ${subagent.maxConcurrent} 个，每次聊天最多 ${subagent.maxPerChat} 个。请直接回答或减少委派。`;
          } else if (isDelegate) {
            delegatedThisTurn += 1;
            delegatedChatTotal += 1;
            const mode = call.function.name === 'delegate_task' ? 'general' : call.function.name === 'delegate_write' ? 'write' : 'read';
            result = await this.runDelegatedTask(mode, call.function.arguments, workspacePath, task, signal, subagent);
          } else {
            result = await this.runChatTool(call.function.name, call.function.arguments, workspacePath, task.permission_mode);
          }
          toolRuns += 1;
          endToolCall({ ok: !isToolErrorResult(result), detail: summarizeForTrace(result) });
          sendTrace();
          messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: result });
          emit({ type: 'CHAT_TOOL', payload: { request_id: request.request_id, name: call.function.name, arguments: call.function.arguments, result } });
        }
        response = undefined;
      }
      if (!response) {
        const endFinalCall = trace.begin('model_call', `模型调用 ${usage.calls + 1}`);
        response = await this.gateway.complete(task, { prompt: '', messages, onDelta, signal });
        track(response);
        endFinalCall({ ok: true, detail: response.usage ? `输入 ${response.usage.input_tokens} / 输出 ${response.usage.output_tokens} tokens` : undefined });
      }
      usage.duration_ms = Date.now() - startedAt;
      trace.mark('reply', '完成回复', true, `共 ${usage.calls} 次模型调用，耗时 ${usage.duration_ms}ms`);
      sendTrace();
      await appendChatTrace(workspacePath, request.request_id, trace.snapshot()).catch(() => undefined);
      const longReply = toolRuns === 0 && response.content.length > LONG_REPLY_THRESHOLD
        ? await saveLongReply(workspacePath, request.request_id, response.content).catch(() => undefined)
        : undefined;
      if (longReply) {
        const note = `${longReply.summary}\n\n回复较长（${response.content.length} 字符），已保存到 \`${longReply.path}\`。`;
        emit({ type: 'CHAT_REPLY', payload: { request_id: request.request_id, content: note, model: response.model, usage, saved_path: longReply.path } });
      } else {
        emit({ type: 'CHAT_REPLY', payload: { request_id: request.request_id, content: response.content, model: response.model, usage } });
      }
    } catch (cause) {
      if (signal.aborted) return;
      const record = this.machine.toErrorRecord(cause);
      trace.closeOpen();
      trace.mark('error', '请求失败', false, record.message);
      sendTrace();
      await appendChatTrace(workspacePath, request.request_id, trace.snapshot()).catch(() => undefined);
      emit({ type: 'CHAT_ERROR', payload: { request_id: request.request_id, code: record.code, message: record.message } });
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
    tools.register(createWebSearchTool(process.env.HIERO_BRAVE_API_KEY));
    tools.register(createWebFetchTool());
    registerLoadSkillTool(tools, this.capabilityRouter);
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

  /**
   * Runs a sub-agent with a fixed tool allowlist. It cannot delegate further, and it shares the parent's
   * ToolGateway so write_file still goes through the approval policy. Write mode never widens the parent's permission.
   */
  private async runDelegatedTask(mode: 'read' | 'write' | 'general', rawArguments: string, workspacePath: string, task: TaskContract, signal: AbortSignal, settings: SubagentSettings): Promise<string> {
    try {
      const args = JSON.parse(rawArguments) as { task?: unknown; tools?: unknown };
      const goal = typeof args.task === 'string' ? args.task.trim() : '';
      const toolName = mode === 'write' ? 'delegate_write' : mode === 'general' ? 'delegate_task' : 'delegate_read';
      if (!goal) return JSON.stringify({ error: `${toolName} requires a non-empty task.` });
      // A general sub-agent can reach external tools, so the operator approves the whole delegation outside auto mode.
      if (mode === 'general' && task.permission_mode !== 'auto') {
        const decision = await this.requestToolApproval(toolName, { task: goal, tools: args.tools });
        if (!decision.approved) return JSON.stringify({ error: `${toolName} was denied by the operator.` });
      }
      const toolGateway = this.createChatToolGateway(workspacePath);
      const allowlist = mode === 'write' || mode === 'general' ? WRITE_SUBAGENT_TOOLS : READ_ONLY_SUBAGENT_TOOLS;
      const allowedTools: ModelToolDefinition[] = CHAT_TOOL_DEFINITIONS.filter((tool) => allowlist.has(tool.function.name));
      if (mode === 'general' && typeof args.tools === 'string' && args.tools.trim()) {
        allowedTools.push(...await this.capabilityRouter.registerTools(toolGateway, args.tools.trim()));
      }
      const systemPrompt = mode === 'read'
        ? undefined
        : 'You are a sub-agent. Use the tools to complete the task, then reply with a concise summary (under 300 words) of what you did. You cannot change memory or delegate further.';
      const summary = await runReadOnlySubagent({ modelGateway: this.gateway, toolGateway, allowedTools, task, goal, signal, maxTurns: settings.maxTurns, resultLimit: settings.resultLimit, ...(systemPrompt ? { systemPrompt } : {}) });
      return JSON.stringify({ summary });
    } catch (cause) {
      return JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) });
    }
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
      this.machine.beginTask();
      this.writeSnapshots.clear();
      this.currentTaskId = task.task_id;
      this.stateStore.startTask(task.task_id, task.workspace_path, message.goal);
      const before = await snapshotTextFiles(task.workspace_path);
      const outcome = await this.createWorkflow(task.workspace_path).run(task, message.goal, [WRITE_FILE_TOOL_DEFINITION, ...(message.tools ?? [])]);
      if ('handoff' in outcome) {
        this.runtime.completeState(AgentState.Handoff);
        this.stateStore.finishTask(task.task_id, 'completed');
        return;
      }
      const after = await snapshotTextFiles(task.workspace_path);
      for (const diff of await diffSnapshots(before, after)) this.runtime.broadcast({ type: 'FILE_DIFF', payload: diff });
      this.runtime.completeState(AgentState.Verify);
      this.stateStore.finishTask(task.task_id, 'completed');
    } catch (cause) {
      if (this.currentTaskId) this.stateStore.finishTask(this.currentTaskId, 'failed');
      this.runtime.reportError(cause);
    } finally {
      this.currentTaskId = undefined;
    }
  }

  public async close(): Promise<void> {
    await this.runtime.close();
    await this.systemAgent.close();
    this.stateStore.close();
  }
}

