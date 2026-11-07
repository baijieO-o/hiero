import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

export interface ExtensionRequest {
  request_id: string;
  github_url: string;
  install_root?: string;
}

export interface ExtensionReady {
  type: 'EXTENSION_READY';
  request_id: string;
  plugin_path: string;
  mcp_config_path: string;
}

export interface SystemAgentError {
  type: 'ERROR';
  request_id: string;
  error: { code: 'SYS-001'; level: 'blocker'; message: string; suggestion: string; evidence_id?: string };
}

export type SystemAgentMessage = ExtensionReady | SystemAgentError;

async function main(request: ExtensionRequest): Promise<SystemAgentMessage> {
  validateRequest(request);
  const root = request.install_root ?? join(tmpdir(), 'hiero-extensions');
  const pluginPath = join(root, `${sanitizeName(request.github_url)}-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  await run('git', ['clone', '--depth', '1', request.github_url, pluginPath]);

  const packagePath = join(pluginPath, 'package.json');
  const requirementsPath = join(pluginPath, 'requirements.txt');
  let mcpConfigPath: string;
  try {
    await readFile(packagePath, 'utf8');
    await run('npm', ['install', '--ignore-scripts'], pluginPath);
    mcpConfigPath = await writeMcpConfig(pluginPath, 'node', ['index.js']);
  } catch (packageError) {
    try {
      await readFile(requirementsPath, 'utf8');
      await run('python', ['-m', 'venv', '.venv'], pluginPath);
      const python = process.platform === 'win32' ? join(pluginPath, '.venv', 'Scripts', 'python.exe') : join(pluginPath, '.venv', 'bin', 'python');
      await run(python, ['-m', 'pip', 'install', '-r', 'requirements.txt'], pluginPath);
      mcpConfigPath = await writeMcpConfig(pluginPath, python, ['-m', 'plugin']);
    } catch (error) {
      throw new Error(`Extension environment build failed: ${formatError(error ?? packageError)}`);
    }
  }
  return { type: 'EXTENSION_READY', request_id: request.request_id, plugin_path: pluginPath, mcp_config_path: mcpConfigPath };
}

function validateRequest(request: ExtensionRequest): void {
  if (!request.request_id || !request.github_url || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(request.github_url)) throw new Error('Only public GitHub repository URLs are supported.');
}

async function writeMcpConfig(pluginPath: string, command: string, args: string[]): Promise<string> {
  const path = join(pluginPath, 'hiero.mcp.json');
  await writeFile(path, JSON.stringify({ name: basename(pluginPath), transport: 'stdio', command, args, cwd: pluginPath }, null, 2));
  return path;
}

function run(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `${command} exited with ${code}`)));
  });
}

function formatError(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function sanitizeName(url: string): string { return url.split('/').filter(Boolean).pop()?.replace(/\.git$/, '').replace(/[^A-Za-z0-9_.-]/g, '_') ?? 'extension'; }

if (process.argv[1]?.endsWith('system_agent.js')) {
  const responseError = (requestId: string, cause: unknown): SystemAgentError => ({ type: 'ERROR', request_id: requestId, error: { code: 'SYS-001', level: 'blocker', message: formatError(cause), suggestion: 'Inspect the repository URL and extension build logs.' } });
  process.stdin.setEncoding('utf8');
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let request: ExtensionRequest;
      try { request = JSON.parse(line) as ExtensionRequest; } catch (cause) {
        process.stdout.write(`${JSON.stringify(responseError('unknown', cause))}\n`);
        continue;
      }
      void main(request)
        .then((message) => process.stdout.write(`${JSON.stringify(message)}\n`))
        .catch((cause) => process.stdout.write(`${JSON.stringify(responseError(request.request_id, cause))}\n`));
    }
  });
}
