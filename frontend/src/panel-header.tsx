import type { ReactElement } from 'react';

export function PanelHeader({ eyebrow, title }: { eyebrow: string; title: string }): ReactElement {
  return <header className="panel-header"><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></header>;
}
