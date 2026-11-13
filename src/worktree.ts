import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type NonGitPolicy = 'fallback' | 'init' | 'ask';

export interface WorktreeInfo {
  /** Directory the chat's tools should operate in. */
  path: string;
  /** Whether a dedicated worktree was created (false when falling back to the original folder). */
  isolated: boolean;
  branch?: string;
}

/** Git ids are slugged so a conversation id can never escape the worktrees folder. */
export function worktreeSlug(conversationId: string): string {
  return conversationId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'chat';
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

export async function isGitRepo(root: string): Promise<boolean> {
  if (!existsSync(root)) return false;
  return git(root, ['rev-parse', '--is-inside-work-tree']).then((out) => out === 'true', () => false);
}

/**
 * Returns the directory a conversation should work in. Creates `<root>/.hiero/worktrees/<id>` on a
 * branch `hiero/<id>` the first time, and reuses it afterwards. Non-git folders follow `policy`.
 */
export async function ensureConversationWorktree(root: string, conversationId: string, policy: NonGitPolicy): Promise<WorktreeInfo> {
  if (!(await isGitRepo(root))) {
    if (policy === 'init') {
      await git(root, ['init']);
    } else {
      return { path: root, isolated: false };
    }
  }
  const slug = worktreeSlug(conversationId);
  const path = join(root, '.hiero', 'worktrees', slug);
  const branch = `hiero/${slug}`;
  if (existsSync(path)) return { path, isolated: true, branch };
  mkdirSync(join(root, '.hiero', 'worktrees'), { recursive: true });
  // Start from HEAD; on a repo without commits there is nothing to branch from, so fall back to the original folder.
  const hasHead = await git(root, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false);
  if (!hasHead) return { path: root, isolated: false };
  await git(root, ['worktree', 'add', '-b', branch, path, 'HEAD']).catch(async () => {
    // The branch may survive from an earlier run whose folder was removed; reuse it instead.
    await git(root, ['worktree', 'add', path, branch]);
  });
  return { path, isolated: true, branch };
}

/** Whether the worktree has uncommitted changes. Used to warn before removing it. */
export async function hasUncommittedChanges(path: string): Promise<boolean> {
  return git(path, ['status', '--porcelain']).then((out) => out.length > 0, () => false);
}

/**
 * Removes a conversation's worktree and its branch. Refuses while there are uncommitted changes
 * unless `force` is set, so the caller can ask the user first.
 */
export async function removeConversationWorktree(root: string, conversationId: string, force = false): Promise<void> {
  const slug = worktreeSlug(conversationId);
  const path = join(root, '.hiero', 'worktrees', slug);
  if (!existsSync(path)) return;
  if (!force && (await hasUncommittedChanges(path))) throw new Error(`Worktree ${slug} has uncommitted changes.`);
  await git(root, ['worktree', 'remove', '--force', path]);
  await git(root, ['branch', '-D', `hiero/${slug}`]).catch(() => undefined);
}
