import { useEffect, useMemo, useState, type ReactElement } from 'react';

export interface AskUserField {
  key: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'multi';
  title: string;
  description?: string;
  options?: { value: string; label: string }[];
}

export interface AskUserRequest {
  ask_id: string;
  message: string;
  fields: AskUserField[];
}

/** The backend treats no answer after this long as cancelled (AskUserBroker default). */
export const ASK_USER_TIMEOUT_MS = 120_000;

interface AskUserDialogProps {
  request: AskUserRequest;
  onRespond: (answer: { status: 'submitted'; values: Record<string, unknown> } | { status: 'declined' }) => void;
  now?: () => number;
}

type Draft = Record<string, string | boolean | string[]>;

function initialDraft(fields: AskUserField[]): Draft {
  const draft: Draft = {};
  for (const field of fields) {
    if (field.type === 'boolean') draft[field.key] = false;
    else if (field.type === 'multi') draft[field.key] = [];
    else draft[field.key] = '';
  }
  return draft;
}

/** Converts the draft into typed values. Returns an error message when a field is invalid. */
function collectValues(fields: AskUserField[], draft: Draft): { values: Record<string, unknown> } | { error: string } {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = draft[field.key];
    if (field.type === 'boolean') { values[field.key] = raw === true; continue; }
    if (field.type === 'multi') { values[field.key] = Array.isArray(raw) ? raw : []; continue; }
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (field.type === 'enum') {
      if (!text) return { error: `请选择：${field.title}` };
      values[field.key] = text;
    } else if (field.type === 'number' || field.type === 'integer') {
      if (!text) return { error: `请填写：${field.title}` };
      const numeric = Number(text);
      if (!Number.isFinite(numeric) || (field.type === 'integer' && !Number.isInteger(numeric))) return { error: `${field.title} 需要${field.type === 'integer' ? '整数' : '数字'}` };
      values[field.key] = numeric;
    } else {
      if (!text) return { error: `请填写：${field.title}` };
      values[field.key] = text;
    }
  }
  return { values };
}

/** Structured question from the model. The operator can submit, decline, or let it time out. */
export function AskUserDialog({ request, onRespond, now = Date.now }: AskUserDialogProps): ReactElement {
  const [deadline] = useState(() => now() + ASK_USER_TIMEOUT_MS);
  const [remaining, setRemaining] = useState(() => Math.max(0, Math.ceil((deadline - now()) / 1000)));
  const [draft, setDraft] = useState<Draft>(() => initialDraft(request.fields));
  const [error, setError] = useState('');

  useEffect(() => {
    const timer = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - now()) / 1000));
      setRemaining(left);
      if (left === 0) window.clearInterval(timer);
    }, 500);
    return () => window.clearInterval(timer);
  }, [deadline, now]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onRespond({ status: 'declined' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onRespond]);

  const setField = (key: string, value: string | boolean | string[]) => setDraft((current) => ({ ...current, [key]: value }));

  const submit = () => {
    const result = collectValues(request.fields, draft);
    if ('error' in result) { setError(result.error); return; }
    onRespond({ status: 'submitted', values: result.values });
  };

  const hasFields = useMemo(() => request.fields.length > 0, [request.fields]);

  return (
    <div className="approval-backdrop">
      <div role="dialog" aria-modal="true" aria-labelledby="ask-user-title" className="approval-dialog ask-user-dialog">
        <div className="approval-head">
          <span className="approval-badge">需要你的输入</span>
          <span className="approval-countdown">{remaining} 秒后视为取消</span>
        </div>
        <h3 id="ask-user-title">{request.message}</h3>
        {hasFields && (
          <form className="ask-user-form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
            {request.fields.map((field) => (
              <label key={field.key} className="ask-user-field">
                <span className="ask-user-title">{field.title}</span>
                {field.description && <span className="ask-user-desc">{field.description}</span>}
                {field.type === 'boolean' && (
                  <input type="checkbox" checked={draft[field.key] === true} onChange={(event) => setField(field.key, event.target.checked)} />
                )}
                {field.type === 'enum' && (
                  <select value={String(draft[field.key] ?? '')} onChange={(event) => setField(field.key, event.target.value)}>
                    <option value="">请选择</option>
                    {(field.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                )}
                {field.type === 'multi' && (
                  <span className="ask-user-multi">
                    {(field.options ?? []).map((option) => {
                      const selected = Array.isArray(draft[field.key]) ? (draft[field.key] as string[]) : [];
                      return (
                        <label key={option.value}>
                          <input
                            type="checkbox"
                            checked={selected.includes(option.value)}
                            onChange={(event) => setField(field.key, event.target.checked ? [...selected, option.value] : selected.filter((item) => item !== option.value))}
                          />
                          {option.label}
                        </label>
                      );
                    })}
                  </span>
                )}
                {(field.type === 'string' || field.type === 'number' || field.type === 'integer') && (
                  <input
                    type={field.type === 'string' ? 'text' : 'number'}
                    step={field.type === 'integer' ? 1 : 'any'}
                    value={String(draft[field.key] ?? '')}
                    onChange={(event) => setField(field.key, event.target.value)}
                  />
                )}
              </label>
            ))}
            {error && <p className="ask-user-error" role="alert">{error}</p>}
            <div className="approval-actions">
              <button type="button" className="approval-deny" onClick={() => onRespond({ status: 'declined' })}>不回答（Esc）</button>
              <button type="submit" className="approval-approve">提交</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
