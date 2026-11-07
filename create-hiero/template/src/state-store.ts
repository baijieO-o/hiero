import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type TaskStatus = 'running' | 'completed' | 'failed' | 'interrupted';

export interface TaskRecord {
  task_id: string;
  workspace_path: string;
  goal: string;
  status: TaskStatus;
  last_state: string;
  created_at: string;
  updated_at: string;
}

export interface TaskTransitionRecord {
  task_id: string;
  from_state: string | null;
  to_state: string;
  at: string;
}

export function defaultStorePath(): string {
  return join(homedir(), '.hiero', 'hiero.db');
}

/** Persists agent task state and transitions to a local SQLite file so they survive restarts. */
export class StateStore {
  private readonly db: DatabaseSync;

  public constructor(path = defaultStorePath()) {
    if (path !== ':memory:') mkdirSync(join(path, '..'), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        last_state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        from_state TEXT,
        to_state TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        seq INTEGER NOT NULL,
        messages_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, seq)
      );
    `);
  }

  public startTask(taskId: string, workspacePath: string, goal: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO tasks (task_id, workspace_path, goal, status, last_state, created_at, updated_at)
      VALUES (?, ?, ?, 'running', 'Plan', ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET status = 'running', updated_at = excluded.updated_at`)
      .run(taskId, workspacePath, goal, now, now);
  }

  /** Marks an interrupted task as running again, keeping its original goal and workspace. */
  public resumeTask(taskId: string): void {
    this.db.prepare(`UPDATE tasks SET status = 'running', updated_at = ? WHERE task_id = ?`).run(new Date().toISOString(), taskId);
  }

  public recordTransition(taskId: string, fromState: string | null, toState: string): void {
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO task_transitions (task_id, from_state, to_state, at) VALUES (?, ?, ?, ?)').run(taskId, fromState, toState, now);
    this.db.prepare('UPDATE tasks SET last_state = ?, updated_at = ? WHERE task_id = ?').run(toState, now, taskId);
  }

  public finishTask(taskId: string, status: Exclude<TaskStatus, 'running' | 'interrupted'>): void {
    this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?').run(status, new Date().toISOString(), taskId);
  }

  /** Marks tasks left in `running` by a previous process as interrupted. Returns the affected task IDs. */
  public markRunningAsInterrupted(): string[] {
    const rows = this.db.prepare(`SELECT task_id FROM tasks WHERE status = 'running'`).all() as { task_id: string }[];
    this.db.prepare(`UPDATE tasks SET status = 'interrupted', updated_at = ? WHERE status = 'running'`).run(new Date().toISOString());
    return rows.map((row) => row.task_id);
  }

  /** Saves the message history after one completed tool-call batch so an interrupted task can resume from it. */
  public saveCheckpoint(taskId: string, messages: readonly unknown[], evidence: readonly unknown[]): void {
    const { seq } = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM checkpoints WHERE task_id = ?').get(taskId) as unknown as { seq: number };
    this.db.prepare('INSERT INTO checkpoints (task_id, seq, messages_json, evidence_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, seq + 1, JSON.stringify(messages), JSON.stringify(evidence), new Date().toISOString());
  }

  public latestCheckpoint(taskId: string): { messages: unknown[]; evidence: unknown[] } | undefined {
    const row = this.db.prepare('SELECT messages_json, evidence_json FROM checkpoints WHERE task_id = ? ORDER BY seq DESC LIMIT 1').get(taskId) as { messages_json: string; evidence_json: string } | undefined;
    return row ? { messages: JSON.parse(row.messages_json) as unknown[], evidence: JSON.parse(row.evidence_json) as unknown[] } : undefined;
  }

  public getTask(taskId: string): TaskRecord | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as unknown as TaskRecord | undefined;
  }

  public listTasks(limit = 50): TaskRecord[] {
    return this.db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?').all(limit) as unknown as TaskRecord[];
  }

  public listTransitions(taskId: string): TaskTransitionRecord[] {
    return this.db.prepare('SELECT task_id, from_state, to_state, at FROM task_transitions WHERE task_id = ? ORDER BY id').all(taskId) as unknown as TaskTransitionRecord[];
  }

  public close(): void {
    this.db.close();
  }
}
