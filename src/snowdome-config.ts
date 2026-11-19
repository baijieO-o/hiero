import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { SNOWDOME_DEFAULT_URL } from './snowdome-adapter.js';

const ResidentSchema = z.object({
  name: z.string().trim().min(1).max(16).default('hiero'),
  url: z.string().min(1).default(SNOWDOME_DEFAULT_URL),
  /** Per-resident persona, the single source the driver reads and rewrites. */
  persona: z.string().max(500).default(''),
  /** File name of the third-party driver inside ~/.hiero/drivers. */
  driver: z.string().min(1).default('snowdome-planner-driver.js'),
});

const SnowdomeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  residents: z.array(ResidentSchema).default([]),
});

export type SnowdomeResidentConfig = z.infer<typeof ResidentSchema>;
export type SnowdomeConfig = z.infer<typeof SnowdomeConfigSchema>;

export const SNOWDOME_NAME = 'snowdome';

/** Hot-plug id for one resident, so each resident can be started, stopped and reported on its own. */
export function snowdomeResidentId(name: string): string {
  return `${SNOWDOME_NAME}:${name}`;
}

/** Config lives beside the other Hiero settings. It holds no secrets; model credentials stay in the existing secret store. */
export function snowdomeConfigPath(home = homedir()): string {
  return join(home, '.hiero', 'snowdome.json');
}

/**
 * Reads the config. The legacy single-resident shape ({ enabled, name, url, autoBehavior }) is upgraded to a one-item list,
 * so an existing snowdome.json keeps working without edits.
 */
export function readSnowdomeConfig(path = snowdomeConfigPath()): SnowdomeConfig {
  if (!existsSync(path)) return SnowdomeConfigSchema.parse({});
  const raw = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
  if (!Array.isArray(raw.residents) && ('name' in raw || 'url' in raw)) {
    const { enabled, ...resident } = raw;
    return SnowdomeConfigSchema.parse({ enabled: enabled ?? false, residents: [resident] });
  }
  return SnowdomeConfigSchema.parse(raw);
}

export const PERSONA_MAX_LENGTH = 500;
/** Minimum gap between two driver rewrites of the same resident's persona, so one remark cannot drift it. */
export const PERSONA_REWRITE_INTERVAL_MS = 10 * 60_000;

export function personaHistoryPath(home = homedir()): string {
  return join(home, '.hiero', 'persona-history.jsonl');
}

/** Current persona for a resident, read from disk on every call so the owner's edits and driver rewrites are both seen. */
export function getResidentPersona(name: string, path = snowdomeConfigPath()): string {
  return readSnowdomeConfig(path).residents.find((resident) => resident.name === name)?.persona ?? '';
}

/**
 * Builds the persona after a driver rewrite. The first line (name and positioning) is kept from the current persona,
 * so only the description below it can change. A resident with no persona yet takes the proposal's first line.
 */
export function composePersona(current: string, proposed: string): string {
  const head = (current.trim() || proposed.trim()).split('\n')[0]?.trim() ?? '';
  const rest = proposed.trim().split('\n').slice(1).join('\n').trim();
  return rest ? `${head}\n${rest}` : head;
}

function lastPersonaRewriteAt(name: string, historyPath: string): number | undefined {
  if (!existsSync(historyPath)) return undefined;
  const entries = readFileSync(historyPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { at: string; resident: string });
  const last = entries.filter((entry) => entry.resident === name).at(-1);
  return last ? Date.parse(last.at) : undefined;
}

export interface PersonaRewriteOptions {
  configPath?: string;
  historyPath?: string;
  now?: number;
}

/**
 * The only path a driver may use to change a persona. It enforces the length limit and the rewrite interval,
 * writes the new persona into snowdome.json, and appends the change to the history file so it can be traced.
 * Returns the persona in effect afterwards; a rejected rewrite throws and leaves the config untouched.
 */
export function rewriteResidentPersona(name: string, proposed: string, options: PersonaRewriteOptions = {}): string {
  const configPath = options.configPath ?? snowdomeConfigPath();
  const historyPath = options.historyPath ?? personaHistoryPath();
  const now = options.now ?? Date.now();
  const config = readSnowdomeConfig(configPath);
  const resident = config.residents.find((item) => item.name === name);
  if (!resident) throw new Error(`找不到居民：${name}`);
  const next = composePersona(resident.persona, proposed);
  if (!next) throw new Error('人设不能为空');
  if (next.length > PERSONA_MAX_LENGTH) throw new Error(`人设不能超过 ${PERSONA_MAX_LENGTH} 字`);
  if (next === resident.persona) return next;
  const lastAt = lastPersonaRewriteAt(name, historyPath);
  if (lastAt !== undefined && now - lastAt < PERSONA_REWRITE_INTERVAL_MS) throw new Error('人设改写过于频繁，请稍后再试');
  saveSnowdomeConfig({ residents: config.residents.map((item) => (item.name === name ? { ...item, persona: next } : item)) }, configPath);
  mkdirSync(dirname(historyPath), { recursive: true });
  appendFileSync(historyPath, `${JSON.stringify({ at: new Date(now).toISOString(), resident: name, before: resident.persona, after: next })}\n`, 'utf8');
  return next;
}

/** Replaces the whole config. Callers merge their change into the current config first. */
export function saveSnowdomeConfig(config: Partial<SnowdomeConfig>, path = snowdomeConfigPath()): SnowdomeConfig {
  const next = SnowdomeConfigSchema.parse({ ...readSnowdomeConfig(path), ...config });
  const names = next.residents.map((resident) => resident.name);
  if (new Set(names).size !== names.length) throw new Error('居民昵称不能重复');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}
