/**
 * Line-level diff that groups changes into hunks, so a user can accept or reject each one.
 * Applying a chosen subset of hunks rebuilds the file from the original lines.
 */

export interface Hunk {
  id: number;
  /** Line index in the original text where this hunk starts. */
  originalStart: number;
  /** Original lines removed by this hunk. */
  removed: string[];
  /** Replacement lines inserted by this hunk. */
  added: string[];
}

const MAX_DIFF_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

/** Computes hunks between two texts. Large inputs fall back to a single whole-file hunk. */
export function computeHunks(original: string, modified: string): Hunk[] {
  const a = splitLines(original);
  const b = splitLines(modified);
  if (original === modified) return [];
  if (a.length * b.length > MAX_DIFF_CELLS) {
    return [{ id: 0, originalStart: 0, removed: a, added: b }];
  }

  // Longest common subsequence table; trims shared prefix/suffix first to keep it small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = midA[i] === midB[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  let i = 0;
  let j = 0;
  const flush = () => {
    if (current) hunks.push(current);
    current = undefined;
  };
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      flush();
      i++;
      j++;
      continue;
    }
    if (!current) current = { id: hunks.length, originalStart: start + i, removed: [], added: [] };
    if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      current.added.push(midB[j]!);
      j++;
    } else {
      current.removed.push(midA[i]!);
      i++;
    }
  }
  flush();
  return hunks;
}

/** Rebuilds the text from the original, applying only the hunks whose ids are listed. */
export function applyHunks(original: string, hunks: readonly Hunk[], acceptedIds: ReadonlySet<number>): string {
  const lines = splitLines(original);
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    if (!acceptedIds.has(hunk.id)) continue;
    out.push(...lines.slice(cursor, hunk.originalStart));
    out.push(...hunk.added);
    cursor = hunk.originalStart + hunk.removed.length;
  }
  out.push(...lines.slice(cursor));
  return out.join('\n');
}
