export type DocCategory = 'guide' | 'reference' | 'develop' | 'architecture';

export interface DocEntry {
  id: string;
  title: string;
  category: DocCategory;
  /** Raw Markdown source, used for rendering and search. */
  source?: string;
}

export const DOC_CATEGORIES: { id: DocCategory; label: string }[] = [
  { id: 'guide', label: '入门' },
  { id: 'reference', label: '参考' },
  { id: 'develop', label: '二次开发' },
  { id: 'architecture', label: '架构' },
];

export interface DocHeading {
  level: number;
  text: string;
  anchor: string;
}

/**
 * Extracts ATX headings, skipping fenced code so a `#` comment inside a code block is not a heading.
 * Anchors are stable slugs; duplicates get a numeric suffix.
 */
export function extractHeadings(source: string): DocHeading[] {
  const headings: DocHeading[] = [];
  const seen = new Map<string, number>();
  let inFence = false;
  for (const line of source.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const hashes = match[1] ?? '';
    const text = (match[2] ?? '').replace(/[`*_]/g, '').trim();
    const base = slugify(text) || 'section';
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    headings.push({ level: hashes.length, text, anchor: count === 0 ? base : `${base}-${count}` });
  }
  return headings;
}

function slugify(text: string): string {
  return text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
}

/**
 * Case-insensitive search over title and source. Returns the matching entries plus a short snippet
 * around the first hit in the body, so the list can show why a document matched.
 */
export function searchDocs(entries: DocEntry[], query: string): { entry: DocEntry; snippet: string }[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const results: { entry: DocEntry; snippet: string }[] = [];
  for (const entry of entries) {
    const body = entry.source ?? '';
    const haystack = `${entry.title}\n${body}`.toLowerCase();
    const index = haystack.indexOf(needle);
    if (index < 0) continue;
    results.push({ entry, snippet: makeSnippet(entry.title + '\n' + body, index, needle.length) });
  }
  return results;
}

function makeSnippet(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + length + 60);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}
