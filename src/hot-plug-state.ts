import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const HOT_PLUG_STATE_FILE = join('.hiero', 'hot-plug.json');

/** Only disabled names are stored; anything absent is enabled. */
const stateSchema = z.object({
  disabledSkills: z.array(z.string()).default([]),
  disabledTools: z.array(z.string()).default([]),
});

export type HotPlugState = z.infer<typeof stateSchema>;

export function hotPlugStatePath(root = process.cwd()): string {
  return join(root, HOT_PLUG_STATE_FILE);
}

/** Reads the persisted skill and tool toggles. A missing or unreadable file yields all-enabled. */
export function readHotPlugState(root = process.cwd()): HotPlugState {
  const path = hotPlugStatePath(root);
  if (!existsSync(path)) return { disabledSkills: [], disabledTools: [] };
  try {
    const parsed = stateSchema.safeParse(JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')));
    return parsed.success ? parsed.data : { disabledSkills: [], disabledTools: [] };
  } catch {
    return { disabledSkills: [], disabledTools: [] };
  }
}

export function writeHotPlugState(state: HotPlugState, root = process.cwd()): void {
  const path = hotPlugStatePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(stateSchema.parse(state), null, 2) + '\n', 'utf8');
}