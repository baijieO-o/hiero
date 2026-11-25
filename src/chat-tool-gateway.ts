import { z } from 'zod';
import { createEditFileTool, createListDirTool, createReadFileTool, createWriteFileTool } from './basic-tools.js';
import { createWebFetchTool, createWebSearchTool } from './web-tools.js';
import { BrowserSessions, createBrowserActionTools, createBrowserReadTools } from './browser-session.js';
import { registerLoadSkillTool } from './skill-tool.js';
import { CodeIndex, createSymbolSearchTool } from './code-index.js';
import { normalizeCategoryRules } from './tool-category-policy.js';
import { ToolGateway } from './tool-gateway.js';
import { CapabilityRouter } from './capability-router.js';
import { HotPlugRegistry } from './hot-plug.js';
import { WriteSnapshotStore } from './write-snapshots.js';
import type { ApprovalDecision } from './approval-broker.js';
import type { ProcessManager } from './process-manager.js';
import { addDeepMemory, searchDeepMemory } from './deep-memory.js';
import { appendMemory } from './memory-store.js';

/** Tool names from HIERO_HITL_TOOLS (comma-separated) that always pause for approval outside auto mode. */
export function hitlBreakpointsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set(['write_file', ...(env.HIERO_HITL_TOOLS ?? '').split(',').map((name) => name.trim()).filter((name) => name.length > 0)])];
}

/** Runtime-owned services the chat tools need. Passed in explicitly so the factory has no runtime dependency. */
export interface ChatToolGatewayDeps {
  writeSnapshots: WriteSnapshotStore;
  browserSessions: BrowserSessions;
  capabilityRouter: CapabilityRouter;
  codeIndexFor: (workspacePath: string) => CodeIndex;
  processes: ProcessManager;
  hotPlug: HotPlugRegistry;
  requestApproval: (toolName: string, input: unknown) => Promise<ApprovalDecision>;
}

export interface ChatToolGatewayOptions {
  /** `false` keeps disabled tools listed, for the management API. */
  applyHotPlug?: boolean;
  categoryRules?: unknown;
  conversationId?: string | undefined;
}

/**
 * Chat tools run through a per-request ToolGateway so they share schema checks and the approval policy.
 * Memory writes change persistent state, so they are irreversible and need approval outside auto mode.
 */
export function createChatToolGateway(deps: ChatToolGatewayDeps, workspacePath: string, options: ChatToolGatewayOptions = {}): ToolGateway {
  const { applyHotPlug = true, categoryRules, conversationId } = options;
  const tools = new ToolGateway();
  tools.setCategoryRules(normalizeCategoryRules(categoryRules));
  tools.register(createReadFileTool(workspacePath));
  tools.register(createListDirTool(workspacePath));
  tools.register(createWriteFileTool(workspacePath, deps.writeSnapshots));
  tools.register(createEditFileTool(workspacePath, deps.writeSnapshots));
  tools.register(createWebSearchTool(process.env.HIERO_BRAVE_API_KEY));
  tools.register(createWebFetchTool());
  for (const tool of createBrowserReadTools(deps.browserSessions)) tools.register(tool);
  for (const tool of createBrowserActionTools(deps.browserSessions)) tools.register(tool);
  registerLoadSkillTool(tools, deps.capabilityRouter);
  tools.register(createSymbolSearchTool(deps.codeIndexFor(workspacePath)));
  tools.register({
    name: 'memory_recall',
    inputSchema: z.object({ query: z.string().default('') }),
    effect: 'read',
    execute: async ({ query }) => {
      const hits = await searchDeepMemory(workspacePath, query, 5, conversationId);
      return { hits: hits.map(({ id, scope, content, tags, score, source }) => ({ id, scope, content, tags, score, source })) };
    },
  });
  tools.register({
    name: 'memory_remember',
    inputSchema: z.object({ scope: z.string().optional(), content: z.string().default(''), tags: z.array(z.string()).optional(), source: z.string().optional(), session_only: z.boolean().optional() }),
    irreversible: true,
    effect: 'workspace',
    execute: async (args) => {
      const entry = await addDeepMemory(workspacePath, args.scope === 'global' ? 'global' : 'project', args.content, {
        tags: args.tags ?? [],
        source: args.source === 'inferred' ? 'inferred' : 'user',
        ...(args.session_only && conversationId ? { sessionId: conversationId } : {}),
      });
      return { ok: true, id: entry.id, source: entry.source };
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
  tools.register({
    name: 'start_process',
    inputSchema: z.object({ command: z.string().min(1) }),
    effect: 'external',
    execute: async (args) => {
      const info = deps.processes.start(args.command, workspacePath, 'agent');
      return { ok: true, id: info.id, status: info.status };
    },
  });
  tools.setApprover((toolName, input) => deps.requestApproval(toolName, input));
  tools.setBreakpoints(hitlBreakpointsFromEnv());
  if (applyHotPlug) for (const name of deps.hotPlug.disabledToolNames()) tools.unregister(name);
  return tools;
}
