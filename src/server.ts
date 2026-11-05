#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { defaultFrontendDir, startStaticServer } from './static-server.js';
import { HieroRuntime } from './hiero-runtime.js';
import { loadLocalLlmEnv } from './llm-env.js';
import { parseTokenList } from './model-gateway.js';

loadLocalLlmEnv();
const runtime = new HieroRuntime(8080);
runtime.startMcpServers();

const uiPort = Number(process.env.HIERO_UI_PORT ?? 5173);
const frontendDir = defaultFrontendDir();
const uiServer = existsSync(frontendDir) ? startStaticServer(uiPort, frontendDir) : undefined;

console.log('Hiero runtime listening on ws://localhost:8080');
if (uiServer) console.log(`Hiero UI: http://localhost:${uiPort}`);
console.log(`LLM model: ${process.env.HIERO_LLM_MODEL ?? 'not configured'}; tokens loaded: ${parseTokenList(process.env.HIERO_LLM_TOKENS).length}`);

process.on('SIGINT', async () => {
  uiServer?.close();
  await runtime.close();
  process.exit(0);
});
