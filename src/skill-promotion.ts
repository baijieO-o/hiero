import type { EvidenceRecord } from './contracts.js';
import type { ApprovalBroker } from './approval-broker.js';
import { saveSkill } from './skill-store.js';

/** Write tools whose successful calls form the reusable procedure. Read-only lookups are left out. */
const PROCEDURE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file']);

export interface SkillCandidate {
  name: string;
  description: string;
  /** Full SKILL.md content, including provenance in the frontmatter. */
  content: string;
  steps: string[];
}

export interface SkillSource {
  task_id: string;
  goal: string;
  generated_at: string;
}

/** Derives a kebab-case skill name from the task goal. Falls back to the task id when the goal has no usable characters. */
export function deriveSkillName(goal: string, taskId: string): string {
  const slug = goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return slug || `task-${taskId.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}`;
}

/**
 * Builds a candidate skill from the successful procedure steps in evidence.
 * Returns undefined when no successful procedure step exists, so nothing is proposed for pure reads.
 */
export function buildSkillCandidate(evidence: readonly EvidenceRecord[], source: SkillSource): SkillCandidate | undefined {
  const steps = evidence
    .filter((record) => record.success && PROCEDURE_TOOLS.has(record.tool_name))
    .map((record) => `${record.tool_name}`);
  if (steps.length === 0) return undefined;
  const name = deriveSkillName(source.goal, source.task_id);
  const description = `Reusable procedure distilled from task ${source.task_id}: ${source.goal.replace(/\s+/g, ' ').slice(0, 120)}`;
  const provenance = [
    `task_id: ${source.task_id}`,
    `generated_at: ${source.generated_at}`,
    'status: approved-by-operator',
  ].join('\n');
  const body = [
    `# ${name}`,
    '',
    `Goal: ${source.goal.replace(/\s+/g, ' ').trim()}`,
    '',
    '## Steps (tool calls that succeeded)',
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    '## Source',
    `Derived from task ${source.task_id}. Verify the acceptance criteria again before reusing.`,
  ].join('\n');
  const content = `---\nname: ${name}\ndescription: "${description.replace(/"/g, '\\"')}"\n${provenance}\n---\n\n${body}\n`;
  return { name, description, content, steps };
}

/**
 * Asks the operator to approve a candidate skill. Only an explicit approval writes SKILL.md to `.agent/skills`.
 * Denial and timeout both leave the workspace unchanged.
 */
export async function promoteSkillWithApproval(
  broker: Pick<ApprovalBroker, 'request'>,
  workspacePath: string,
  candidate: SkillCandidate,
): Promise<{ saved: boolean; path?: string }> {
  const decision = await broker.request('skill_promote', `沉淀技能（需确认）：project/${candidate.name}`, {
    scope: 'project',
    name: candidate.name,
    description: candidate.description,
    steps: candidate.steps,
  });
  if (!decision.approved) return { saved: false };
  const record = await saveSkill(workspacePath, 'project', candidate.name, candidate.content);
  return { saved: true, path: record.path };
}
