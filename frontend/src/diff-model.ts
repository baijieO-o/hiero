export type DiffLineKind = 'same' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/** Line-level diff via LCS. Inputs are capped by callers, so the O(n*m) table stays small. */
export function diffLines(original: string, modified: string): DiffLine[] {
  const a = original === '' ? [] : original.split('\n');
  const b = modified === '' ? [] : modified.split('\n');
  const n = a.length;
  const m = b.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  const at = (i: number, j: number): number => table[i]?.[j] ?? 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = a[i] ?? '';
    const bj = b[j] ?? '';
    if (ai === bj) {
      lines.push({ kind: 'same', text: ai });
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      lines.push({ kind: 'del', text: ai });
      i += 1;
    } else {
      lines.push({ kind: 'add', text: bj });
      j += 1;
    }
  }
  while (i < n) lines.push({ kind: 'del', text: a[i++] ?? '' });
  while (j < m) lines.push({ kind: 'add', text: b[j++] ?? '' });
  return lines;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === 'add') added += 1;
    else if (line.kind === 'del') removed += 1;
  }
  return { added, removed };
}
