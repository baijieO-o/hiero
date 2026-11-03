export type ClarifyKey = 'criteria' | 'writes' | 'workspace';

export interface ClarifyQuestion {
  key: ClarifyKey;
  question: string;
  hint: string;
  /** Optional questions can be skipped. The card still launches without an answer. */
  optional: boolean;
}

/** Criteria answers go straight into the task card, so only the write choice is kept here. */
export interface ClarifyAnswers {
  allowWrites: boolean | null;
}

/** Goals shorter than this are treated as vague and get a criteria question. */
const MIN_GOAL_CHARS = 8;

/** Returns the questions to ask before launch. An empty list means the goal is specific enough. */
export function clarifyQuestions(draft: { goal: string; criteria: string }, workspace: string): ClarifyQuestion[] {
  const questions: ClarifyQuestion[] = [];
  const goal = draft.goal.trim();
  if (goal.length < MIN_GOAL_CHARS) {
    questions.push({ key: 'criteria', question: '怎样算完成？', hint: '写成可检查的标准，例如“npm test 通过”。', optional: false });
  } else if (!draft.criteria.trim()) {
    questions.push({ key: 'criteria', question: '是否需要明确的成功标准？', hint: '没有标准时，验证只会记录而不会自动判定通过。', optional: true });
  }
  questions.push({ key: 'writes', question: 'Hiero 可以修改工作区文件吗？', hint: '选“否”会在执行前拦截写入类操作。', optional: false });
  if (!workspace.trim()) {
    questions.push({ key: 'workspace', question: '在哪个工作区执行？', hint: '请先在下方填写绝对路径。', optional: false });
  }
  return questions;
}

/** Whether every required question has an answer. Criteria are read from the task card. */
export function clarifyComplete(questions: ClarifyQuestion[], criteria: string, answers: ClarifyAnswers, workspace: string): boolean {
  return questions.every((question) => {
    if (question.optional) return true;
    if (question.key === 'criteria') return criteria.trim().length > 0;
    if (question.key === 'writes') return answers.allowWrites !== null;
    return workspace.trim().length > 0;
  });
}
