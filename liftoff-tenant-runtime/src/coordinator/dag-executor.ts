import {
  TaskNode,
  TaskGraphCycleError,
  TaskGraphValidationError,
} from './types';

const RESERVED_DEPENDENCY_RESULTS_KEY = '_dependencyResults';

/**
 * Topologically partition tasks into levels. Level N contains tasks whose
 * dependencies are all in earlier levels.
 *
 * Throws TaskGraphCycleError on cycle. Throws TaskGraphValidationError on
 * invalid dependency references (missing id, self-reference, duplicate id).
 */
export function buildLevels(tasks: TaskNode[]): TaskNode[][] {
  // Validation
  const ids = new Set<string>();
  for (const t of tasks) {
    if (!t.id) throw new TaskGraphValidationError('Task missing id');
    if (ids.has(t.id)) throw new TaskGraphValidationError(`Duplicate task id: ${t.id}`);
    ids.add(t.id);
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn ?? []) {
      if (dep === t.id) throw new TaskGraphValidationError(`Self-reference in task ${t.id}`);
      if (!ids.has(dep)) throw new TaskGraphValidationError(`Task ${t.id} depends on unknown task ${dep}`);
    }
  }

  const byId = new Map(tasks.map(t => [t.id, t]));
  const remaining = new Set(tasks.map(t => t.id));
  const placed = new Set<string>();
  const levels: TaskNode[][] = [];

  while (remaining.size > 0) {
    const ready = [...remaining].filter(id => {
      const t = byId.get(id)!;
      return (t.dependsOn ?? []).every(dep => placed.has(dep));
    });
    if (ready.length === 0) {
      throw new TaskGraphCycleError([...remaining]);
    }
    levels.push(ready.map(id => byId.get(id)!));
    for (const id of ready) {
      remaining.delete(id);
      placed.add(id);
    }
  }
  return levels;
}

/**
 * Build the augmented inputData for a task whose dependencies have completed.
 * Reserves a top-level key so the downstream agent can find upstream results.
 */
export function buildAugmentedInput(
  task: TaskNode,
  completedResults: Map<string, unknown>,
): Record<string, unknown> {
  const deps = task.dependsOn ?? [];
  if (deps.length === 0) return task.inputData ?? {};

  const dependencyResults: Record<string, unknown> = {};
  for (const dep of deps) {
    if (completedResults.has(dep)) dependencyResults[dep] = completedResults.get(dep);
  }
  return {
    ...(task.inputData ?? {}),
    [RESERVED_DEPENDENCY_RESULTS_KEY]: dependencyResults,
  };
}

/**
 * Decide whether a task should be skipped because any upstream failed/skipped.
 */
export function shouldSkipForDependency(
  task: TaskNode,
  failedOrSkippedIds: Set<string>,
): string | null {
  for (const dep of task.dependsOn ?? []) {
    if (failedOrSkippedIds.has(dep)) return dep;
  }
  return null;
}

export const _internal = { RESERVED_DEPENDENCY_RESULTS_KEY };
