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

// Hook for the menu actions. Add cases here as features are wired up.
function runAction(id: ItemId): void {
  switch (id) {
    case 'undo': document.execCommand('undo'); break;
    case 'redo': document.execCommand('redo'); break;
    case 'cut': document.execCommand('cut'); break;
    case 'copy': document.execCommand('copy'); break;
    case 'paste': document.execCommand('paste'); break;
    case 'selectAll': document.execCommand('selectAll'); break;
    case 'delete': document.execCommand('delete'); break;
    case 'more': break;
  }
}

function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) return true;
  return false;
}

function isInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('a, button, [role="button"], select, summary, label');
}

export default function RadialCursor() {
  const ringRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<'default' | 'hover' | 'text' | 'down'>('default');
  const [menu, setMenu] = useState<{ x: number; y: number; hover: number | null } | null>(null);
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const [enabled] = useState(() => window.matchMedia('(pointer: fine)').matches);

  useEffect(() => {
    if (!enabled) return;
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
      if (isTextInput(e.target)) setMode('text');
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
      if (idx !== null) runAction(ITEMS[idx].id);
      setMenu(null);
      setMode('default');
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
      <div ref={ringRef} className={`rc-ring rc-${mode}`} aria-hidden="true">
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
