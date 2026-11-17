import {
  buildLevels,
  buildAugmentedInput,
  shouldSkipForDependency,
  _internal,
} from '../dag-executor';
import {
  TaskNode,
  TaskGraphCycleError,
  TaskGraphValidationError,
} from '../types';

describe('buildLevels', () => {
  it('empty tasks → []', () => {
    expect(buildLevels([])).toEqual([]);
  });

  it('single task with no deps → [[task]]', () => {
    const tasks: TaskNode[] = [{ id: 'A', objective: 'A' }];
    const levels = buildLevels(tasks);
    expect(levels).toHaveLength(1);
    expect(levels[0].map(t => t.id)).toEqual(['A']);
  });

  it('linear chain A→B→C → [[A],[B],[C]]', () => {
    const tasks: TaskNode[] = [
      { id: 'A', objective: 'A' },
      { id: 'B', objective: 'B', dependsOn: ['A'] },
      { id: 'C', objective: 'C', dependsOn: ['B'] },
    ];
    const levels = buildLevels(tasks);
    expect(levels.map(l => l.map(t => t.id))).toEqual([['A'], ['B'], ['C']]);
  });

  it('diamond A→{B,C}→D → [[A],[B,C],[D]]', () => {
    const tasks: TaskNode[] = [
      { id: 'A', objective: 'A' },
      { id: 'B', objective: 'B', dependsOn: ['A'] },
      { id: 'C', objective: 'C', dependsOn: ['A'] },
      { id: 'D', objective: 'D', dependsOn: ['B', 'C'] },
    ];
    const levels = buildLevels(tasks);
    expect(levels).toHaveLength(3);
    expect(levels[0].map(t => t.id)).toEqual(['A']);
    expect(levels[1].map(t => t.id).sort()).toEqual(['B', 'C']);
    expect(levels[2].map(t => t.id)).toEqual(['D']);
  });

  it('independent parallel tasks → [[A,B,C]]', () => {
    const tasks: TaskNode[] = [
      { id: 'A', objective: 'A' },
      { id: 'B', objective: 'B' },
      { id: 'C', objective: 'C' },
    ];
    const levels = buildLevels(tasks);
    expect(levels).toHaveLength(1);
    expect(levels[0].map(t => t.id).sort()).toEqual(['A', 'B', 'C']);
  });

  it('cycle A↔B throws TaskGraphCycleError with both ids', () => {
    const tasks: TaskNode[] = [
      { id: 'A', objective: 'A', dependsOn: ['B'] },
      { id: 'B', objective: 'B', dependsOn: ['A'] },
    ];
    expect(() => buildLevels(tasks)).toThrow(TaskGraphCycleError);
    try {
      buildLevels(tasks);
    } catch (e) {
      expect((e as Error).message).toContain('A');
      expect((e as Error).message).toContain('B');
    }
  });

  it('self-reference throws TaskGraphValidationError', () => {
    const tasks: TaskNode[] = [
      { id: 'A', objective: 'A', dependsOn: ['A'] },
    ];
    expect(() => buildLevels(tasks)).toThrow(TaskGraphValidationError);
  });

  it('duplicate id throws TaskGraphValidationError', () => {
    const tasks: TaskNode[] = [
      { id: 'A', objective: 'A1' },
      { id: 'A', objective: 'A2' },
    ];
    expect(() => buildLevels(tasks)).toThrow(TaskGraphValidationError);
  });

  it('missing dep id throws TaskGraphValidationError', () => {
    const tasks: TaskNode[] = [
      { id: 'A', objective: 'A', dependsOn: ['Z'] },
    ];
    expect(() => buildLevels(tasks)).toThrow(TaskGraphValidationError);
  });
});

describe('buildAugmentedInput', () => {
  it('no deps returns original inputData', () => {
    const task: TaskNode = { id: 'A', objective: 'A', inputData: { foo: 1 } };
    expect(buildAugmentedInput(task, new Map())).toEqual({ foo: 1 });
  });

  it('with deps adds _dependencyResults at top level', () => {
    const task: TaskNode = {
      id: 'B',
      objective: 'B',
      dependsOn: ['A'],
      inputData: { bar: 2 },
    };
    const completed = new Map<string, unknown>([['A', { value: 'a-result' }]]);
    const out = buildAugmentedInput(task, completed);
    expect(out).toEqual({
      bar: 2,
      [_internal.RESERVED_DEPENDENCY_RESULTS_KEY]: {
        A: { value: 'a-result' },
      },
    });
  });
});

describe('shouldSkipForDependency', () => {
  it('returns first blocking dep id', () => {
    const task: TaskNode = { id: 'X', objective: 'X', dependsOn: ['A', 'B', 'C'] };
    const failed = new Set(['B', 'C']);
    expect(shouldSkipForDependency(task, failed)).toBe('B');
  });

  it('returns null when all deps clean', () => {
    const task: TaskNode = { id: 'X', objective: 'X', dependsOn: ['A', 'B'] };
    expect(shouldSkipForDependency(task, new Set())).toBeNull();
  });
});
