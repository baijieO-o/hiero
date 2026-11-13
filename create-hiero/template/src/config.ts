import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface ModelParams {
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
}

export interface HieroConfig {
  models: {
    defaults: ModelParams;
    overrides: Record<string, ModelParams>;
  };
  logging: {
    file?: string;
  };
}

export const DEFAULT_CONFIG: HieroConfig = {
  models: { defaults: {}, overrides: {} },
  logging: {},
};

interface LayerSource {
  path: string;
  text?: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOrUndefined(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

function parseParams(raw: unknown): ModelParams {
  if (!isRecord(raw)) return {};
  const params: ModelParams = {};
  const temperature = numberOrUndefined(raw.temperature, 0, 2);
  if (temperature !== undefined) params.temperature = temperature;
  const maxTokens = numberOrUndefined(raw.max_tokens, 1, 1_000_000);
  if (maxTokens !== undefined) params.max_tokens = Math.floor(maxTokens);
  const topP = numberOrUndefined(raw.top_p, 0, 1);
  if (topP !== undefined) params.top_p = topP;
  return params;
}

/** Parses one JSON layer. Invalid fields are ignored so a typo never blocks startup. */
export function parseConfigLayer(text: string): Partial<HieroConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
  if (!isRecord(raw)) return {};
  const result: Partial<HieroConfig> = {};
  if (isRecord(raw.models)) {
    const overrides: Record<string, ModelParams> = {};
    if (isRecord(raw.models.overrides)) {
      for (const [model, params] of Object.entries(raw.models.overrides)) overrides[model] = parseParams(params);
    }
    result.models = { defaults: parseParams(raw.models.defaults), overrides };
  }
  if (isRecord(raw.logging) && typeof raw.logging.file === 'string' && raw.logging.file.trim()) {
    result.logging = { file: raw.logging.file.trim() };
  }
  return result;
}

/**
 * Merges config layers in order; later layers win. Model overrides merge per model name.
 */
export function mergeConfig(layers: Array<Partial<HieroConfig>>): HieroConfig {
  const merged: HieroConfig = structuredClone(DEFAULT_CONFIG);
  for (const layer of layers) {
    if (layer.models) {
      merged.models.defaults = { ...merged.models.defaults, ...layer.models.defaults };
      for (const [model, params] of Object.entries(layer.models.overrides)) {
        merged.models.overrides[model] = { ...merged.models.overrides[model], ...params };
      }
    }
    if (layer.logging) merged.logging = { ...merged.logging, ...layer.logging };
  }
  return merged;
}

/** Resolves params for one model: defaults, then per-model overrides. */
export function paramsForModel(config: HieroConfig, model: string | undefined): ModelParams {
  const override = model ? config.models.overrides[model] : undefined;
  return { ...config.models.defaults, ...override };
}

export function userConfigPath(home = homedir()): string {
  return join(home, '.hiero', 'config.json');
}

export function workspaceConfigPath(workspace: string): string {
  return join(workspace, '.hiero', 'config.json');
}

/** Env vars keep the highest priority for the values they set. */
export function envOverrides(env: NodeJS.ProcessEnv): Partial<HieroConfig> {
  const result: Partial<HieroConfig> = {};
  if (env.HIERO_LOG_FILE?.trim()) result.logging = { file: env.HIERO_LOG_FILE.trim() };
  return result;
}

function readLayer(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

/** Loads the layers in order: user file, then workspace file, then env vars. */
export function loadConfig(options: { home?: string; workspace?: string; env?: NodeJS.ProcessEnv } = {}): HieroConfig {
  const sources: LayerSource[] = [{ path: userConfigPath(options.home) }];
  if (options.workspace) sources.push({ path: workspaceConfigPath(options.workspace) });
  const layers: Array<Partial<HieroConfig>> = [];
  for (const source of sources) {
    const text = readLayer(source.path);
    if (text !== undefined) layers.push(parseConfigLayer(text));
  }
  layers.push(envOverrides(options.env ?? process.env));
  return mergeConfig(layers);
}

function layerPaths(options: ConfigWatcherOptions): string[] {
  const paths = [userConfigPath(options.home)];
  if (options.workspace) paths.push(workspaceConfigPath(options.workspace));
  return paths;
}

function mtimeOf(path: string): number {
  return existsSync(path) ? statSync(path).mtimeMs : -1;
}

export interface ConfigWatcherOptions {
  home?: string;
  workspace?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Hot-reloads layered config. Each read compares layer file mtimes and reloads only when one changed,
 * so a file created or edited later still takes effect without a restart.
 */
export class ConfigWatcher {
  private config: HieroConfig;
  private readonly watchers: FSWatcher[] = [];
  private mtimes = new Map<string, number>();

  public constructor(private readonly options: ConfigWatcherOptions) {
    this.config = loadConfig(options);
    this.mtimes = this.readMtimes();
  }

  public current(): HieroConfig {
    this.refreshIfChanged();
    return this.config;
  }

  public refreshIfChanged(): boolean {
    const next = this.readMtimes();
    const changed = [...next].some(([path, mtime]) => this.mtimes.get(path) !== mtime);
    this.mtimes = next;
    if (changed) this.config = loadConfig(this.options);
    return changed;
  }

  /** Optional push notification via fs.watch. Reads still check mtimes, so a missed event is harmless. */
  public watch(onChange?: (config: HieroConfig) => void): () => void {
    const dirs = new Set(layerPaths(this.options).map((path) => dirname(path)));
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      try {
        this.watchers.push(watch(dir, () => {
          if (this.refreshIfChanged()) onChange?.(this.config);
        }));
      } catch {
        // Some filesystems cannot watch; reads still reload on mtime change.
      }
    }
    return () => {
      for (const watcher of this.watchers.splice(0)) watcher.close();
    };
  }

  private readMtimes(): Map<string, number> {
    return new Map(layerPaths(this.options).map((path) => [path, mtimeOf(path)]));
  }
}
