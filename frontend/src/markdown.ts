import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

const DIAGRAM_LANGUAGES = new Set(['mermaid', 'markmap']);

/** Wraps fenced code in a header showing the language and a copy button. Diagram blocks are left for diagram-render. */
const renderer = {
  code({ text, lang }: { text: string; lang?: string }): string {
    const language = (lang ?? '').trim().split(/\s+/)[0].toLowerCase();
    if (DIAGRAM_LANGUAGES.has(language)) {
      return `<pre><code class="language-${language}">${escapeHtml(text)}</code></pre>\n`;
    }
    const label = language || 'text';
    const langClass = language ? ` class="language-${escapeHtml(language)}"` : '';
    return `<div class="code-block"><div class="code-block-head"><span class="code-block-lang">${escapeHtml(label)}</span><button type="button" class="code-copy" data-copy-code>复制</button></div><pre><code${langClass}>${escapeHtml(text)}</code></pre></div>\n`;
  },
};
marked.use({ renderer });

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function renderMarkdown(source: string): string {
  return DOMPurify.sanitize(marked.parse(source, { async: false }) as string);
}

/**
 * Splits streaming text into finished blocks and an unfinished tail.
 * A block ends at a blank line outside a code fence. The tail is whatever follows the last such boundary.
 */
export function splitStreamingBlocks(source: string): { done: string[]; tail: string } {
  const done: string[] = [];
  let current = '';
  let inFence = false;
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const isLast = index === lines.length - 1;
    if (!inFence && line.trim() === '' && !isLast) {
      if (current.trim()) done.push(current);
      current = '';
      continue;
    }
    current += (current ? '\n' : '') + line;
  }
  return { done, tail: current };
}

/** Renders an unfinished block tolerantly: an open code fence is closed so the code still shows as code. */
export function renderPartialMarkdown(source: string): string {
  const fences = source.match(/^\s*(```|~~~)/gm)?.length ?? 0;
  const closed = fences % 2 === 1 ? `${source}\n\`\`\`` : source;
  return renderMarkdown(closed);
}

/** Copies the code of a clicked copy button. Returns true when the click was handled. */
export function handleCodeCopy(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const button = target.closest<HTMLButtonElement>('button[data-copy-code]');
  if (!button) return false;
  const code = button.closest('.code-block')?.querySelector('code')?.textContent ?? '';
  void navigator.clipboard?.writeText(code).then(() => {
    button.textContent = '已复制';
    window.setTimeout(() => { button.textContent = '复制'; }, 1500);
  });
  return true;
}
