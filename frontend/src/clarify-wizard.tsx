import type { ReactElement } from 'react';
import type { ClarifyAnswers, ClarifyQuestion } from './clarify-model';

interface ClarifyWizardProps {
  questions: ClarifyQuestion[];
  answers: ClarifyAnswers;
  onAnswersChange: (answers: ClarifyAnswers) => void;
  criteria: string;
  onCriteriaChange: (value: string) => void;
  complete: boolean;
}

/** Asks the few questions a vague goal needs before launch. Criteria answers are written into the task card. */
export function ClarifyWizard({ questions, answers, onAnswersChange, criteria, onCriteriaChange, complete }: ClarifyWizardProps): ReactElement | null {
  if (questions.length === 0) return null;
  return (
    <section className="clarify-wizard" aria-label="澄清问题">
      <div className="clarify-title">启动前，请回答几个问题</div>
      {questions.map((question) => (
        <div className="clarify-item" key={question.key}>
          <div className="clarify-question">
            {question.question}
            {question.optional && <span className="clarify-optional">（可跳过）</span>}
          </div>
          <p className="clarify-hint">{question.hint}</p>
          {question.key === 'criteria' && (
            <textarea
              className="clarify-input"
              aria-label={question.question}
              value={criteria}
              placeholder={'cmd: npm test\n文档已更新'}
              onChange={(event) => onCriteriaChange(event.target.value)}
            />
          )}
          {question.key === 'writes' && (
            <div className="clarify-choices" role="radiogroup" aria-label={question.question}>
              <button type="button" role="radio" aria-checked={answers.allowWrites === true} className={answers.allowWrites === true ? 'clarify-choice active' : 'clarify-choice'} onClick={() => onAnswersChange({ ...answers, allowWrites: true })}>可以修改</button>
              <button type="button" role="radio" aria-checked={answers.allowWrites === false} className={answers.allowWrites === false ? 'clarify-choice active' : 'clarify-choice'} onClick={() => onAnswersChange({ ...answers, allowWrites: false })}>只读，不修改</button>
            </div>
          )}
        </div>
      ))}
      {!complete && <p className="clarify-pending">还有必填问题未回答，回答后才能确认任务卡。</p>}
    </section>
  );
}
