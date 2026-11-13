import type { DetailedHTMLProps, HTMLAttributes } from 'react';

// Electron's <webview> element, available only inside the desktop shell.
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement> & { src?: string; partition?: string; allowpopups?: string }, HTMLElement>;
    }
  }
}
