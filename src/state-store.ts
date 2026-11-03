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
    `);
  }

  public startTask(taskId: string, workspacePath: string, goal: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO tasks (task_id, workspace_path, goal, status, last_state, created_at, updated_at)
      VALUES (?, ?, ?, 'running', 'Plan', ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET status = 'running', updated_at = excluded.updated_at`)
      .run(taskId, workspacePath, goal, now, now);
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
