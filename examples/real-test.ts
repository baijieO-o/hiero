import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentExecutor } from '../src/agent-executor.js';
import { AgentWorkflow } from '../src/agent-workflow.js';
import { AgentState, AgentStateMachine } from '../src/state-machine.js';
import { ModelGateway, OpenAICompatibleTransport, parseTokenList, type ModelToolDefinition } from '../src/model-gateway.js';
import { loadLocalLlmEnv } from '../src/llm-env.js';
import { ToolGateway } from '../src/tool-gateway.js';
import { RuntimeWebSocketServer } from '../src/runtime-server.js';
import { createWriteFileTool } from '../src/basic-tools.js';
import { diffSnapshots, snapshotTextFiles } from '../src/workspace-diff.js';
import type { TaskContract } from '../src/contracts.js';

loadLocalLlmEnv();
const endpoint = process.env.HIERO_LLM_ENDPOINT ?? process.env.LLM_BASE_URL;
const tokens = parseTokenList(process.env.HIERO_LLM_TOKENS ?? process.env.LLM_API_KEY);
const model = process.env.HIERO_LLM_MODEL ?? process.env.LLM_MODEL ?? 'gpt-4o-mini';
const workspacePath = process.cwd();

if (!endpoint || tokens.length === 0) {
  console.error('Set HIERO_LLM_ENDPOINT and HIERO_LLM_TOKENS (or .env / hiero-llm.local.ps1) before running this script.');
  process.exitCode = 1;
} else {
  const normalizedEndpoint = endpoint.replace(/\/$/, '').endsWith('/chat/completions') ? endpoint : `${endpoint.replace(/\/$/, '')}/chat/completions`;
  const task: TaskContract = {
    task_id: `real-test-${Date.now()}`,
    workspace_path: workspacePath,
    model_config: { preferred_model: model, fallback_chain: [] },
    permission_mode: 'auto',
    context_mode: 'ephemeral',
    acceptance_criteria: ['hello.txt contains exactly: Hello Hiero'],
    budget_envelope: { max_tokens: 32_000, max_time_ms: 120_000 },
  };
  const writeTool = createWriteFileTool(workspacePath);
  const definition: ModelToolDefinition = {
    type: 'function',
    function: {
      name: writeTool.name,
      description: 'Create or replace hello.txt inside the configured workspace with the exact requested content.',
      parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', enum: ['hello.txt'] }, content: { type: 'string', enum: ['Hello Hiero'] } }, required: ['path', 'content'] },
    },
  };
  const tools = new ToolGateway();
  tools.register(writeTool);
  const machine = new AgentStateMachine();
  const server = new RuntimeWebSocketServer(machine, 8080);
  const workflow = new AgentWorkflow(machine, new AgentExecutor(new ModelGateway(new OpenAICompatibleTransport(normalizedEndpoint), tokens), tools), (to, verified) => server.transition(to, verified));
  const before = await snapshotTextFiles(workspacePath);
  console.log(`Workspace: ${workspacePath}`);
  console.log('Connect the Hiero frontend to ws://localhost:8080 before starting if you want to observe FILE_DIFF.');
  try {
    const outcome = await workflow.run(task, 'Create hello.txt in the current workspace and write exactly the text "Hello Hiero". Call write_file with path "hello.txt" and content "Hello Hiero". Do not modify any other file.', [definition]);
    if ('handoff' in outcome) throw new Error('Task handed off before completion.');
    const written = await readFile(join(workspacePath, 'hello.txt'), 'utf8');
    if (written !== 'Hello Hiero') throw new Error(`Unexpected hello.txt contents: ${JSON.stringify(written)}`);
    const diffs = await diffSnapshots(before, await snapshotTextFiles(workspacePath));
    for (const diff of diffs) server.broadcast({ type: 'FILE_DIFF', payload: diff });
    server.completeState(AgentState.Verify);
    if (!diffs.some((diff) => diff.path === 'hello.txt')) throw new Error('hello.txt exists, but no FILE_DIFF was generated.');
    console.log('Verified hello.txt contains exactly: Hello Hiero');
    console.log('Broadcast FILE_DIFF for hello.txt. Check the Code Review panel.');
  } finally {
    await server.close();
  }
}
