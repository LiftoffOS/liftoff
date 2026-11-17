// Integration tests for the ASYNC DAG path (delegate-and-await), the half of the
// executor the sync service.test.ts doesn't cover:
//   1. dispatchGraphAsync — creates all child rows (dep-free 'pending',
//      dependent 'blocked'), persists the edges, and dispatches ONLY the
//      dep-free level via Cloud Tasks.
//   2. checkChildTasksCompletion (driven through completeChildTask/failChildTask)
//      — the transactional fan-in: advance newly-unblocked children, cascade-fail
//      dependents of a failed child, and enqueue the paused parent's resume once
//      every child is terminal.
//
// The pool + the transactional client (pool.connect()) are both routed by SQL
// substring; enqueueAgentExecution is mocked so we assert on what got dispatched.

import { CoordinatorService } from '../service';
import { pool } from '../../infrastructure/database';
import { enqueueAgentExecution } from '../../infrastructure/cloud-tasks';
import { AdmissionService } from '../../admission/service';
import {
  createMockWorkflow,
  createMockTask,
  createMockChildTask,
  workflowToDbRow,
  taskToDbRow,
  childTaskToDbRow,
} from '../../test-utils/mocks';

jest.mock('../../infrastructure/database');
jest.mock('../../infrastructure/logging');
jest.mock('../../action-ledger/compensation-service');
jest.mock('../../admission/service');
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

const mockPool = pool as jest.Mocked<typeof pool>;
const mockEnqueue = enqueueAgentExecution as jest.Mock;
const mockAdmissionInstance = AdmissionService.prototype as jest.Mocked<AdmissionService>;

const TENANT = '00000000-0000-1000-8000-000000000001';
const AGENT = '00000000-0000-1000-8000-000000000002';
const PARENT_TASK = 'parent-task-1';
const WORKFLOW = 'wf-1';

type Sql = string | { text?: string };
const sqlText = (s: Sql): string => (typeof s === 'string' ? s : s?.text ?? '');

