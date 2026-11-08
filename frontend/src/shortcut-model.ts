export type ShortcutAction = 'newChat' | 'focusCommand' | 'focusChatInput' | 'toggleRail' | 'openSettings' | 'openDocs';

export interface ShortcutBinding {
  action: ShortcutAction;
  key: string;
  label: string;
}

export const SHORTCUTS: readonly ShortcutBinding[] = [
  // Avoid combos the browser reserves (Ctrl+Shift+N/B/D/R/T/O, etc.), which cannot be overridden.
  { action: 'newChat', key: 'Ctrl+Shift+Y', label: '新建对话' },
  { action: 'focusChatInput', key: 'Ctrl+Shift+L', label: '聚焦对话输入框' },
  { action: 'focusCommand', key: 'Ctrl+Shift+P', label: '聚焦命令栏' },
  { action: 'toggleRail', key: 'Ctrl+Shift+E', label: '显示/隐藏快捷栏' },
  { action: 'openSettings', key: 'Ctrl+Shift+,', label: '打开设置' },
  { action: 'openDocs', key: 'Ctrl+Shift+U', label: '打开文档' },
];

export interface KeyEventLike {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  code: string;
}

const CODE_TO_KEY: Record<string, string> = {
  Comma: ',',
};

function keyFromCode(code: string): string {
  if (CODE_TO_KEY[code]) return CODE_TO_KEY[code];
  if (code.startsWith('Key')) return code.slice(3);
  return code;
}

// Ctrl+Shift shortcuts; Meta is accepted as the Ctrl equivalent on macOS.
export function shortcutFromEvent(event: KeyEventLike): ShortcutAction | null {
  if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return null;
  const key = keyFromCode(event.code);
  const binding = SHORTCUTS.find((item) => item.key === `Ctrl+Shift+${key}`);
  return binding?.action ?? null;
}
