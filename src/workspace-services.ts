import { realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { resolveWorkspacePath } from './basic-tools.js';

export interface DirEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  size: number;
  modified: number;
}

const MAX_READ_BYTES = 200_000;
const MAX_OUTPUT_CHARS = 50_000;
const DEFAULT_TIMEOUT_MS = 30_000;

const STAT_CONCURRENCY = 16;
const BINARY_SNIFF_BYTES = 8_000;
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Maps items with at most `limit` promises in flight, preserving input order. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function listDirectory(root: string, relPath = ''): Promise<{ path: string; entries: DirEntry[] }> {
  const target = resolveWorkspacePath(root, relPath);
  const dirents = await readdir(target, { withFileTypes: true });
  const entries = await mapLimited(dirents, STAT_CONCURRENCY, async (dirent): Promise<DirEntry> => {
    const full = join(target, dirent.name);
    const info = await stat(full).catch(() => null);
    return {
      name: dirent.name,
      path: relative(root, full).split(sep).join('/'),
      kind: dirent.isDirectory() ? 'dir' : 'file',
      size: info?.size ?? 0,
      modified: info?.mtimeMs ?? 0,
    };
  });
  entries.sort((a, b) => (a.kind === b.kind ? nameCollator.compare(a.name, b.name) : a.kind === 'dir' ? -1 : 1));
  return { path: relative(root, target).split(sep).join('/'), entries };
}

export async function readTextFile(root: string, relPath: string): Promise<{ path: string; content: string; truncated: boolean; binary: boolean; size: number }> {
  const target = resolveWorkspacePath(root, relPath);
  const info = await stat(target);
  if (!info.isFile()) throw new Error('Path is not a file.');
  const path = relative(root, target).split(sep).join('/');
  const buffer = await readFile(target);
  // A NUL byte in the leading bytes is the usual signal that the file is not text.
  const binary = buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
  if (binary) return { path, content: '', truncated: false, binary: true, size: buffer.byteLength };
  const truncated = buffer.byteLength > MAX_READ_BYTES;
  return { path, content: buffer.subarray(0, MAX_READ_BYTES).toString('utf8'), truncated, binary: false, size: buffer.byteLength };
}

/**
 * Opens the native folder picker (Windows only) and returns the chosen absolute path, or null if cancelled.
 * The initial path is passed through an environment variable so it never becomes part of the script text.
 */
export function pickFolder(initialPath?: string): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.reject(new Error('文件夹选择对话框仅支持 Windows，请手动输入路径。'));
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '[System.Windows.Forms.Application]::EnableVisualStyles()',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true; $owner.ShowInTaskbar = $true; $owner.StartPosition = "CenterScreen"; $owner.Opacity = 0',
    '$owner.Show(); $owner.Activate()',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$dialog.Description = "选择工作区文件夹"',
    '$dialog.ShowNewFolderButton = $false',
    'if ($env:HIERO_PICK_INITIAL) { $dialog.SelectedPath = $env:HIERO_PICK_INITIAL }',
    '$result = $dialog.ShowDialog($owner)',
    '$owner.Close()',
    'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }',
  ].join('; ');
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HIERO_PICK_INITIAL: initialPath ?? '' },
      windowsHide: false,
    });
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', () => {
      const selected = Buffer.concat(chunks).toString('utf8').trim();
      resolvePromise(selected || null);
    });
  });
}

export interface CommandResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

// Windows cmd writes in the console code page (GBK on zh-CN); other platforms and UTF-8 tools use UTF-8.
function decodeOutput(buffer: Buffer): string {
  const utf8 = buffer.toString('utf8');
  if (process.platform !== 'win32' || !utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(buffer);
  } catch {
    return utf8;
  }
}

/**
 * Runs one shell command in the workspace and returns its combined output.
 * This is a one-shot execution, not an interactive terminal session.
 */
export function runCommand(root: string, command: string, cwd = '', timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CommandResult> {
  const directory = resolveWorkspacePath(root, cwd);
  const relativeCwd = relative(root, directory).split(sep).join('/');
  const containerCwd = relativeCwd ? `/workspace/${relativeCwd}` : '/workspace';
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let timedOut = false;
    const child = spawn('docker', [
      'run', '--rm', '--network', 'none', '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=512m', '--cpus=1',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '--mount', `type=bind,source=${realpathSync(root)},target=/workspace`,
      '--workdir', containerCwd, 'node:22-alpine', 'sh', '-lc', command,
    ], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
    const append = (chunk: Buffer) => {
      chunks.push(chunk);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolvePromise({ command, cwd: relativeCwd, exitCode, output: decodeOutput(Buffer.concat(chunks)).slice(0, MAX_OUTPUT_CHARS), timedOut });
    });
    child.on('error', (cause) => {
      clearTimeout(timer);
      resolvePromise({ command, cwd: relativeCwd, exitCode: null, output: `Docker sandbox unavailable: ${cause.message}`, timedOut });
    });
  });
}
