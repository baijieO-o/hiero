export type PermissionMode = 'strict' | 'standard' | 'auto';
export type ContextMode = 'ephemeral' | 'persistent_md';

export interface TaskContract {
  task_id: string;
  workspace_path: string;
  model_config: { preferred_model: string; fallback_chain: string[] };
  permission_mode: PermissionMode;
  context_mode: ContextMode;
  acceptance_criteria: string[];
  budget_envelope: { max_tokens: number; max_time_ms: number };
}

export interface HandoffDocument {
  checkpoint_id: string;
  task_goal: string;
  completed_steps: string[];
  current_state: string;
  decisions_and_rationale: { decision: string; reason: string }[];
  next_steps: string[];
  active_mcp_servers: string[];
  deferred_tool_subset: string[];
  mrtr_pending: boolean;
  human_modified_files: string[];
}

export interface EvidenceRecord {
  evidence_id: string;
  intent_id: string;
  tool_name: string;
  result: unknown;
  success: boolean;
  created_at: string;
}


export type ErrorLevel = 'blocker' | 'degradation' | 'warning';

export interface ErrorRecord {
  code: string;
  level: ErrorLevel;
  message: string;
  suggestion: string;
  evidence_id?: string;
}

export class HieroError extends Error {
  public readonly record: ErrorRecord;

  public constructor(record: ErrorRecord) {
    super(`[${record.code}] ${record.message}`);
    this.name = 'HieroError';
    this.record = record;
  }
}

export const error = (
  code: string,
  level: ErrorLevel,
  message: string,
  suggestion: string,
  evidence_id?: string,
): HieroError => new HieroError({ code, level, message, suggestion, ...(evidence_id ? { evidence_id } : {}) });
