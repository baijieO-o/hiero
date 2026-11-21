import { useEffect, useRef, useState } from 'react';

// Radial menu items, clockwise from the top. Extend ITEMS and runAction together.
export const ITEMS = [
  { id: 'undo', label: '撤销' },
  { id: 'redo', label: '重做' },
  { id: 'cut', label: '剪切' },
  { id: 'copy', label: '复制' },
  { id: 'paste', label: '粘贴' },
  { id: 'selectAll', label: '全选' },
  { id: 'delete', label: '删除' },
  { id: 'more', label: '更多' },
] as const;

type ItemId = (typeof ITEMS)[number]['id'];

const OUTER_R = 104;
const INNER_R = 54;
const SECTOR_GAP_DEG = 3;
const SECTORS = ITEMS.length;

// Sector i is centred on angle i*45deg, measured clockwise from the top.
function sectorIndexAt(dx: number, dy: number): number | null {
  if (Math.hypot(dx, dy) < INNER_R) return null;
  const deg = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360 + 360 / SECTORS / 2) % 360;
  return Math.floor(deg / (360 / SECTORS));
}

function sectorPath(index: number): string {
  const step = 360 / SECTORS;
  const start = index * step + SECTOR_GAP_DEG / 2 - 90;
  const end = (index + 1) * step - SECTOR_GAP_DEG / 2 - 90;
  const pt = (r: number, deg: number) => {
    const rad = (deg * Math.PI) / 180;
    return `${(OUTER_R + r * Math.cos(rad)).toFixed(2)} ${(OUTER_R + r * Math.sin(rad)).toFixed(2)}`;
  };
  const large = end - start > 180 ? 1 : 0;
  return [
    `M ${pt(OUTER_R, start)}`,
    `A ${OUTER_R} ${OUTER_R} 0 ${large} 1 ${pt(OUTER_R, end)}`,
    `L ${pt(INNER_R, end)}`,
    `A ${INNER_R} ${INNER_R} 0 ${large} 0 ${pt(INNER_R, start)}`,
    'Z',
  ].join(' ');
}

function labelPos(index: number): { x: number; y: number } {
  const angle = ((index + 0.5) * 360) / SECTORS - 90;
  const r = (OUTER_R + INNER_R) / 2;
  return { x: OUTER_R + r * Math.cos((angle * Math.PI) / 180), y: OUTER_R + r * Math.sin((angle * Math.PI) / 180) };
}

type EditableField = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

// The focused editable element, or null when focus is elsewhere.
function focusedEditable(): EditableField | null {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLElement && el.isContentEditable) return el;
  return null;
}

function selectedText(field: EditableField | null): string {
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    return field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0);
  }
  return window.getSelection()?.toString() ?? '';
}

// Runs a radial-menu action on the current focus or selection.
async function runAction(id: ItemId): Promise<void> {
  const field = focusedEditable();
  try {
    switch (id) {
      case 'undo': document.execCommand('undo'); break;
      case 'redo': document.execCommand('redo'); break;
      case 'copy': {
        const text = selectedText(field);
        if (text) await navigator.clipboard.writeText(text);
        break;
      }
      case 'cut': {
        const text = selectedText(field);
        if (!text) break;
        await navigator.clipboard.writeText(text);
        if (field) document.execCommand('delete');
        break;
      }
      case 'paste': {
        if (!field) break;
        const text = await navigator.clipboard.readText();
        document.execCommand('insertText', false, text);
        break;
      }
      case 'selectAll': document.execCommand('selectAll'); break;
      case 'delete': if (field) document.execCommand('delete'); break;
      case 'more': break;
    }
  } catch (err) {
    console.warn(`radial menu action "${id}" failed`, err);
  }
}

type CursorMode = 'default' | 'hover' | 'down' | 'system';

// Targets whose semantic CSS cursor (text I-beam, resize arrows, not-allowed, grab, ...)
// must be shown by the system, so the ring is hidden there. Matches the rules in effects-demo.css.
const SYSTEM_CURSOR_SELECTOR = [
  'input', 'textarea', '[contenteditable="true"]', '[contenteditable=""]',
  '[role="separator"]', '.dv-sash', '[class*="resize-handle"]', '.chat-splitter',
  'button:disabled', '[aria-disabled="true"]', '[aria-busy="true"]',
  '[draggable="true"]', '[class*="rc-cursor-"]',
].join(', ');

function isSystemCursorTarget(target: EventTarget | null): target is Element {
  return target instanceof Element && !!target.closest(SYSTEM_CURSOR_SELECTOR);
}

function isInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('a, button, [role="button"], select, summary, label');
}

export default function RadialCursor() {
  const ringRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<CursorMode>('default');
  const [menu, setMenu] = useState<{ x: number; y: number; hover: number | null } | null>(null);
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const [enabled] = useState(() => window.matchMedia('(pointer: fine)').matches);

  useEffect(() => {
    if (!enabled) return;
    document.documentElement.classList.add('rc-enabled');
    const onMove = (e: MouseEvent) => {
      if (ringRef.current) ringRef.current.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
      const m = menuRef.current;
      if (m) {
        const idx = sectorIndexAt(e.clientX - m.x, e.clientY - m.y);
        if (idx !== m.hover) setMenu({ ...m, hover: idx });
      }
    };
    const onOver = (e: MouseEvent) => {
      if (menuRef.current) return;
      if (isSystemCursorTarget(e.target)) setMode('system');
      else if (isInteractive(e.target)) setMode('hover');
      else setMode('default');
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 2 || e.shiftKey) return;
      e.preventDefault();
      setMode('down');
      setMenu({ x: e.clientX, y: e.clientY, hover: null });
    };
    const onUp = (e: MouseEvent) => {
      const m = menuRef.current;
      if (!m || e.button !== 2) return;
      const idx = sectorIndexAt(e.clientX - m.x, e.clientY - m.y);
      setMenu(null);
      setMode('default');
      if (idx !== null) void runAction(ITEMS[idx].id);
    };
    const onContext = (e: MouseEvent) => {
      if (e.shiftKey) return;
      e.preventDefault();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenu(null);
        setMode('default');
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseover', onOver);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('contextmenu', onContext);
    window.addEventListener('keydown', onKey);
    return () => {
      document.documentElement.classList.remove('rc-enabled');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseover', onOver);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('contextmenu', onContext);
      window.removeEventListener('keydown', onKey);
    };
  }, [enabled]);

  if (!enabled) return null;

  const hoverItem = menu?.hover != null ? ITEMS[menu.hover] : null;

  return (
    <>
      <div ref={ringRef} className={`rc-ring rc-${menu ? 'menu' : mode}`} aria-hidden="true">
        <span className="rc-dot" />
      </div>
      {menu && (
        <div className="rc-menu" style={{ left: menu.x - OUTER_R, top: menu.y - OUTER_R }} role="menu">
          <svg width={OUTER_R * 2} height={OUTER_R * 2} viewBox={`0 0 ${OUTER_R * 2} ${OUTER_R * 2}`}>
            {ITEMS.map((item, i) => {
              const p = labelPos(i);
              return (
                <g key={item.id} className={menu.hover === i ? 'rc-sector is-hover' : 'rc-sector'}>
                  <path d={sectorPath(i)} />
                  <text x={p.x} y={p.y} textAnchor="middle" dominantBaseline="middle">{item.label}</text>
                </g>
              );
            })}
          </svg>
          <div className="rc-center">{hoverItem ? hoverItem.label : '松开取消'}</div>
        </div>
      )}
    </>
  );
}
