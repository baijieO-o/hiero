import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { SNOWDOME_DEFAULT_URL } from './snowdome-adapter.js';

const ResidentSchema = z.object({
  name: z.string().trim().min(1).max(16).default('hiero'),
  url: z.string().min(1).default(SNOWDOME_DEFAULT_URL),
  autoBehavior: z.boolean().default(true),
  /** Per-resident persona appended to the shared decision prompt; empty means the default persona. */
  persona: z.string().max(500).default(''),
  /** `builtin` uses the model decision; any other value is a file name inside ~/.hiero/drivers. */
  driver: z.string().min(1).default('builtin'),
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
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if (!Array.isArray(raw.residents) && ('name' in raw || 'url' in raw || 'autoBehavior' in raw)) {
    const { enabled, ...resident } = raw;
    return SnowdomeConfigSchema.parse({ enabled: enabled ?? false, residents: [resident] });
  }
  return SnowdomeConfigSchema.parse(raw);
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
