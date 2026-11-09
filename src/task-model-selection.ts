/** Kinds of model work Hiero performs. Each kind can be pinned to a model in settings. */
export const TASK_MODEL_KINDS = ['chat', 'planning', 'execution', 'subagent', 'compaction'] as const;
export type TaskModelKind = (typeof TASK_MODEL_KINDS)[number];

export const TASK_MODEL_KIND_LABELS: Record<TaskModelKind, string> = {
  chat: '对话回复',
  planning: '任务规划',
  execution: '工具执行 / 编码',
  subagent: '只读调研子任务',
  compaction: '上下文压缩',
};

/** Manual per-kind overrides. An absent or blank entry means "use auto selection". */
export type TaskModelOverrides = Partial<Record<TaskModelKind, string>>;

export interface ModelCandidate {
  name: string;
  /** Lowercased model id; used by the heuristic to infer model strength. */
  model: string;
}

/**
 * Picks a model for a task kind from the candidates. Heuristic only:
 * reasoning-heavy kinds prefer larger/reasoning models; compaction and read-only research prefer cheaper, faster ones.
 * Returns undefined when there are no candidates, so the caller keeps its default model.
 */
export function autoSelectModel(kind: TaskModelKind, candidates: readonly string[]): string | undefined {
  if (candidates.length === 0) return undefined;
  const preference: Record<TaskModelKind, readonly RegExp[]> = {
    planning: [/reason|think|opus|o[1-9]\b|pro\b|max|large|405b|70b/i, /sonnet/i, /gpt-4(?!.*mini)|coder/i],
    execution: [/coder|code|opus|sonnet|pro\b|large|70b/i],
    chat: [/sonnet|pro\b|gpt-4|large|70b/i],
    subagent: [/flash|mini|haiku|small|8b|nano|lite/i],
    compaction: [/flash|mini|haiku|small|8b|nano|lite/i],
  };
  for (const pattern of preference[kind]) {
    const match = candidates.find((candidate) => pattern.test(candidate));
    if (match) return match;
  }
  return candidates[0];
}

/**
 * Resolves the model for a kind: a manual override wins when it is a known candidate,
 * otherwise auto selection applies. Returns undefined when neither yields a model.
 */
export function resolveTaskModel(
  kind: TaskModelKind,
  overrides: TaskModelOverrides,
  candidates: readonly string[],
): string | undefined {
  const manual = overrides[kind]?.trim();
  if (manual) return manual;
  return autoSelectModel(kind, candidates);
}

/** Parses HIERO_LLM_TASK_MODELS, a JSON object keyed by task kind. Unknown keys and non-string values are dropped. */
export function parseTaskModelOverrides(raw: string | undefined): TaskModelOverrides {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const result: TaskModelOverrides = {};
  for (const kind of TASK_MODEL_KINDS) {
    const value = (parsed as Record<string, unknown>)[kind];
    if (typeof value === 'string' && value.trim()) result[kind] = value.trim();
  }
  return result;
}
