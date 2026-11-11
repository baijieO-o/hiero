import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SecretStore, type SecretName } from './secret-store.js';

const LOCAL_FILES = ['.env', 'hiero-llm.local.ps1'];
const SAVE_FILE = '.env';
/** Env lines that carry secrets. Their values live in the encrypted store, not in .env. */
const SECRET_ENV_KEYS: readonly SecretName[] = ['HIERO_LLM_TOKENS', 'HIERO_LLM_PROVIDERS', 'HIERO_BRAVE_API_KEY'];

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
 * Secret lines are never written here; they go to the encrypted SecretStore.
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
 * Moves secret values from .env into the SecretStore, then removes those lines from .env.
 * A backup copy (.env.bak) is written first. Existing store values are not overwritten.
 * Returns the names that were migrated.
 */
export function migrateEnvSecrets(store: SecretStore, root = process.cwd()): SecretName[] {
  const path = join(root, SAVE_FILE);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const parsed = parseEnvText(text);
  const pending = SECRET_ENV_KEYS.filter((name) => parsed[name] !== undefined && parsed[name] !== '' && !store.has(name));
  const migrated: SecretName[] = [];
  if (pending.length > 0) {
    copyFileSync(path, `${path}.bak`);
    for (const name of pending) {
      store.set(name, parsed[name] ?? '');
      migrated.push(name);
    }
  }
  const secretKeys = new Set<string>(SECRET_ENV_KEYS);
  const ownsStoredValue = (key: string) => secretKeys.has(key) && store.has(key as SecretName);
  const kept = text.split(/\r?\n/).filter((line) => {
    const match = /^(?:\$env:|export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line.trim());
    return !(match && ownsStoredValue(match[1] ?? ''));
  });
  if (kept.join('\n') !== text) writeFileSync(path, kept.join('\n'), 'utf8');
  return migrated;
}

/**
 * Loads LLM settings from local files into process.env.
 * Secrets come from the SecretStore first. Variables already set in the process environment take precedence.
 */
export function loadLocalLlmEnv(root = process.cwd(), store?: SecretStore): string[] {
  const loaded: string[] = [];
  if (store) {
    for (const name of SECRET_ENV_KEYS) {
      if (process.env[name] !== undefined) continue;
      const value = store.get(name);
      if (value === undefined) continue;
      process.env[name] = value;
      loaded.push(name);
    }
  }
  for (const file of LOCAL_FILES) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const values = parseEnvText(readFileSync(path, 'utf8'));
    for (const [key, value] of Object.entries(values)) {
      if (!key.startsWith('HIERO_LLM_')) continue;
      if (process.env[key] !== undefined) continue;
      if (store?.has(key as SecretName)) continue;
      process.env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}
