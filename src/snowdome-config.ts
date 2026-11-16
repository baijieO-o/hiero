import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { SNOWDOME_DEFAULT_URL } from './snowdome-adapter.js';

const SnowdomeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  actorId: z.string().min(1).default('hiero'),
  url: z.string().min(1).default(SNOWDOME_DEFAULT_URL),
  autoBehavior: z.boolean().default(true),
});

export type SnowdomeConfig = z.infer<typeof SnowdomeConfigSchema>;

export const SNOWDOME_NAME = 'snowdome';

/** Config lives beside the other Hiero settings. It holds no secrets; model credentials stay in the existing secret store. */
export function snowdomeConfigPath(home = homedir()): string {
  return join(home, '.hiero', 'snowdome.json');
}

export function readSnowdomeConfig(path = snowdomeConfigPath()): SnowdomeConfig {
  if (!existsSync(path)) return SnowdomeConfigSchema.parse({});
  return SnowdomeConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function saveSnowdomeConfig(config: Partial<SnowdomeConfig>, path = snowdomeConfigPath()): SnowdomeConfig {
  const next = SnowdomeConfigSchema.parse({ ...readSnowdomeConfig(path), ...config });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}
