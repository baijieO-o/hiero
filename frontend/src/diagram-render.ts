import mermaid from 'mermaid';
import { Transformer } from 'markmap-lib';
import { Markmap } from 'markmap-view';

const markmapTransformer = new Transformer();
let mermaidReady = false;
let renderCounter = 0;

/** Finds `<pre><code class="language-KIND">` blocks produced by renderMarkdown. */
export function findCodeBlocks(root: ParentNode, language: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`pre > code.language-${language}`)).map((code) => code.parentElement as HTMLElement);
}

function ensureMermaid(): void {
  if (mermaidReady) return;
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' });
  mermaidReady = true;
}

/** Replaces each mermaid code block under `root` with a rendered SVG diagram. Failed blocks keep their source. */
export async function renderMermaidBlocks(root: HTMLElement): Promise<void> {
  const blocks = findCodeBlocks(root, 'mermaid');
  if (blocks.length === 0) return;
  ensureMermaid();
  for (const pre of blocks) {
    const source = pre.textContent ?? '';
    try {
      const { svg } = await mermaid.render(`hiero-mermaid-${++renderCounter}`, source);
      const wrapper = document.createElement('div');
      wrapper.className = 'diagram-block mermaid-block';
      wrapper.innerHTML = svg;
      pre.replaceWith(wrapper);
    } catch {
      pre.classList.add('diagram-error');
    }
  }
}

/** Replaces each markmap code block under `root` with an interactive mind map. Returns the created instances for cleanup. */
export function renderMarkmaps(root: HTMLElement): Markmap[] {
  const instances: Markmap[] = [];
  for (const pre of findCodeBlocks(root, 'markmap')) {
    const source = pre.textContent ?? '';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('markmap-svg');
    const wrapper = document.createElement('div');
    wrapper.className = 'diagram-block markmap-block';
    wrapper.appendChild(svg);
    pre.replaceWith(wrapper);
    const { root: tree } = markmapTransformer.transform(source);
    instances.push(Markmap.create(svg, { duration: 0, fitRatio: 0.95 }, tree));
  }
  return instances;
}
