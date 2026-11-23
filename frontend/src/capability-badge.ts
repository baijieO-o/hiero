// 与 src/capability-summary.ts 保持一致（前端不直接引用后端源码）。
export type CapabilityState = 'available' | 'disabled' | 'unconnected' | 'retrying';

export interface CapabilityEntry {
  name: string;
  state: CapabilityState;
  reason?: string;
}

export interface McpStatusLike {
  name: string;
  connected: boolean;
  error?: string;
}

export const CAPABILITY_STATE_LABELS: Record<CapabilityState, string> = {
  available: '可用',
  disabled: '已停用',
  unconnected: '未连接',
  retrying: '重试中',
};

export function mcpCapability(name: string, enabled: boolean, status: McpStatusLike | undefined): CapabilityEntry {
  if (!enabled) return { name, state: 'disabled' };
  if (status?.connected) return { name, state: 'available' };
  return { name, state: 'unconnected', ...(status?.error ? { reason: status.error } : {}) };
}

export function toggledCapability(name: string, enabled: boolean): CapabilityEntry {
  return { name, state: enabled ? 'available' : 'disabled' };
}
