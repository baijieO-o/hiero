import { useMemo, useState, type ReactElement } from 'react';
import { DOC_CATEGORIES, extractHeadings, searchDocs, type DocEntry } from './docs-model';
import { DOC_ENTRIES } from './docs-content';
import { handleCodeCopy, renderMarkdown } from './markdown';

export function DocsCenter(): ReactElement {
  const [activeId, setActiveId] = useState(DOC_ENTRIES[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const active = DOC_ENTRIES.find((entry) => entry.id === activeId) ?? DOC_ENTRIES[0];
  const results = useMemo(() => searchDocs(DOC_ENTRIES, query), [query]);
  const headings = useMemo(() => (active?.source ? extractHeadings(active.source) : []), [active]);
  const searching = query.trim().length > 0;

  return <div className="panel-content docs-host"><div className="docs-center">
    <aside className="docs-nav">
      <input
        className="docs-search"
        type="search"
        placeholder="搜索文档"
        aria-label="搜索文档"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {searching ? <SearchResults results={results} onOpen={(id) => { setActiveId(id); setQuery(''); }} /> : DOC_CATEGORIES.map((category) => {
        const entries = DOC_ENTRIES.filter((entry) => entry.category === category.id);
        if (entries.length === 0) return null;
        return <section key={category.id} className="docs-nav-group">
          <h4>{category.label}</h4>
          {entries.map((entry) => <button
            key={entry.id}
            type="button"
            className={`docs-nav-item${entry.id === active?.id ? ' active' : ''}`}
            aria-current={entry.id === active?.id ? 'page' : undefined}
            onClick={() => setActiveId(entry.id)}
          >{entry.title}</button>)}
        </section>;
      })}
    </aside>
    <article className="docs-body">
      {active ? <>
        <DocBody entry={active} />
        {headings.length > 0 && <nav className="docs-toc" aria-label="本页目录">
          {headings.filter((h) => h.level <= 3).map((h) => <a key={h.anchor} href={`#${h.anchor}`} className={`docs-toc-level-${h.level}`}>{h.text}</a>)}
        </nav>}
      </> : <p className="docs-empty">暂无文档</p>}
    </article>
  </div></div>;
}

function DocBody({ entry }: { entry: DocEntry }): ReactElement {
  const html = useMemo(() => renderMarkdown(entry.source ?? '').replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>'), [entry.source]);
  return <div className="docs-markdown" onClick={(event) => handleCodeCopy(event.target)} dangerouslySetInnerHTML={{ __html: html }} />;
}

function SearchResults({ results, onOpen }: { results: { entry: DocEntry; snippet: string }[]; onOpen: (id: string) => void }): ReactElement {
  if (results.length === 0) return <p className="docs-empty">没有匹配的文档</p>;
  return <ul className="docs-search-results">
    {results.map(({ entry, snippet }) => <li key={entry.id}>
      <button type="button" onClick={() => onOpen(entry.id)}>
        <strong>{entry.title}</strong>
        <span>{snippet}</span>
      </button>
    </li>)}
  </ul>;
}
