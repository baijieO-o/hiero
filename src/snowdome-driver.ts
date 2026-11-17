import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SnowdomeIntent, SnowdomeObservation } from './snowdome-adapter.js';
import type { ModelToolDefinition } from './model-gateway.js';
import type { SkillDetail } from './capability-router.js';

/** Capabilities a driver may use. Every call is checked against hot-plug switches by the runtime before it reaches here. */
export interface DriverContext {
  /** Single-shot model request for planning, routed through the same gateway as chat. */
  ask(prompt: string): Promise<string>;
  loadSkill(name: string): Promise<SkillDetail | undefined>;
  searchTools(query: string): Promise<ModelToolDefinition[]>;
  callTool(name: string, input: unknown): Promise<unknown>;
}

/** A third-party driver: it plans off the observation path and returns intents; the adapter validates and paces them. */
export interface SnowdomeDriver {
  onDayStart?(dayIndex: number): void | Promise<void>;
  onObservation(observation: SnowdomeObservation): SnowdomeIntent[] | Promise<SnowdomeIntent[]>;
}

export const DRIVERS_DIR = join(homedir(), '.hiero', 'drivers');

/**
 * Resolves a driver file name inside the drivers directory. Only bare file names are accepted; anything that
 * would escape the directory (absolute paths, `..`, separators) is rejected before any import happens.
 */
export function resolveDriverPath(fileName: string, driversDir = DRIVERS_DIR): string {
  if (!fileName || isAbsolute(fileName) || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
    throw new Error(`驱动文件名不合法：${fileName}`);
  }
  const root = resolve(driversDir);
  const target = resolve(root, fileName);
  if (!target.startsWith(root + sep)) throw new Error(`驱动路径越界：${fileName}`);
  return target;
}

export async function loadDriver(fileName: string, context: DriverContext, driversDir = DRIVERS_DIR): Promise<SnowdomeDriver> {
  const path = resolveDriverPath(fileName, driversDir);
  const mod = await import(pathToFileURL(path).href) as { default?: (ctx: DriverContext) => SnowdomeDriver };
  if (typeof mod.default !== 'function') throw new Error(`驱动必须默认导出一个工厂函数：${fileName}`);
  const driver = mod.default(context);
  if (typeof driver?.onObservation !== 'function') throw new Error(`驱动缺少 onObservation：${fileName}`);
  return driver;
}

