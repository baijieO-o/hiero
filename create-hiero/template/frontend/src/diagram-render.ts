import type { Markmap as MarkmapType } from 'markmap-view';
import type { Transformer as TransformerType } from 'markmap-lib';

type MarkmapModule = typeof import('markmap-view');
type MarkmapLibModule = typeof import('markmap-lib');
type MermaidModule = typeof import('mermaid');

// Mermaid and markmap are large. Load them only when a message actually contains one of these blocks.
let markmapLoad: Promise<{ markmap: MarkmapModule; lib: MarkmapLibModule }> | null = null;
let mermaidLoad: Promise<MermaidModule['default']> | null = null;
let markmapTransformer: TransformerType | null = null;
let mermaidReady = false;
let renderCounter = 0;

function loadMarkmap(): Promise<{ markmap: MarkmapModule; lib: MarkmapLibModule }> {
  markmapLoad ??= Promise.all([import('markmap-view'), import('markmap-lib')]).then(([markmap, lib]) => ({ markmap, lib }));
  return markmapLoad;
}

function loadMermaid(): Promise<MermaidModule['default']> {
  mermaidLoad ??= import('mermaid').then((module) => module.default);
  return mermaidLoad;
}

/** Finds `<pre><code class="language-KIND">` blocks produced by renderMarkdown. */
export function findCodeBlocks(root: ParentNode, language: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`pre > code.language-${language}`)).map((code) => code.parentElement as HTMLElement);
}

/** Replaces each mermaid code block under `root` with a rendered SVG diagram. Failed blocks keep their source. */
export async function renderMermaidBlocks(root: HTMLElement): Promise<void> {
  const blocks = findCodeBlocks(root, 'mermaid');
  if (blocks.length === 0) return;
  const mermaid = await loadMermaid();
  if (!mermaidReady) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' });
    mermaidReady = true;
  }
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
export async function renderMarkmaps(root: HTMLElement): Promise<MarkmapType[]> {
  const blocks = findCodeBlocks(root, 'markmap');
  const instances: MarkmapType[] = [];
  if (blocks.length === 0) return instances;
  const { markmap, lib } = await loadMarkmap();
  markmapTransformer ??= new lib.Transformer();
  for (const pre of blocks) {
    const source = pre.textContent ?? '';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('markmap-svg');
    const wrapper = document.createElement('div');
    wrapper.className = 'diagram-block markmap-block';
    wrapper.appendChild(svg);
    pre.replaceWith(wrapper);
    const { root: tree } = markmapTransformer.transform(source);
    instances.push(markmap.Markmap.create(svg, { duration: 0, fitRatio: 0.95 }, tree));
  }
  return instances;
}
