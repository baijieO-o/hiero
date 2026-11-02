import { HieroRuntime } from './hiero-runtime.js';
import { loadLocalLlmEnv } from './llm-env.js';
import { parseTokenList } from './model-gateway.js';

loadLocalLlmEnv();
const runtime = new HieroRuntime(8080);
runtime.startMcpServers();

console.log('Hiero runtime listening on ws://localhost:8080');
console.log(`LLM model: ${process.env.HIERO_LLM_MODEL ?? 'not configured'}; tokens loaded: ${parseTokenList(process.env.HIERO_LLM_TOKENS).length}`);

process.on('SIGINT', async () => {
  await runtime.close();
  process.exit(0);
});
