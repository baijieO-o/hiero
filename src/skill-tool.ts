import { z } from 'zod';
import type { ModelToolDefinition } from './model-gateway.js';
import type { CapabilityRouter } from './capability-router.js';
import type { ToolGateway } from './tool-gateway.js';

export const LOAD_SKILL_TOOL_DEFINITION: ModelToolDefinition = {
  type: 'function',
  function: {
    name: 'load_skill',
    description: 'Load the full SKILL.md instructions for one of the skills listed under "Available skills". Call this before following a skill; the listed descriptions are only a summary.',
    parameters: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' } }, required: ['name'] },
  },
};

/** Registers load_skill on a tool gateway. Read-only, so it runs without approval in every mode. */
export function registerLoadSkillTool(gateway: ToolGateway, router: CapabilityRouter): void {
  gateway.register({
    name: 'load_skill',
    inputSchema: z.object({ name: z.string().min(1) }),
    effect: 'read',
    execute: async ({ name }) => {
      const skill = await router.loadSkill(name);
      if (!skill) return { error: `Unknown skill: ${name}. Use one of the names under "Available skills".` };
      return { name: skill.name, content: skill.content };
    },
  });
}
