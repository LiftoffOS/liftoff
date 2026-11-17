// Integration tests for CoordinatorService.executeTaskGraph (Phase 2 DAG executor).
//
// Pool queries are routed by a simple SQL-prefix matcher so the executor's
// orchestration (spawn -> persist deps -> wait -> collect) can be exercised
// end-to-end without a real database. The matcher captures inserted child
// tasks so subsequent SELECTs return them in 'completed' (or 'failed') state
// to keep the polling tight.

import { CoordinatorService } from '../service';
import { pool } from '../../infrastructure/database';
import { TaskGraphCycleError } from '../types';
import {
  createMockWorkflow,
  createMockTask,
  workflowToDbRow,
  taskToDbRow,
} from '../../test-utils/mocks';

jest.mock('../../infrastructure/database');
jest.mock('../../infrastructure/logging');
jest.mock('../../action-ledger/compensation-service');
jest.mock('../../admission/service');
// The DAG executor now gates the fan-out (admission + tenant caps) and dispatches
// each child via Cloud Tasks. Mock those new dependencies: caps resolve to
// defaults (empty config → applyClamp falls back), and the Cloud Tasks enqueue is
// a no-op (the SQL-router below already lands children in a terminal state).
jest.mock('../../tenant-runtime-config/service', () => ({
  ...jest.requireActual('../../tenant-runtime-config/service'),
  getTenantRuntimeConfig: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../infrastructure/cloud-tasks', () => ({
  enqueueAgentExecution: jest.fn().mockResolvedValue(undefined),
  createTask: jest.fn().mockResolvedValue(undefined),
  scheduleTask: jest.fn().mockResolvedValue(undefined),
  cancelScheduledAgentExecution: jest.fn().mockResolvedValue(undefined),
}));

import { AdmissionService } from '../../admission/service';

const mockPool = pool as jest.Mocked<typeof pool>;
const mockAdmissionInstance = AdmissionService.prototype as jest.Mocked<AdmissionService>;

const TENANT_ID = '00000000-0000-1000-8000-000000000001';
const AGENT_ID = '00000000-0000-1000-8000-000000000002';
const PARENT_TASK_ID = 'task-test-123';
const WORKFLOW_ID = 'wf-test-123';

type ChildRow = {
  id: string;
  parent_task_id: string;
  workflow_id: string;
  task_type: 'subtask' | 'subworkflow';
  objective: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result: any;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  agent_id: string | null;
  input_data: any;
};