describe('async DAG executor', () => {
  let service: CoordinatorService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAdmissionInstance.checkAdmission = jest.fn().mockResolvedValue({ allowed: true });
    service = new CoordinatorService();
  });

  // ────────────────────────────────────────────────────────────────────────
  // dispatchGraphAsync
  // ────────────────────────────────────────────────────────────────────────
  describe('dispatchGraphAsync', () => {
    function installSpawnRouters() {
      const inserted: Array<{ id: string; objective: string }> = [];
      const deps: Array<{ taskId: string; dependsOn: string }> = [];
      const statusUpdates: Array<{ id: string; status: string }> = [];
      let n = 0;

      (mockPool.query as jest.Mock).mockImplementation((sql: Sql, params?: unknown[]) => {
        const t = sqlText(sql);
        const p = (params ?? []) as string[];
        if (t.includes('FROM workflow_tasks WHERE id')) {
          return Promise.resolve({ rows: [taskToDbRow(createMockTask({ id: PARENT_TASK, workflowId: WORKFLOW }))], rowCount: 1 });
        }
        if (t.includes('FROM workflows WHERE id')) {
          return Promise.resolve({ rows: [workflowToDbRow(createMockWorkflow({ id: WORKFLOW, tenantId: TENANT, agentId: AGENT }))], rowCount: 1 });
        }
        if (t.includes('INSERT INTO child_tasks')) {
          n += 1;
          const id = `child-${n}`;
          inserted.push({ id, objective: p[2] });
          return Promise.resolve({
            rows: [childTaskToDbRow(createMockChildTask({ id, parentTaskId: p[0], workflowId: p[1], objective: p[2] }))],
            rowCount: 1,
          });
        }
        if (t.includes('UPDATE child_tasks SET status =')) {
          statusUpdates.push({ id: p[0], status: p[1] });
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
        if (t.includes('workflow_task_dependencies')) {
          deps.push({ taskId: p[0], dependsOn: p[1] });
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 }); // delegation_spawn_pause etc.
      });

      return { inserted, deps, statusUpdates };
    }

    it('dispatches only the dep-free level; marks dependents blocked; persists edges', async () => {
      const { inserted, deps, statusUpdates } = installSpawnRouters();

      const out = await service.dispatchGraphAsync({
        parentTaskId: PARENT_TASK,
        workflowId: WORKFLOW,
        agentId: AGENT,
        tenantId: TENANT,
        tasks: [
          { id: 'A', objective: 'A' },
          { id: 'B', objective: 'B', dependsOn: ['A'] },
        ],
      });

      // Both rows created; only A (dep-free) dispatched.
      expect(inserted.map(i => i.objective)).toEqual(['A', 'B']);
      expect(out.childTaskIds).toEqual(['child-1', 'child-2']);
      expect(mockEnqueue).toHaveBeenCalledTimes(1);

      const [tenantArg, agentArg, opts] = mockEnqueue.mock.calls[0];
      expect(tenantArg).toBe(TENANT);
      expect(agentArg).toBe(AGENT);
      expect(opts.queue).toBe('child-tasks');
      expect(opts.receiverPath).toBe('/api/tasks/child-execution');
      expect(opts.receiverBody.childTaskId).toBe('child-1'); // A

      // B (the dependent) was flipped to 'blocked'; edge B→A persisted.
      expect(statusUpdates).toContainEqual({ id: 'child-2', status: 'blocked' });
      expect(deps).toContainEqual({ taskId: 'child-2', dependsOn: 'child-1' });
    });

    it('C1: creates + dispatches children even with NO parent-task/workflow rows (free-UUID grouping)', async () => {
      // The lookups the OLD code verified return empty. If the existence/ownership
      // checks were still present, this would throw "Parent task not found".
      let n = 0;
      (mockPool.query as jest.Mock).mockImplementation((sql: Sql, params?: unknown[]) => {
        const t = sqlText(sql);
        const p = (params ?? []) as string[];
        if (t.includes('FROM workflow_tasks WHERE id')) return Promise.resolve({ rows: [], rowCount: 0 });
        if (t.includes('FROM workflows WHERE id')) return Promise.resolve({ rows: [], rowCount: 0 });
        if (t.includes('INSERT INTO child_tasks')) {
          n += 1;
          return Promise.resolve({ rows: [childTaskToDbRow(createMockChildTask({ id: `k-${n}`, parentTaskId: p[0], objective: p[2] }))], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const out = await service.dispatchGraphAsync({
        parentTaskId: 'free-uuid-parent', workflowId: 'free-uuid-workflow',
        agentId: AGENT, tenantId: TENANT, tasks: [{ id: 'A', objective: 'A' }],
      });

      expect(out.childTaskIds).toEqual(['k-1']);
      expect(mockEnqueue).toHaveBeenCalledTimes(1);
      expect(mockEnqueue.mock.calls[0][2].receiverBody.childTaskId).toBe('k-1');
    });

    it('rejects a fan-out that exceeds the tenant cap before creating any row', async () => {
      const { inserted } = installSpawnRouters();
      // Default fan-out cap is 16; ask for 17.
      const tasks = Array.from({ length: 17 }, (_, i) => ({ id: `t${i}`, objective: `t${i}` }));

      await expect(
        service.dispatchGraphAsync({ parentTaskId: PARENT_TASK, workflowId: WORKFLOW, agentId: AGENT, tenantId: TENANT, tasks }),
      ).rejects.toMatchObject({ code: 'fanout_exceeded' });

      expect(inserted).toHaveLength(0);
      expect(mockEnqueue).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // checkChildTasksCompletion (via completeChildTask / failChildTask)
  // ────────────────────────────────────────────────────────────────────────
  describe('checkChildTasksCompletion fan-in', () => {
    // Routes the pool (repo reads/writes) and the transactional client
    // (pool.connect()) that checkChildTasksCompletion opens.
    async function installFanInRouters(opts: {
      mutatedStatus: 'completed' | 'failed';
      pauseRows?: unknown[];
      advancedRows?: Array<{ id: string; objective: string; agent_id: string | null }>;
      pendingCount?: string;
      childrenRows?: unknown[];
    }) {
      const { mutatedStatus, pauseRows = [], advancedRows = [], pendingCount = '0', childrenRows = [] } = opts;
      const childRow = childTaskToDbRow(createMockChildTask({ id: 'child-1', parentTaskId: PARENT_TASK, status: 'running' }));
      const mutatedRow = childTaskToDbRow(createMockChildTask({ id: 'child-1', parentTaskId: PARENT_TASK, status: mutatedStatus }));

      (mockPool.query as jest.Mock).mockImplementation((sql: Sql) => {
        const t = sqlText(sql);
        if (t.includes('SELECT * FROM child_tasks WHERE id')) return Promise.resolve({ rows: [childRow], rowCount: 1 });
        if (t.includes('UPDATE child_tasks') && t.includes("'completed'")) return Promise.resolve({ rows: [mutatedRow], rowCount: 1 });
        if (t.includes('UPDATE child_tasks') && t.includes("'failed'")) return Promise.resolve({ rows: [mutatedRow], rowCount: 1 });
        if (t.includes('SELECT * FROM child_tasks WHERE parent_task_id')) return Promise.resolve({ rows: childrenRows, rowCount: childrenRows.length });
        if (t.includes('UPDATE workflow_tasks')) return Promise.resolve({ rows: [], rowCount: 1 });
        if (t.includes('workflow_task_dependencies')) return Promise.resolve({ rows: [], rowCount: 0 });
        if (t.includes('SELECT input_data FROM child_tasks')) return Promise.resolve({ rows: [{ input_data: {} }], rowCount: 1 });
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const client = await (mockPool.connect as jest.Mock)();
      (client.query as jest.Mock).mockImplementation((sql: Sql) => {
        const t = sqlText(sql);
        if (t.includes('agent_scheduled_invocations')) return Promise.resolve({ rows: pauseRows, rowCount: pauseRows.length });
        if (t.includes("SET status='pending'")) return Promise.resolve({ rows: advancedRows, rowCount: advancedRows.length });
        if (t.includes('count(*)')) return Promise.resolve({ rows: [{ pending: pendingCount }], rowCount: 1 });
        return Promise.resolve({ rows: [], rowCount: 0 }); // BEGIN / lock / cascade-fail / COMMIT
      });
      return client;
    }

    const pausedParent = [{
      id: 'sched-1',
      scheduled_by_invocation_id: 'inv-parent',
      agent_id: AGENT,
      tenant_id: TENANT,
      workflow_resume_payload: { delegationHitlLevel: 3 },
    }];

    it('enqueues the paused parent resume once every child is terminal', async () => {
      await installFanInRouters({
        mutatedStatus: 'completed',
        pauseRows: pausedParent,
        advancedRows: [],
        pendingCount: '0', // all terminal
        childrenRows: [childTaskToDbRow(createMockChildTask({ id: 'child-1', parentTaskId: PARENT_TASK, status: 'completed' }))],
      });

      await service.completeChildTask('child-1', { ok: true });

      const resume = mockEnqueue.mock.calls.find(c => c[2]?.receiverBody?.workflowResume?.kind === 'delegation-resolved');
      expect(resume).toBeDefined();
      expect(resume![0]).toBe(TENANT);
      expect(resume![1]).toBe(AGENT);
      expect(resume![2].receiverPath).toBe('/api/tasks/resume-execution');
      expect(resume![2].receiverBody.workflowResume).toMatchObject({
        kind: 'delegation-resolved',
        scheduledInvocationId: 'sched-1',
        parentTaskId: PARENT_TASK,
      });
    });

    it('advances a newly-unblocked child (dispatches it) and does NOT resume while work remains', async () => {
      await installFanInRouters({
        mutatedStatus: 'completed',
        pauseRows: pausedParent,
        advancedRows: [{ id: 'child-x', objective: 'downstream', agent_id: null }],
        pendingCount: '1', // still outstanding → no resume yet
      });

      await service.completeChildTask('child-1', { ok: true });

      // The unblocked child was dispatched to the child-execution receiver...
      const childDispatch = mockEnqueue.mock.calls.find(c => c[2]?.receiverPath === '/api/tasks/child-execution');
      expect(childDispatch).toBeDefined();
      expect(childDispatch![2].receiverBody.childTaskId).toBe('child-x');
      // ...and NO parent resume fired (graph not yet all-terminal).
      const resume = mockEnqueue.mock.calls.find(c => c[2]?.receiverBody?.workflowResume?.kind === 'delegation-resolved');
      expect(resume).toBeUndefined();
    });

    it('failChildTask runs the fan-in and issues the dependency cascade-fail sweep', async () => {
      const client = await installFanInRouters({
        mutatedStatus: 'failed',
        pauseRows: [],
        advancedRows: [],
        pendingCount: '0',
      });

      await service.failChildTask('child-1', 'boom');

      // The transactional cascade-fail UPDATE was issued (main's failChildTask
      // never ran the fan-in at all).
      const cascadeIssued = (client.query as jest.Mock).mock.calls.some(
        c => sqlText(c[0]).includes("error='dependency_failed'"),
      );
      expect(cascadeIssued).toBe(true);
    });

    // Regression guard for the failed-dep bug: a child whose
    // dependency FAILED must be cascade-failed, NOT advanced to 'pending'. The unit
    // harness mocks the DB (it can't execute the WHERE-clause semantics that hid the
    // bug), so assert the SQL SHAPE: advance gates on all-deps-completed, and cascade
    // is transitive (recursive) so a failure takes the whole downstream with it.
    it('advance gates on all-deps-completed; cascade-fail is transitive (SQL-shape guard)', async () => {
      const client = await installFanInRouters({
        mutatedStatus: 'failed', pauseRows: [], advancedRows: [], pendingCount: '0',
      });
      await service.failChildTask('child-1', 'boom');
      const sqls = (client.query as jest.Mock).mock.calls.map(c => sqlText(c[0]));
      const advance = sqls.find(s => s.includes("SET status='pending'")) ?? '';
      const cascade = sqls.find(s => s.includes("error='dependency_failed'")) ?? '';
      // Advance must require every dep 'completed' — a 'failed' dep must NOT satisfy it.
      expect(advance).toContain("dep.status <> 'completed'");
      expect(advance).not.toContain("NOT IN ('completed','failed')");
      // Cascade must transitively fail the whole downstream (recursive CTE), not just
      // direct dependents.
      expect(cascade).toContain('RECURSIVE doomed');
    });
  });
});
