import { useEffect, useRef, type ReactElement } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export type TerminalWriteLine =
  | { kind: 'banner'; text: string }
  | { kind: 'command'; prompt: string; text: string }
  | { kind: 'output'; text: string; failed: boolean };

const THEME = {
  background: '#0c0c0c',
  foreground: '#cccccc',
  cursor: '#f2f2f2',
  cursorAccent: '#0c0c0c',
  selectionBackground: '#264f78',
  black: '#0c0c0c',
  red: '#e74856',
  green: '#16c60c',
  yellow: '#f9f1a5',
  blue: '#3b78ff',
  magenta: '#b4009e',
  cyan: '#61d6d6',
  white: '#cccccc',
  brightBlack: '#767676',
  brightRed: '#e74856',
  brightGreen: '#16c60c',
  brightYellow: '#f9f1a5',
  brightBlue: '#3b78ff',
  brightMagenta: '#b4009e',
  brightCyan: '#61d6d6',
  brightWhite: '#f2f2f2',
};

const toTerminalText = (line: TerminalWriteLine): string => {
  const body = line.text.replace(/\r?\n/g, '\r\n');
  if (line.kind === 'banner') return `${body}\r\n`;
  if (line.kind === 'command') return `\x1b[97m${line.prompt}\x1b[0m ${body}\r\n`;
  return line.failed ? `\x1b[91m${body}\x1b[0m\r\n` : `${body}\r\n`;
};

// Writes only the lines added since the last render, so the xterm buffer stays in sync with the list.
export function TerminalView({ lines, hidden, onActivate }: { lines: TerminalWriteLine[]; hidden: boolean; onActivate?: () => void }): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenRef = useRef(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      cursorBlink: false,
      cursorStyle: 'bar',
      disableStdin: true,
      convertEol: false,
      scrollback: 10000,
      fontSize: 13,
      lineHeight: 1.2,
      fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    const observer = new ResizeObserver(() => {
      if (host.offsetWidth > 0 && host.offsetHeight > 0) fit.fit();
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      writtenRef.current = 0;
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    for (const line of lines.slice(writtenRef.current)) term.write(toTerminalText(line));
    writtenRef.current = lines.length;
  }, [lines]);

  useEffect(() => {
    if (!hidden) fitRef.current?.fit();
  }, [hidden]);

  return <div ref={hostRef} className="terminal-xterm" hidden={hidden} onClick={() => { if (!window.getSelection()?.toString()) onActivate?.(); }} />;
}
