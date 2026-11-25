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

/**
 * Marks an MCP server as available only when it is enabled and connected; otherwise it reports the cause.
 * `retrying` is true while the plug is backing off after a failed connection attempt.
 */
export function mcpCapability(name: string, enabled: boolean, status: McpStatusLike | undefined, retrying = false): CapabilityEntry {
  if (!enabled) return { name, state: 'disabled' };
  if (status?.connected) return { name, state: 'available' };
  if (retrying) return { name, state: 'retrying', ...(status?.error ? { reason: status.error } : {}) };
  return { name, state: 'unconnected', ...(status?.error ? { reason: status.error } : {}) };
}

export function toggledCapability(name: string, enabled: boolean): CapabilityEntry {
  return enabled ? { name, state: 'available' } : { name, state: 'disabled' };
}

/**
 * MCP tools are not in the model's tool list; they are reached only through `search_tools`.
 * Returns a guidance line when at least one MCP server is available, so the model looks there instead of falling back to web tools.
 */
export function mcpSearchGuidance(entries: readonly CapabilityEntry[], mcpNames: ReadonlySet<string>): string {
  const available = entries.filter((entry) => mcpNames.has(entry.name) && entry.state === 'available').map((entry) => entry.name);
  if (available.length === 0) return '';
  return `MCP servers available: ${available.join(', ')}. Their tools are not listed directly. For requests about these services (for example GitHub repositories, issues, or pull requests), first call search_tools with a short capability query to find the matching MCP tool, and use it instead of web search.`;
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
