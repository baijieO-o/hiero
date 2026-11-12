import { Context, type Fiber } from 'cordis';
import { z } from 'zod';
import type { McpServerConfig, McpServerStatus, McpToolClient } from './mcp-client.js';
import { mcpToolDefinition } from './mcp-client.js';
import { readHotPlugState, writeHotPlugState } from './hot-plug-state.js';

export type PlugKind = 'mcp' | 'tool' | 'skill';

export interface PlugStatus {
  id: string;
  kind: PlugKind;
  name: string;
  enabled: boolean;
  error?: string;
}

interface PlugRecord {
  kind: PlugKind;
  name: string;
  fiber?: Fiber;
  error?: string;
}

/**
 * Hot-plug registry built on cordis. Each MCP server, tool and skill source is a plugin.
 * Enabling applies the plugin; disabling disposes it, which runs its teardown and removes its
 * tools from the gateway. Other plugins are not affected.
 */
export class HotPlugRegistry {
  private readonly ctx: Context;
  private readonly plugs = new Map<string, PlugRecord>();
  private readonly configs = new Map<string, McpServerConfig>();

  public constructor(private readonly mcp: McpToolClient, private readonly root = process.cwd()) {
    this.ctx = new Context();
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
    const id = HotPlugRegistry.id('mcp', name);
    const config = this.configs.get(name);
    if (!config) throw new Error(`MCP server '${name}' is not defined`);
    await this.disable(id);
    const record: PlugRecord = { kind: 'mcp', name };
    this.plugs.set(id, record);
    const fiber = this.ctx.plugin((ctx: Context) => {
      ctx.effect(() => () => {
        const teardown = this.mcp.disconnect(name);
        this.pendingTeardown.add(teardown);
        void teardown.finally(() => this.pendingTeardown.delete(teardown));
      });
      return this.connectMcp(name, config, record);
    });
    record.fiber = fiber;
    await fiber;
    return this.status(id);
  }

  private async connectMcp(name: string, config: McpServerConfig, record: PlugRecord): Promise<void> {
    try {
      await this.mcp.connect(config);
      delete record.error;
    } catch (cause) {
      record.error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  /** Disposes an enabled plugin by id. Its teardown removes its tools and connection; other plugins are untouched. */
  public async disable(id: string): Promise<PlugStatus> {
    const record = this.plugs.get(id);
    if (record) {
      this.plugs.delete(id);
      record.fiber?.dispose();
    }
    await this.settle();
    return this.status(id);
  }

  private readonly pendingTeardown = new Set<Promise<void>>();

  /** Waits for in-flight teardown (connection close) so callers observe a clean state. */
  private async settle(): Promise<void> {
    await Promise.all([...this.pendingTeardown]);
  }

  public status(id: string): PlugStatus {
    const record = this.plugs.get(id);
    if (!record) {
      const [kind, ...rest] = id.split(':');
      return { id, kind: kind as PlugKind, name: rest.join(':'), enabled: false };
    }
    return { id, kind: record.kind, name: record.name, enabled: true, ...(record.error ? { error: record.error } : {}) };
  }

  public list(): PlugStatus[] {
    return [...this.plugs.keys()].map((id) => this.status(id));
  }

  public mcpStatuses(): McpServerStatus[] {
    return this.mcp.statuses([...this.configs.keys()]);
  }

  /** Tool definitions for the model, derived from the currently connected MCP servers. */
  public async mcpToolDefinitions() {
    return (await this.mcp.listTools()).map(mcpToolDefinition);
  }

  /** Names of skills or built-in tools the user has turned off. Files on disk are never touched; the state is persisted. */
  private readonly disabledSkills: Set<string>;
  private readonly disabledTools: Set<string>;

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

  public async disposeAll(): Promise<void> {
    for (const id of [...this.plugs.keys()]) await this.disable(id);
  }
}
