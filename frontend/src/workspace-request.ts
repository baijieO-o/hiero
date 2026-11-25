import { RUNTIME_WS_URL } from './runtime-url';
import type { RuntimeSocketMessage } from './runtime-socket';

export type SkillScope = 'project' | 'user' | 'agents' | 'codex';
export type MemoryScope = 'global' | 'project';

export type WorkspaceRequestBody = { workspace?: string } & (
  | { type: 'folder_pick'; initialPath?: string }
  | { type: 'fs_list'; path?: string }
  | { type: 'fs_read'; path: string }
  | { type: 'term_exec'; command: string; cwd?: string; permission?: string }
  | { type: 'skill_list' }
  | { type: 'skill_read'; scope: SkillScope; name: string }
  | { type: 'skill_save'; scope: SkillScope; name: string; content: string }
  | { type: 'skill_delete'; scope: SkillScope; name: string }
  | { type: 'memory_read'; scope: MemoryScope }
  | { type: 'memory_save'; scope: MemoryScope; content: string }
  | { type: 'deep_memory_list' }
  | { type: 'deep_memory_delete'; scope: MemoryScope; id: string }
  | { type: 'deep_memory_update'; scope: MemoryScope; id: string; content: string }
  | { type: 'deep_memory_set_enabled'; scope: MemoryScope; id: string; enabled: boolean }
);

let defaultWorkspace: () => string | undefined = () => undefined;

/** 未指定 workspace 时使用的默认工作区，由聊天 store 注入，避免本模块依赖 store。 */
export function setDefaultWorkspaceProvider(provider: () => string | undefined): void {
  defaultWorkspace = provider;
}

export function requestWorkspace(body: WorkspaceRequestBody): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const socket = new WebSocket(RUNTIME_WS_URL);
    const timer = window.setTimeout(() => { socket.close(); reject(new Error('请求超时，运行时无响应')); }, 60_000);
    const workspace = body.workspace ?? defaultWorkspace();
    socket.onopen = () => socket.send(JSON.stringify({ ...body, workspace, request_id: requestId }));
    socket.onerror = () => { window.clearTimeout(timer); reject(new Error('无法连接运行时 ' + RUNTIME_WS_URL)); };
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as RuntimeSocketMessage;
      if (message.type !== 'WORKSPACE_RESULT' || message.payload?.request_id !== requestId) return;
      window.clearTimeout(timer);
      socket.close();
      if (message.payload.ok === true) resolve(message.payload);
      else reject(new Error(String(message.payload.message ?? '请求失败')));
    };
  });
}
