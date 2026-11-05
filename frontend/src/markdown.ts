import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import katex from 'katex';

marked.setOptions({ gfm: true, breaks: true });

const DIAGRAM_LANGUAGES = new Set(['mermaid', 'markmap']);

/**
 * Splits highlighted HTML into per-line spans so each line can fade in and get a line number.
 * highlight.js spans can run across newlines, so open spans are closed at each line end and reopened on the next.
 */
function splitHighlightedLines(html: string): string {
  const open: string[] = [];
  return html.split('\n').map((line, index) => {
    const prefix = open.join('');
    const tags = line.match(/<span[^>]*>|<\/span>/g) ?? [];
    for (const tag of tags) {
      if (tag === '</span>') open.pop();
      else open.push(tag);
    }
    const closers = '</span>'.repeat(open.length);
    return `<span class="code-line" data-line="${index + 1}" style="--line-index:${index}">${prefix}${line}${closers}</span>`;
  }).join('\n');
}

/** Wraps fenced code in a header with the language and a copy button. Diagram blocks are left for diagram-render. */
const renderer = {
  code({ text, lang }: { text: string; lang?: string }): string {
    const language = (lang ?? '').trim().split(/\s+/)[0].toLowerCase();
    if (DIAGRAM_LANGUAGES.has(language)) {
      return `<pre><code class="language-${language}">${escapeHtml(text)}</code></pre>\n`;
    }
    const label = language || 'text';
    const known = language && hljs.getLanguage(language);
    const highlighted = known ? hljs.highlight(text, { language }).value : escapeHtml(text);
    const langClass = language ? ` class="language-${escapeHtml(language)} hljs"` : '';
    return `<div class="code-block"><div class="code-block-head"><span class="code-block-lang">${escapeHtml(label)}</span><button type="button" class="code-copy" data-copy-code>复制</button></div><pre><code${langClass}>${splitHighlightedLines(highlighted)}</code></pre></div>\n`;
  },
  image({ href, title, text }: { href: string; title?: string | null; text: string }): string {
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    return `<span class="chat-image"><img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${titleAttr} loading="lazy" /></span>`;
  },
  link({ href, title, text }: { href: string; title?: string | null; text: string }): string {
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    return `<a href="${escapeHtml(href)}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
  },
};
marked.use({ renderer });

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Replaces $$...$$ and $...$ math with KaTeX output. Math that does not parse is left as source. */
function renderMath(source: string): string {
  const render = (tex: string, displayMode: boolean): string => {
    try {
      return katex.renderToString(tex, { displayMode, throwOnError: true, output: 'html' });
    } catch {
      return escapeHtml(displayMode ? `$$${tex}$$` : `$${tex}$`);
    }
  };
  // Code blocks are split out first so a literal "$" in code is never treated as math.
  return source.split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/).map((part, index) => {
    if (index % 2 === 1) return part;
    return part
      .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex: string) => `<span class="chat-math chat-math-block">${render(tex.trim(), true)}</span>`)
      .replace(/(^|[^\\$])\$([^\n$]+?)\$/g, (_, prefix: string, tex: string) => `${prefix}<span class="chat-math">${render(tex, false)}</span>`);
  }).join('');
}

/** Shows a standalone link (a paragraph that is only the link) as a preview card with its domain. */
function linkCard(href: string, text: string): string | undefined {
  let domain: string;
  try {
    domain = new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
  return `<a class="chat-link-card" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"><span class="chat-link-domain">${escapeHtml(domain)}</span><span class="chat-link-title">${escapeHtml(text)}</span></a>`;
}

export function renderMarkdown(source: string): string {
  const html = renderMath(marked.parse(source, { async: false }) as string).replace(
    /<p><a href="([^"]+)"[^>]*>([^<]+)<\/a><\/p>/g,
    (match, href: string, text: string) => linkCard(href.replace(/&amp;/g, '&'), text) ?? match,
  );
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'loading'],
  });
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
