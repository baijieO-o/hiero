export interface PlanTask {
  id: string;
  goal: string;
  depends_on: string[];
  /** Read-only tasks may run in parallel; anything else runs one at a time. */
  read_only: boolean;
}

export interface PlanDag {
  tasks: PlanTask[];
}

export interface PlanRunOptions {
  /** Upper bound on parallel read-only tasks. Defaults to 4. */
  maxParallel?: number;
}

export type PlanTaskRunner = (task: PlanTask) => Promise<string>;

export function parsePlanDag(raw: string): PlanDag {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Plan is not valid JSON.');
  }
  if (!value || typeof value !== 'object' || !Array.isArray((value as { tasks?: unknown }).tasks)) {
    throw new Error('Plan must be an object with a "tasks" array.');
  }
  const tasks = (value as { tasks: unknown[] }).tasks.map((item, index): PlanTask => {
    if (!item || typeof item !== 'object') throw new Error(`Task ${index} is not an object.`);
    const task = item as Record<string, unknown>;
    if (typeof task.id !== 'string' || task.id.trim() === '') throw new Error(`Task ${index} has no id.`);
    if (typeof task.goal !== 'string' || task.goal.trim() === '') throw new Error(`Task "${task.id}" has no goal.`);
    const dependsOn = task.depends_on ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((dep) => typeof dep !== 'string')) {
      throw new Error(`Task "${task.id}" depends_on must be an array of ids.`);
    }
    return { id: task.id, goal: task.goal, depends_on: [...dependsOn], read_only: task.read_only === true };
  });
  const dag = { tasks };
  validatePlanDag(dag);
  return dag;
}

/** Throws when ids are duplicated, a dependency is unknown or self-referential, or the graph has a cycle. */
export function validatePlanDag(dag: PlanDag): void {
  const ids = new Set<string>();
  for (const task of dag.tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate task id "${task.id}".`);
    ids.add(task.id);
  }
  for (const task of dag.tasks) {
    for (const dep of task.depends_on) {
      if (dep === task.id) throw new Error(`Task "${task.id}" depends on itself.`);
      if (!ids.has(dep)) throw new Error(`Task "${task.id}" depends on unknown task "${dep}".`);
    }
  }
  topologicalLayers(dag);
}

/** Groups tasks into layers; every task's dependencies are in earlier layers. Throws on cycles. */
export function topologicalLayers(dag: PlanDag): PlanTask[][] {
  const done = new Set<string>();
  const layers: PlanTask[][] = [];
  let remaining = [...dag.tasks];
  while (remaining.length > 0) {
    const ready = remaining.filter((task) => task.depends_on.every((dep) => done.has(dep)));
    if (ready.length === 0) {
      throw new Error(`Plan has a dependency cycle among: ${remaining.map((task) => task.id).join(', ')}.`);
    }
    layers.push(ready);
    for (const task of ready) done.add(task.id);
    remaining = remaining.filter((task) => !done.has(task.id));
  }
  return layers;
}

/**
 * Runs the DAG layer by layer. Within a layer, read-only tasks run concurrently (capped by maxParallel);
 * write-capable tasks run sequentially to avoid conflicting file changes. Returns outputs keyed by task id.
 */
export async function runPlanDag(dag: PlanDag, run: PlanTaskRunner, options: PlanRunOptions = {}): Promise<Map<string, string>> {
  const maxParallel = Math.max(1, options.maxParallel ?? 4);
  const outputs = new Map<string, string>();
  for (const layer of topologicalLayers(dag)) {
    const readOnly = layer.filter((task) => task.read_only);
    const writable = layer.filter((task) => !task.read_only);
    for (let start = 0; start < readOnly.length; start += maxParallel) {
      const batch = readOnly.slice(start, start + maxParallel);
      const results = await Promise.all(batch.map((task) => run(task)));
      batch.forEach((task, index) => outputs.set(task.id, results[index] ?? ''));
    }
    for (const task of writable) outputs.set(task.id, await run(task));
  }
  return outputs;
}