// Configure a SQL-routing mock for the pool. Each test provides a "behavior"
// closure that decides how each new child task should resolve (completed +
// result, or failed + error), based on the inserted objective.
function setupPool(behavior: (objective: string, inputData: any) => { status: 'completed' | 'failed'; result?: any; error?: string }) {
  const childTasks: ChildRow[] = [];
  let childCounter = 0;
  const insertedDeps: Array<{ taskId: string; dependsOnTaskId: string }> = [];

  (mockPool.query as jest.Mock).mockImplementation((sql: string, params?: any[]) => {
    const text = typeof sql === 'string' ? sql : (sql as any).text || '';
    if (text.includes('FROM workflow_tasks') && text.includes('WHERE id = $1')) {
      return Promise.resolve({ rows: [taskToDbRow(createMockTask({ id: PARENT_TASK_ID, workflowId: WORKFLOW_ID }))], rowCount: 1 });
    }
    if (text.includes('FROM workflows') && text.includes('WHERE id = $1')) {
      return Promise.resolve({
        rows: [workflowToDbRow(createMockWorkflow({ id: WORKFLOW_ID, tenantId: TENANT_ID, agentId: AGENT_ID }))],
        rowCount: 1,
      });
    }
    if (text.startsWith('INSERT INTO child_tasks')) {
      childCounter += 1;
      const id = `child-${childCounter}`;
      const objective = params?.[2] as string;
      const inputData = JSON.parse(params?.[3] as string);
      const decision = behavior(objective, inputData);
      const now = new Date();
      const row: ChildRow = {
        id,
        parent_task_id: params?.[0] as string,
        workflow_id: params?.[1] as string,
        task_type: 'subtask',
        objective,
        status: decision.status,
        result: decision.status === 'completed' ? (decision.result ?? null) : null,
        error: decision.status === 'failed' ? (decision.error ?? 'failed') : null,
        created_at: now,
        updated_at: now,
        completed_at: now,
        agent_id: (params?.[4] as string | null) ?? null,
        input_data: inputData,
      };
      childTasks.push(row);
      return Promise.resolve({ rows: [row], rowCount: 1 });
    }
    if (text.includes('INSERT INTO workflow_task_dependencies')) {
      insertedDeps.push({ taskId: params?.[0] as string, dependsOnTaskId: params?.[1] as string });
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (text.includes('FROM child_tasks') && text.includes('parent_task_id = $1')) {
      return Promise.resolve({ rows: childTasks, rowCount: childTasks.length });
    }
    // Default empty response
    return Promise.resolve({ rows: [], rowCount: 0 });
  });

  return { childTasks, insertedDeps };
}

describe('CoordinatorService.executeTaskGraph', () => {
  let service: CoordinatorService;

  beforeEach(() => {
    jest.clearAllMocks();
    // Fan-out admission is allowed by default; individual tests can override.
    mockAdmissionInstance.checkAdmission = jest.fn().mockResolvedValue({ allowed: true });
    service = new CoordinatorService();
  });

  it('3-task linear chain: children spawn in level order; inputData includes upstream results', async () => {
    const { childTasks, insertedDeps } = setupPool((obj) => ({
      status: 'completed',
      result: { from: obj },
    }));

    const summary = await service.executeTaskGraph({
      parentTaskId: PARENT_TASK_ID,
      workflowId: WORKFLOW_ID,
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      tasks: [
        { id: 'A', objective: 'A' },
        { id: 'B', objective: 'B', dependsOn: ['A'] },
        { id: 'C', objective: 'C', dependsOn: ['B'] },
      ],
    });

    expect(summary.totalTasks).toBe(3);
    expect(summary.completed).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.skipped).toBe(0);

    // Spawned in level order — A first, then B, then C.
    expect(childTasks.map(c => c.objective)).toEqual(['A', 'B', 'C']);

    // B receives A's result via _dependencyResults; C receives B's.
    const b = childTasks.find(c => c.objective === 'B');
    const cTask = childTasks.find(c => c.objective === 'C');
    expect(b?.input_data._dependencyResults).toEqual({ A: { from: 'A' } });
    expect(cTask?.input_data._dependencyResults).toEqual({ B: { from: 'B' } });

    // Dependency edges persisted: B->A, C->B.
    expect(insertedDeps).toEqual([
      { taskId: 'child-2', dependsOnTaskId: 'child-1' },
      { taskId: 'child-3', dependsOnTaskId: 'child-2' },
    ]);

    // Results returned in declaration order.
    expect(summary.results.map(r => r.id)).toEqual(['A', 'B', 'C']);
  });

  it('diamond: level-2 task sees both level-1 results', async () => {
    const { childTasks } = setupPool((obj) => ({
      status: 'completed',
      result: { from: obj },
    }));

    const summary = await service.executeTaskGraph({
      parentTaskId: PARENT_TASK_ID,
      workflowId: WORKFLOW_ID,
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      tasks: [
        { id: 'A', objective: 'A' },
        { id: 'B', objective: 'B', dependsOn: ['A'] },
        { id: 'C', objective: 'C', dependsOn: ['A'] },
        { id: 'D', objective: 'D', dependsOn: ['B', 'C'] },
      ],
    });

    expect(summary.completed).toBe(4);
    const d = childTasks.find(c => c.objective === 'D');
    expect(d?.input_data._dependencyResults).toEqual({
      B: { from: 'B' },
      C: { from: 'C' },
    });
  });

  it('mid-level failure: downstream dependent is skipped; sibling without dep runs', async () => {
    setupPool((obj) => {
      if (obj === 'B') return { status: 'failed', error: 'boom' };
      return { status: 'completed', result: { from: obj } };
    });

    const summary = await service.executeTaskGraph({
      parentTaskId: PARENT_TASK_ID,
      workflowId: WORKFLOW_ID,
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      tasks: [
        { id: 'A', objective: 'A' },
        { id: 'B', objective: 'B', dependsOn: ['A'] },
        { id: 'D', objective: 'D', dependsOn: ['A'] },
        { id: 'C', objective: 'C', dependsOn: ['B'] },
      ],
    });

    const byId = new Map(summary.results.map(r => [r.id, r]));
    expect(byId.get('A')?.status).toBe('completed');
    expect(byId.get('B')?.status).toBe('failed');
    expect(byId.get('D')?.status).toBe('completed');
    expect(byId.get('C')?.status).toBe('skipped');
    expect(byId.get('C')?.error).toBe('dependency_failed: B');
  });

  it('graph_timeout: tasks in subsequent levels are skipped with error: graph_timeout', async () => {
    const { childTasks } = setupPool((obj) => ({
      status: 'completed',
      result: { from: obj },
    }));

    // Drive the wall-clock check deterministically: time stays at 0 across the
    // three Date.now() calls that execute during level 0 (graphStartTime, level-0
    // timeout check, wait-loop check — the wait deadline is now passed in, so
    // waitForChildTasksInSet no longer reads its own startTime). On the level-1
    // timeout check it jumps past graph_timeout_ms = 5000 so the executor
    // short-circuits.
    const nowSpy = jest.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(100_000);

    try {
      const summary = await service.executeTaskGraph({
        parentTaskId: PARENT_TASK_ID,
        workflowId: WORKFLOW_ID,
        agentId: AGENT_ID,
        tenantId: TENANT_ID,
        graphTimeoutMs: 5000,
        tasks: [
          { id: 'A', objective: 'A' },
          { id: 'B', objective: 'B', dependsOn: ['A'] },
        ],
      });

      // Level 0 (A) ran; level 1 (B) skipped with graph_timeout reason.
      expect(summary.completed).toBe(1);
      expect(summary.skipped).toBe(1);
      const a = summary.results.find(r => r.id === 'A');
      const b = summary.results.find(r => r.id === 'B');
      expect(a?.status).toBe('completed');
      expect(b?.status).toBe('skipped');
      expect(b?.error).toBe('graph_timeout');
      expect(b?.childTaskId).toBeNull();

      // Only A's child was spawned; B never reached the spawn path.
      expect(childTasks.map(c => c.objective)).toEqual(['A']);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('C1: runs with NO parent-task/workflow rows (free-UUID grouping keys)', async () => {
    // The parent-task + workflow lookups the OLD executeTaskGraph verified now
    // return empty. Pre-fix this threw "Parent task <uuid> not found"; the graph
    // path no longer requires anchor rows (migration 305 dropped the child FKs).
    const children: ChildRow[] = [];
    let n = 0;
    (mockPool.query as jest.Mock).mockImplementation((sql: string, params?: any[]) => {
      const text = typeof sql === 'string' ? sql : (sql as any).text || '';
      if (text.includes('FROM workflow_tasks') && text.includes('WHERE id = $1')) return Promise.resolve({ rows: [], rowCount: 0 });
      if (text.includes('FROM workflows') && text.includes('WHERE id = $1')) return Promise.resolve({ rows: [], rowCount: 0 });
      if (text.startsWith('INSERT INTO child_tasks')) {
        n += 1;
        const now = new Date();
        const row: ChildRow = {
          id: `k-${n}`, parent_task_id: params?.[0] as string, workflow_id: params?.[1] as string,
          task_type: 'subtask', objective: params?.[2] as string, status: 'completed',
          result: { ok: true }, error: null, created_at: now, updated_at: now, completed_at: now,
          agent_id: null, input_data: JSON.parse(params?.[3] as string),
        };
        children.push(row);
        return Promise.resolve({ rows: [row], rowCount: 1 });
      }
      if (text.includes('FROM child_tasks') && text.includes('parent_task_id = $1')) return Promise.resolve({ rows: children, rowCount: children.length });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const summary = await service.executeTaskGraph({
      parentTaskId: 'free-uuid-parent', workflowId: 'free-uuid-workflow',
      agentId: AGENT_ID, tenantId: TENANT_ID,
      tasks: [{ id: 'A', objective: 'A' }],
    });

    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it('cycle: throws TaskGraphCycleError before spawning any child', async () => {
    const { childTasks } = setupPool(() => ({ status: 'completed' }));

    await expect(
      service.executeTaskGraph({
        parentTaskId: PARENT_TASK_ID,
        workflowId: WORKFLOW_ID,
        agentId: AGENT_ID,
        tenantId: TENANT_ID,
        tasks: [
          { id: 'A', objective: 'A', dependsOn: ['B'] },
          { id: 'B', objective: 'B', dependsOn: ['A'] },
        ],
      })
    ).rejects.toThrow(TaskGraphCycleError);

    expect(childTasks).toHaveLength(0);
  });
});
