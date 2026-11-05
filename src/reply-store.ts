import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Replies longer than this are saved to a file instead of filling the chat. */
export const LONG_REPLY_THRESHOLD = 4000;
const REPLY_DIR = join('.hiero', 'replies');
const SUMMARY_CHARS = 300;

export interface SavedReply {
  /** Path relative to the workspace, using forward slashes. */
  path: string;
  /** Short preview shown in chat in place of the full reply. */
  summary: string;
}

/** Writes a long reply to `.hiero/replies/<timestamp>-<request>.md` in the workspace. */
export async function saveLongReply(workspacePath: string, requestId: string, content: string): Promise<SavedReply> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeId = requestId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12) || 'reply';
  const name = `${stamp}-${safeId}.md`;
  await mkdir(join(workspacePath, REPLY_DIR), { recursive: true });
  await writeFile(join(workspacePath, REPLY_DIR, name), content, 'utf8');
  const head = content.slice(0, SUMMARY_CHARS).trimEnd();
  return { path: `${REPLY_DIR.split('\\').join('/')}/${name}`, summary: `${head}…` };
}
