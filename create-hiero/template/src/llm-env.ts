import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCAL_FILES = ['.env', 'hiero-llm.local.ps1'];
const SAVE_FILE = '.env';

/** Appends /chat/completions when the user typed only a base URL. */
export function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

/** Turns a chat-completions endpoint or a bare base URL into the matching `/models` URL. */
export function modelsEndpoint(raw: string): string {
  const base = normalizeEndpoint(raw).replace(/\/chat\/completions$/, '');
  return base ? `${base}/models` : '';
}

/**
 * Rewrites HIERO_LLM_* lines in .env, keeping every other line untouched.
 * .env is gitignored, so tokens stay out of version control.
 */
export function writeLocalEnv(values: Record<string, string>, root = process.cwd()): void {
  const path = join(root, SAVE_FILE);
  const existing = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  const kept = existing.filter((line) => !/^\s*HIERO_LLM_[A-Z_]+\s*=/.test(line));
  while (kept.length > 0 && kept.at(-1)?.trim() === '') kept.pop();
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  writeFileSync(path, [...kept, ...lines].join('\n') + '\n', 'utf8');
}

export function parseEnvText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:\$env:|export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = (match[2] ?? '').trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    if (key) result[key] = value;
  }
  return result;
}

/**
 * Loads LLM settings from local files into process.env.
 * Variables already set in the process environment take precedence.
 */
export function loadLocalLlmEnv(root = process.cwd()): string[] {
  const loaded: string[] = [];
  for (const file of LOCAL_FILES) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const values = parseEnvText(readFileSync(path, 'utf8'));
    for (const [key, value] of Object.entries(values)) {
      if (!key.startsWith('HIERO_LLM_')) continue;
      if (process.env[key] !== undefined) continue;
      process.env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}
