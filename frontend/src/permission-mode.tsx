import type { ReactElement } from 'react';

export type PermissionLabel = '严格' | '标准' | '自动';

export const PERMISSION_LABELS: PermissionLabel[] = ['严格', '标准', '自动'];

export const PERMISSION_STORAGE_KEY = 'hiero-permission-mode';

export interface PermissionDescription {
  label: PermissionLabel;
  summary: string;
  effects: string[];
  risk: 'low' | 'medium' | 'high';
}

// Mirrors src/permission-policy.ts and src/tool-gateway.ts. Keep in sync when the policy changes.
export const PERMISSION_DESCRIPTIONS: Record<PermissionLabel, PermissionDescription> = {
  严格: {
    label: '严格',
    summary: '只读。不执行终端命令，不可逆操作需你逐次批准。',
    effects: ['可以读取工作区文件', '不执行任何终端命令', '写文件等不可逆操作需要批准'],
    risk: 'low',
  },
  标准: {
    label: '标准',
    summary: '工作区内自动执行，外部动作需批准。推荐默认值。',
    effects: ['工作区内的文件写入自动允许', '终端只允许只读命令（如 ls、cat、git status）', '网络访问、删除、其他命令需要批准'],
    risk: 'medium',
  },
  自动: {
    label: '自动',
    summary: '全部自动执行，不再询问。仅在你信任任务与工作区时使用。',
    effects: ['允许任意终端命令', '网络访问与删除不再询问', '无审批环节，出错需要靠回退恢复'],
    risk: 'high',
  },
};

export function isPermissionLabel(value: string): value is PermissionLabel {
  return (PERMISSION_LABELS as string[]).includes(value);
}

export function readStoredPermission(): PermissionLabel {
  const saved = localStorage.getItem(PERMISSION_STORAGE_KEY);
  return saved && isPermissionLabel(saved) ? saved : '标准';
}

export function storePermission(value: PermissionLabel): void {
  localStorage.setItem(PERMISSION_STORAGE_KEY, value);
}

export function toPermissionMode(label: PermissionLabel): 'strict' | 'standard' | 'auto' {
  if (label === '自动') return 'auto';
  if (label === '标准') return 'standard';
  return 'strict';
}

export function PermissionModePicker({ value, disabled, onChange }: { value: PermissionLabel; disabled?: boolean; onChange: (value: PermissionLabel) => void }): ReactElement {
  const description = PERMISSION_DESCRIPTIONS[value];
  return (
    <div className="permission-picker" role="radiogroup" aria-label="权限模式">
      {PERMISSION_LABELS.map((label) => {
        const item = PERMISSION_DESCRIPTIONS[label];
        const selected = label === value;
        return (
          <button
            key={label}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`permission-option permission-${item.risk}${selected ? ' is-selected' : ''}`}
            disabled={disabled}
            onClick={() => onChange(label)}
          >
            <strong>{label}</strong>
            <small>{item.summary}</small>
          </button>
        );
      })}
      <ul className={`permission-effects permission-${description.risk}`} aria-live="polite">
        {description.effects.map((effect) => <li key={effect}>{effect}</li>)}
      </ul>
      {description.risk === 'high' && <p className="permission-warning" role="alert">自动模式不会再询问你。请确认工作区路径正确。</p>}
    </div>
  );
}
