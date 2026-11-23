import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Outcome of one candidate attempt, produced inside its own worktree. */
export interface BranchAttempt {
  verified: boolean;
  /** Used to break ties: fewer steps wins when both candidates pass. */
  steps: number;
  summary: string;
}

export interface BranchRetryResult {
  winner?: { index: number; branch: string; attempt: BranchAttempt };
  attempts: { index: number; branch: string; attempt?: BranchAttempt; error?: string }[];
}

export interface BranchRetryOptions {
  /** Repository root; must be a git repo with at least one commit. */
  root: string;
  /** Unique id for this retry round; used to name branches and worktrees. */
  roundId: string;
  /** Number of candidates to try in parallel. */
  width: number;
  /** Runs one candidate inside `worktreePath`. Errors are recorded and do not stop other candidates. */
  attempt: (worktreePath: string, index: number) => Promise<BranchAttempt>;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

/** True when `root` is a git repository with at least one commit, so candidate branches can start from HEAD. */
export async function canBranchFrom(root: string): Promise<boolean> {
  return git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false);
}

/** Keeps branch and folder names to safe characters so ids cannot escape `.hiero/branches`. */
/**
 * Wraps an approver so only one request is outstanding at a time. Candidates run in parallel,
 * but the operator should see one approval prompt at a time, in arrival order.
 */
export function createSerializedApprover<A extends unknown[], R>(approve: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  let tail: Promise<unknown> = Promise.resolve();
  return (...args: A) => {
    const next = tail.then(() => approve(...args));
    tail = next.catch(() => undefined);
    return next;
  };
}

export function branchSlug(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) || 'round';
}

/** Chooses the best attempt: verified beats unverified, then fewer steps, then earlier index. */
export function pickBranchWinner(attempts: BranchRetryResult['attempts']): BranchRetryResult['winner'] {
  let best: { index: number; branch: string; attempt: BranchAttempt } | undefined;
  for (const entry of attempts) {
    if (!entry.attempt?.verified) continue;
    if (!best || entry.attempt.steps < best.attempt.steps) best = { index: entry.index, branch: entry.branch, attempt: entry.attempt };
  }
  return best;
}

/**
 * Runs `width` candidate attempts in parallel, each in its own git worktree on a fresh branch from HEAD.
 * The winning candidate's commit is merged into the root branch; every worktree and branch is removed afterwards.
 * Merge conflicts with the root are reported as a failed candidate instead of touching the root folder.
 */
export async function runBranchRetry(options: BranchRetryOptions): Promise<BranchRetryResult> {
  const { root, width, attempt } = options;
  if (width < 1) throw new Error('Branch width must be at least 1.');
  const round = branchSlug(options.roundId);
  const folder = join(root, '.hiero', 'branches');
  mkdirSync(folder, { recursive: true });

  const candidates = Array.from({ length: width }, (_, index) => ({
    index,
    branch: `hiero/branch-${round}-${index}`,
    path: join(folder, `${round}-${index}`),
  }));

  const attempts = await Promise.all(candidates.map(async (candidate) => {
    try {
      await git(root, ['worktree', 'add', '-b', candidate.branch, candidate.path, 'HEAD']);
      const result = await attempt(candidate.path, candidate.index);
      return { index: candidate.index, branch: candidate.branch, attempt: result };
    } catch (cause) {
      return { index: candidate.index, branch: candidate.branch, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }));

  const winner = pickBranchWinner(attempts);
  let merged = winner;
  if (winner) {
    try {
      await commitPending(candidates[winner.index]!.path);
      await git(root, ['merge', '--no-edit', winner.branch]);
    } catch {
      await git(root, ['merge', '--abort']).catch(() => undefined);
      merged = undefined;
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate.path)) await git(root, ['worktree', 'remove', '--force', candidate.path]).catch(() => undefined);
    await git(root, ['branch', '-D', candidate.branch]).catch(() => undefined);
  }
  return { ...(merged ? { winner: merged } : {}), attempts };
}

async function commitPending(path: string): Promise<void> {
  const dirty = await git(path, ['status', '--porcelain']);
  if (!dirty) return;
  await git(path, ['add', '-A']);
  await git(path, ['-c', 'user.email=hiero@local', '-c', 'user.name=hiero', 'commit', '-m', 'hiero: branch retry candidate', '--no-verify']);
}
