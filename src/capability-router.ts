import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ModelToolDefinition } from './model-gateway.js';
import { McpToolClient, mcpToolDefinition, type McpServerConfig, type McpServerStatus } from './mcp-client.js';
import type { ToolGateway } from './tool-gateway.js';
import { listSkills } from './skill-store.js';

export interface SkillSummary { name: string; description: string; path: string; }
export interface SkillDetail extends SkillSummary { content: string; }

const METADATA_DESCRIPTION_LIMIT = 120;

function compactDescription(description: string): string {
  const oneLine = description.replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= METADATA_DESCRIPTION_LIMIT) return oneLine;
  return `${oneLine.slice(0, METADATA_DESCRIPTION_LIMIT - 1).trimEnd()}…`;
}

export class CapabilityRouter {
  private skills: SkillSummary[] = [];
  private readonly mcp: McpToolClient;
  private readonly skillEnabled: (name: string) => boolean;

  /** `skillEnabled` lets the hot-plug registry hide skills at runtime without deleting their files. */
  public constructor(mcp = new McpToolClient(), skillEnabled: (name: string) => boolean = () => true) {
    this.mcp = mcp;
    this.skillEnabled = skillEnabled;
  }

  public async discoverSkills(workspacePath: string): Promise<readonly SkillSummary[]> {
    const records = await listSkills(workspacePath, { dedupe: true });
    this.skills = records.map((record) => ({ name: record.name, description: record.description || 'No description provided.', path: record.path }));
    return this.skills;
  }

  public skillSummaries(): readonly SkillSummary[] { return this.activeSkills(); }

  public discoveredSkillSummaries(): readonly SkillSummary[] { return this.skills; }

  private activeSkills(): SkillSummary[] { return this.skills.filter((skill) => this.skillEnabled(skill.name)); }

  /** Short one-line summaries for the system prompt; full SKILL.md is loaded on demand via load_skill. */
  public systemPromptMetadata(): string {
    return this.activeSkills().map((skill) => `- ${skill.name}: ${compactDescription(skill.description)}`).join('\n');
  }

  public async loadSkill(name: string): Promise<SkillDetail | undefined> {
    const summary = this.activeSkills().find((skill) => skill.name === name);
    return summary ? { ...summary, content: await readFile(summary.path, 'utf8') } : undefined;
  }

  public async searchTools(query: string): Promise<ModelToolDefinition[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const tools = (await this.mcp.listTools()).filter((tool) => {
      const haystack = `${tool.name} ${tool.description ?? ''}`.toLowerCase();
      return terms.some((term) => haystack.includes(term));
    });
    return tools.map(mcpToolDefinition);
  }

  public async registerTools(toolGateway: ToolGateway, query: string): Promise<ModelToolDefinition[]> {
    const definitions = await this.searchTools(query);
    for (const definition of definitions) {
      const name = definition.function.name;
      toolGateway.registerMcpTool(name, z.unknown(), (input) => this.mcp.callTool(name, input));
    }
    return definitions;
  }

  public mcpStatuses(names: readonly string[]): McpServerStatus[] { return this.mcp.statuses(names); }

  /** Replaces all MCP connections with the given enabled servers and returns each server's status. Failed servers are reported, not thrown. */
  public async reloadMcp(servers: readonly McpServerConfig[]): Promise<McpServerStatus[]> {
    await this.mcp.close();
    for (const config of servers) await this.mcp.connect(config).catch(() => undefined);
    return this.mcp.statuses(servers.map((server) => server.name));
  }

  public async close(): Promise<void> { await this.mcp.close(); }
}
