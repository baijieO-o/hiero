import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { error, type HieroError } from './contracts.js';

export interface WriteSnapshot {
  path: string;
  /** Null when the file did not exist before the write. */
  previous: string | null;
  /** Hash of the content the agent wrote, used to detect later human edits. */
  writtenHash: string;
}

export interface RollbackResult {
  restored: string[];
  skipped: string[];
}

export function hashContent(content: string | null): string {
  return createHash('sha256').update(content ?? '').digest('hex');
}

async function readOrNull(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null);
}

/**
 * Records file state before each agent write so a node can be rewound.
 * A file the human edited after the agent wrote it is left alone and reported as RBK-006.
 */
export class WriteSnapshotStore {
  private snapshots: WriteSnapshot[] = [];

  /** When `file` is set, snapshots survive restarts so a rollback can still run after the process exits. */
  public constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      this.snapshots = JSON.parse(readFileSync(file, 'utf8')) as WriteSnapshot[];
    }
  }

  public async captureBeforeWrite(path: string): Promise<{ previous: string | null }> {
    return { previous: await readOrNull(path) };
  }

  public recordWrite(path: string, previous: string | null, written: string): void {
    this.snapshots.push({ path, previous, writtenHash: hashContent(written) });
    this.persist();
  }

  public clear(): void {
    this.snapshots = [];
    this.persist();
  }

  public list(): WriteSnapshot[] {
    return [...this.snapshots];
  }

  private persist(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.snapshots), 'utf8');
  }

  /** Restores files in reverse write order. Files changed by a human since the agent wrote them are skipped. */
  public async rollback(): Promise<RollbackResult> {
    const result: RollbackResult = { restored: [], skipped: [] };
    for (const snapshot of [...this.snapshots].reverse()) {
      const current = await readOrNull(snapshot.path);
      if (hashContent(current) !== snapshot.writtenHash) {
        result.skipped.push(snapshot.path);
        continue;
      }
      if (snapshot.previous === null) await rm(snapshot.path, { force: true });
      else await writeFile(snapshot.path, snapshot.previous, 'utf8');
      result.restored.push(snapshot.path);
    }
    this.snapshots = [];
    this.persist();
    return result;
  }
}

export function humanModifiedWarning(skipped: string[]): HieroError {
  return error('RBK-006', 'warning', `Files changed by a human after the agent wrote them were not rolled back: ${skipped.join(', ')}`, 'Review the listed files manually.');
}
