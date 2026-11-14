import type { ToolEffect } from './tool-gateway.js';

/** Approval categories a tool call falls into. `read` covers inspection; the rest change state or reach outside. */
export type ToolCategory = 'read' | 'write' | 'execute' | 'network';

export type CategoryRule = 'auto' | 'ask';

export type CategoryRules = Record<ToolCategory, CategoryRule>;

export const DEFAULT_CATEGORY_RULES: CategoryRules = { read: 'auto', write: 'ask', execute: 'ask', network: 'ask' };

export const TOOL_CATEGORIES: ToolCategory[] = ['read', 'write', 'execute', 'network'];

/** Maps a tool's declared effect onto an approval category. Network tools are classified before effects. */
export function categoryOf(tool: { effect?: ToolEffect; networkAccess?: boolean }): ToolCategory {
  if (tool.networkAccess) return 'network';
  if (tool.effect === 'workspace') return 'write';
  if (tool.effect === 'external') return 'execute';
  return 'read';
}

/** Parses stored rules, falling back to the default for any missing or invalid entry. */
export function normalizeCategoryRules(value: unknown): CategoryRules {
  const source = typeof value === 'object' && value !== null ? value as Partial<Record<ToolCategory, unknown>> : {};
  const rules = { ...DEFAULT_CATEGORY_RULES };
  for (const category of TOOL_CATEGORIES) {
    const candidate = source[category];
    if (candidate === 'auto' || candidate === 'ask') rules[category] = candidate;
  }
  return rules;
}
