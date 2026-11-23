import type { McpServerConfig, McpServerStatus, McpToolClient } from './mcp-client.js';
import { mcpToolDefinition } from './mcp-client.js';
import { readHotPlugState, writeHotPlugState } from './hot-plug-state.js';
import { DEFAULT_RETRY_POLICY, PlugRunner, type PlugState, type RetryPolicy } from './hot-plug-runner.js';
import { mcpCapability, toggledCapability, type CapabilityEntry } from './capability-summary.js';

export type PlugKind = 'mcp' | 'tool' | 'skill' | 'adapter';

/** A world adapter. `start` connects and returns; `stop` disconnects. Enabling and disabling mirror MCP servers. */
export interface AdapterPlug {
  start(): Promise<void>;
  stop(): void;
}

export interface PlugStatus {
  id: string;
  kind: PlugKind;
  name: string;
  enabled: boolean;
  /** Present only for enabled plugs. 'starting' before the first attempt ends, 'retrying' while backing off. */
  state?: PlugState;
  error?: string;
  attempts?: number;
  /** Epoch ms of the next scheduled retry, when state is 'retrying'. */
  nextRetryAt?: number;
}

interface PlugRecord {
  kind: PlugKind;
  name: string;
  runner: PlugRunner;
}

/**
 * Hot-plug registry on cordis. Each MCP server and adapter is a plugin in its own cordis context.
 * Enabling starts it and retries failures with exponential backoff until it is disabled.
 * Disabling aborts the retry loop and runs the teardown, which removes the connection.
 */
export class HotPlugRegistry {
  private readonly plugs = new Map<string, PlugRecord>();
  private readonly configs = new Map<string, McpServerConfig>();
  private readonly adapters = new Map<string, () => AdapterPlug>();
  private readonly disabledSkills: Set<string>;
  private readonly disabledTools: Set<string>;

  public constructor(
    private readonly mcp: McpToolClient,
    private readonly root = process.cwd(),
    private readonly retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY,
  ) {
    const saved = readHotPlugState(root);
    this.disabledSkills = new Set(saved.disabledSkills);
    this.disabledTools = new Set(saved.disabledTools);
  }

  private static id(kind: PlugKind, name: string): string {
    return `${kind}:${name}`;
  }

  /** Registers or replaces an MCP server definition. Connecting happens on enable. */
  public defineMcp(config: McpServerConfig): void {
    this.configs.set(config.name, config);
  }

  public async enableMcp(name: string): Promise<PlugStatus> {
    const config = this.configs.get(name);
    if (!config) throw new Error(`MCP server '${name}' is not defined`);
    const id = HotPlugRegistry.id('mcp', name);
    return this.enable(id, 'mcp', name, () => this.mcp.connect(config), () => this.mcp.disconnect(name));
  }

  /** Registers an adapter factory. Each enable builds a fresh adapter so stale connection state never leaks across restarts. */
  public defineAdapter(name: string, create: () => AdapterPlug): void {
    this.adapters.set(name, create);
  }

  public async enableAdapter(name: string): Promise<PlugStatus> {
    const create = this.adapters.get(name);
    if (!create) throw new Error(`Adapter '${name}' is not defined`);
    const adapter = create();
    const id = HotPlugRegistry.id('adapter', name);
    return this.enable(id, 'adapter', name, () => adapter.start(), () => Promise.resolve().then(() => adapter.stop()));
  }

  /**
   * Replaces any existing plug with this id, starts a new runner in its own cordis context,
   * and returns the status after the first attempt or after the wait limit.
   */
  private async enable(id: string, kind: PlugKind, name: string, attempt: () => Promise<void>, teardown: () => void | Promise<void>): Promise<PlugStatus> {
    await this.disable(id);
    const runner = new PlugRunner(attempt, async () => { await teardown(); }, this.retryPolicy);
    this.plugs.set(id, { kind, name, runner });
    runner.start();
    await runner.waitForFirstAttempt();
    return this.status(id);
  }

  /** Disposes an enabled plug by id. Its teardown stops retries and removes its connection; other plugs are untouched. */
  public async disable(id: string): Promise<PlugStatus> {
    const record = this.plugs.get(id);
    if (record) {
      this.plugs.delete(id);
      await record.runner.dispose();
    }
    return this.status(id);
  }

  public status(id: string): PlugStatus {
    const record = this.plugs.get(id);
    if (!record) {
      const [kind, ...rest] = id.split(':');
      return { id, kind: kind as PlugKind, name: rest.join(':'), enabled: false };
    }
    const { runner } = record;
    return {
      id,
      kind: record.kind,
      name: record.name,
      enabled: true,
      state: runner.state,
      attempts: runner.attempts,
      ...(runner.error ? { error: runner.error } : {}),
      ...(runner.nextRetryAt ? { nextRetryAt: runner.nextRetryAt } : {}),
    };
  }

  public list(): PlugStatus[] {
    return [...this.plugs.keys()].map((id) => this.status(id));
  }

  public mcpStatuses(): McpServerStatus[] {
    return this.mcp.statuses([...this.configs.keys()]);
  }

  /** Names of MCP servers whose plug is backing off after a failed connection attempt. */
  public retryingMcpNames(): string[] {
    return [...this.configs.keys()].filter((name) => this.status(HotPlugRegistry.id('mcp', name)).state === 'retrying');
  }

  /** Usable-or-not state of every MCP server, built-in tool and skill the model could be offered. */
  public capabilityEntries(skillNames: readonly string[], toolNames: readonly string[]): CapabilityEntry[] {
    const statuses = new Map(this.mcpStatuses().map((status) => [status.name, status]));
    const mcp = [...this.configs.keys()].map((name) => {
      const id = HotPlugRegistry.id('mcp', name);
      return mcpCapability(name, this.plugs.has(id), statuses.get(name), this.status(id).state === 'retrying');
    });
    return [
      ...mcp,
      ...skillNames.map((name) => toggledCapability(name, this.isSkillEnabled(name))),
      ...toolNames.map((name) => toggledCapability(name, this.isToolEnabled(name))),
    ];
  }

  /** Tool definitions for the model, derived from the currently connected MCP servers. */
  public async mcpToolDefinitions() {
    return (await this.mcp.listTools()).map(mcpToolDefinition);
  }

  /** Names of skills or built-in tools the user has turned off. Files on disk are never touched; the state is persisted. */
  public setSkillEnabled(name: string, enabled: boolean): void {
    if (enabled) this.disabledSkills.delete(name);
    else this.disabledSkills.add(name);
    this.persist();
  }

  public setToolEnabled(name: string, enabled: boolean): void {
    if (enabled) this.disabledTools.delete(name);
    else this.disabledTools.add(name);
    this.persist();
  }

  private persist(): void {
    writeHotPlugState({ disabledSkills: [...this.disabledSkills], disabledTools: [...this.disabledTools] }, this.root);
  }

  public isSkillEnabled(name: string): boolean { return !this.disabledSkills.has(name); }

  public isToolEnabled(name: string): boolean { return !this.disabledTools.has(name); }

  public disabledToolNames(): string[] { return [...this.disabledTools]; }

  /** Stops every enabled plug, cancelling pending retries. Called on runtime shutdown. */
  public async disposeAll(): Promise<void> {
    await Promise.all([...this.plugs.keys()].map((id) => this.disable(id)));
  }
}
