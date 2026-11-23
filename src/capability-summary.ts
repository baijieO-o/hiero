export type CapabilityState = 'available' | 'disabled' | 'unconnected' | 'retrying';

export interface CapabilityEntry {
  name: string;
  state: CapabilityState;
  /** Why the capability is not usable right now. Empty when available. */
  reason?: string;
}

export interface McpStatusLike {
  name: string;
  connected: boolean;
  tool_count: number;
  error?: string;
}

export const CAPABILITY_STATE_LABELS: Record<CapabilityState, string> = {
  available: '可用',
  disabled: '已停用',
  unconnected: '未连接',
  retrying: '重试中',
};

/** Marks an MCP server as available only when it is enabled and connected; otherwise it reports the cause. */
export function mcpCapability(name: string, enabled: boolean, status: McpStatusLike | undefined): CapabilityEntry {
  if (!enabled) return { name, state: 'disabled' };
  if (status?.connected) return { name, state: 'available' };
  return { name, state: 'unconnected', ...(status?.error ? { reason: status.error } : {}) };
}

export function toggledCapability(name: string, enabled: boolean): CapabilityEntry {
  return enabled ? { name, state: 'available' } : { name, state: 'disabled' };
}

/**
 * Builds the short system-prompt block that tells the model what it can use right now.
 * Lists only usable entries by name and summarizes the rest, so the model does not claim a disabled or disconnected capability.
 */
export function capabilityPromptBlock(entries: readonly CapabilityEntry[]): string {
  if (entries.length === 0) return '';
  const usable = entries.filter((entry) => entry.state === 'available').map((entry) => entry.name);
  const unusable = entries.filter((entry) => entry.state !== 'available').map((entry) => {
    const reason = entry.reason ? `：${entry.reason.replace(/\s+/g, ' ').trim()}` : '';
    return `${entry.name}（${CAPABILITY_STATE_LABELS[entry.state]}${reason}）`;
  });
  const lines = [
    `Currently usable capabilities: ${usable.length > 0 ? usable.join(', ') : 'none'}.`,
  ];
  if (unusable.length > 0) lines.push(`Not usable right now: ${unusable.join(', ')}. Do not claim you can use these; say so and explain.`);
  return lines.join('\n');
}
