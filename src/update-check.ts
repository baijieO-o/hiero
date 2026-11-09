import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface UpdateStatus {
  ok: boolean;
  current_version: string;
  latest_version?: string;
  update_available: boolean;
  message?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const TAG_PATTERN = /refs\/tags\/v(\d+)\.(\d+)\.(\d+)$/;

export function readCurrentVersion(packageJsonPath = join(here, '..', '..', 'package.json')): string {
  return (JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string }).version;
}

/** Returns the highest `vX.Y.Z` version from `git ls-remote --tags` output, or undefined if none. */
export function parseLatestTag(lsRemoteOutput: string): string | undefined {
  let best: [number, number, number] | undefined;
  for (const line of lsRemoteOutput.split(/\r?\n/)) {
    const match = TAG_PATTERN.exec(line.trim());
    if (!match) continue;
    const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
    if (!best || compareVersions(parts, best) > 0) best = parts;
  }
  return best ? best.join('.') : undefined;
}

export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function lsRemoteTags(repoUrl: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['ls-remote', '--tags', '--refs', repoUrl], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** Checks the remote git repository for a newer `vX.Y.Z` tag. Never throws; failures are reported in the result. */
export async function checkForUpdate(options: { repoUrl?: string; timeoutMs?: number; packageJsonPath?: string } = {}): Promise<UpdateStatus> {
  const repoUrl = options.repoUrl ?? 'https://github.com/baijieO-o/hiero.git';
  let current = '';
  try {
    current = readCurrentVersion(options.packageJsonPath);
    const latest = parseLatestTag(await lsRemoteTags(repoUrl, options.timeoutMs ?? 15_000));
    if (!latest) return { ok: false, current_version: current, update_available: false, message: '远程仓库没有找到版本标签' };
    const newer = compareVersions(latest.split('.').map(Number), current.split('.').map(Number)) > 0;
    return { ok: true, current_version: current, latest_version: latest, update_available: newer };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, current_version: current, update_available: false, message: `检查失败：${message}` };
  }
}
