import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { z } from 'zod';
import type { RegisteredTool } from './tool-gateway.js';

/**
 * Lightweight code index: regex-based symbol extraction over a bounded set of source files.
 * It is not an AST or LSP index. Overloads, re-exports and dynamic symbols are not resolved.
 */

export interface SymbolEntry {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'method';
  path: string;
  line: number;
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']);
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '__pycache__']);
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 512 * 1024;

const DECLARATION_PATTERNS: Array<{ kind: SymbolEntry['kind']; pattern: RegExp }> = [
  { kind: 'class', pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'interface', pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'type', pattern: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/ },
  { kind: 'enum', pattern: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'function', pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
  { kind: 'const', pattern: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|[A-Za-z_$][\w$]*\s*=>|function\b)/ },
  { kind: 'function', pattern: /^\s*def\s+([A-Za-z_]\w*)\s*\(/ },
  { kind: 'class', pattern: /^\s*class\s+([A-Za-z_]\w*)\s*[:(]/ },
];

export function extractSymbols(path: string, source: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const lines = source.split(/\r?\n/);
  lines.forEach((text, index) => {
    for (const { kind, pattern } of DECLARATION_PATTERNS) {
      const match = pattern.exec(text);
      if (match?.[1]) {
        symbols.push({ name: match[1], kind, path, line: index + 1 });
        break;
      }
    }
  });
  return symbols;
}

async function collectSourceFiles(root: string, dir: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    if (entry.name.startsWith('.') && entry.name !== '.') {
      if (IGNORED_DIRS.has(entry.name)) continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await collectSourceFiles(root, full, out);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      out.push(full);
    }
  }
}

export class CodeIndex {
  private symbols: SymbolEntry[] = [];
  private files = 0;
  private built = false;

  constructor(private readonly root: string) {}

  /** Rebuilds the index. Called lazily on the first query and by `refresh()`. */
  public async build(): Promise<void> {
    const files: string[] = [];
    await collectSourceFiles(this.root, this.root, files);
    const symbols: SymbolEntry[] = [];
    for (const file of files) {
      const info = await stat(file).catch(() => undefined);
      if (!info || info.size > MAX_FILE_BYTES) continue;
      const source = await readFile(file, 'utf8').catch(() => '');
      symbols.push(...extractSymbols(relative(this.root, file).replace(/\\/g, '/'), source));
    }
    this.symbols = symbols;
    this.files = files.length;
    this.built = true;
  }

  public async refresh(): Promise<void> {
    await this.build();
  }

  public async searchSymbols(query: string, limit = 50): Promise<SymbolEntry[]> {
    if (!this.built) await this.build();
    const needle = query.toLowerCase();
    return this.symbols
      .filter((symbol) => symbol.name.toLowerCase().includes(needle))
      .sort((a, b) => Number(b.name.toLowerCase() === needle) - Number(a.name.toLowerCase() === needle))
      .slice(0, Math.max(1, Math.min(limit, 200)));
  }

  public async stats(): Promise<{ files: number; symbols: number }> {
    if (!this.built) await this.build();
    return { files: this.files, symbols: this.symbols.length };
  }
}

/** Read-only tool that lets the model find declarations by name without grepping the whole tree. */
export function createSymbolSearchTool(index: CodeIndex): RegisteredTool<{ query: string; limit?: number | undefined }, { symbols: SymbolEntry[] }> {
  return {
    name: 'symbol_search',
    inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().optional() }),
    effect: 'read',
    execute: async ({ query, limit }) => ({ symbols: await index.searchSymbols(query, limit) }),
  };
}
