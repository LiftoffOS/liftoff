// Coordinator Service Implementation
// Per Section 6: Coordinator-driven workflow graph

import {
  Workflow,
  StartWorkflowInput,
  WorkflowTask,
  ChildTask,
  SpawnChildTaskInput,
  SpawnSubWorkflowInput,
  ChildTaskResult,
  SubWorkflowResult,
  WorkflowHierarchy,
  WorkflowCheckpoint,
  ToolCall,
  WorkflowHandoff,
  WorkflowLease,
} from './types';
import { buildLevels, buildAugmentedInput, shouldSkipForDependency } from './dag-executor';
import type { ExecuteTaskGraphInput, ExecuteTaskGraphResult, TaskNode, TaskNodeResult } from './types';
import type { ExecutionAdapter } from './execution-adapter';
import { SandboxedAdapter } from './execution-adapter';
import { agentRunStateService } from '../agent-execution/run-state/service';
import { collapseHistory, buildInputFromItems } from '../agent-execution/handoff-utils';
import { WorkflowRepository, ChildTaskRepository, WorkflowHierarchyRepository } from './repository';
import { ActionRepository } from '../action-ledger/repository';
import { CompensationService } from '../action-ledger/compensation-service';
import { AdmissionService } from '../admission/service';
import { AdmissionDeniedError } from '../admission/types';
import { getToolGatewayDispatcher, type ToolGatewayDispatcher } from '../tool-gateway/dispatcher';
import { reflectionTriggerService } from '../reflection-engine/trigger-service';
import { logger } from '../infrastructure/logging';
import { getPool, getPoolForService } from '../infrastructure/database';
import { randomUUID } from 'node:crypto';
import { enqueueAgentExecution } from '../infrastructure/cloud-tasks';
import { loadDispatchGate, assertFanoutWithinCap, assertDepthWithinCap,
  assertNotSpawnPaused, assertSameTenantAgents, DelegationError } from '../agent-execution/governed-dispatch';
import { child_task_dispatched_total, task_graph_completed_total, task_graph_timeout_total } from '../observability/runtime-extensions-metrics';
import { v4 as uuidv4 } from 'uuid';

// Maximum depth for nested workflows to prevent infinite recursion
const MAX_WORKFLOW_DEPTH = 10;

/** A task nobody is waiting on any more.
 *
 *  `abandoned` has to count here. It is terminal — the dispatcher will not
 *  retry it — so a fan-in that only recognised completed/failed would wait out
 *  its full timeout on a task that had already given up, turning a bounded
 *  failure into a stalled workflow.
 *
 *  `blocked` must NOT count. It means waiting on dependencies, so a fan-in that
 *  treated it as terminal would resume the parent while a child had not run at
 *  all — which is how widening this predicate to cover the failure limit broke
 *  something worse than it fixed. See migration 342. */
const TERMINAL_CHILD_STATUSES = ['completed', 'failed', 'abandoned'] as const;

/** The same set as a SQL list literal. Derived rather than retyped: migration
 *  342 added `abandoned` and three separate places had to learn about it, one
 *  of which did not — `expireGraphIfStuck` kept overwriting abandoned rows to
 *  `failed`/`graph_timeout`, erasing both the real error and the marker saying
 *  the task had given up on its own. Spelling the set once means the next
 *  terminal status cannot be added to the predicate and forgotten in the SQL.
 *  Safe to interpolate: every element is a compile-time literal. */
const TERMINAL_CHILD_STATUS_SQL = TERMINAL_CHILD_STATUSES.map((s) => `'${s}'`).join(',');

function isTerminalChildStatus(status: string): boolean {
  return (TERMINAL_CHILD_STATUSES as readonly string[]).includes(status);
}

export class CoordinatorService {
  private repository = new WorkflowRepository();
  private actionRepository = new ActionRepository();
  private childTaskRepository = new ChildTaskRepository();
  private hierarchyRepository = new WorkflowHierarchyRepository();
  private compensationService = new CompensationService();
  private admissionService = new AdmissionService();
  // Phase 4: dispatcher picks in-process vs HTTP client based on SERVICE_TYPE.
  private toolGateway: ToolGatewayDispatcher = getToolGatewayDispatcher();

  private readonly adapter: ExecutionAdapter = new SandboxedAdapter(this.toolGateway);

  // Per Section 6: Each workflow contains objective, tasks, dependencies,
  // handoffs, checkpoints, leases, escalations, compensation state, final outcome

  async startWorkflow(input: StartWorkflowInput): Promise<Workflow> {
    // Per Section 15: Every workflow passes admission control
    const admission = await this.admissionService.checkAdmission({
      tenantId: input.tenantId,
      agentId: input.agentId,
      checkType: 'workflow',
    });

    if (!admission.allowed) {
      logger.warn({
        tenant_id: input.tenantId,
        agent_id: input.agentId,
        reason: admission.reason,
        quota_type: admission.quotaType,
      }, 'Workflow admission denied');
      throw new AdmissionDeniedError({
        reason: admission.reason ?? 'Admission denied',
        quotaType: admission.quotaType,
        message: `Workflow admission denied: ${admission.reason}`,
      });
    }

    // Per Section 12: Check workflow kill switch
    const workflowKillSwitch = await this.checkWorkflowKillSwitch(
      input.tenantId,
      input.agentId
    );
    if (workflowKillSwitch.disabled) {
      logger.warn({
        tenant_id: input.tenantId,
        agent_id: input.agentId,
        reason: workflowKillSwitch.reason,
      }, 'Workflow blocked by kill switch');
      throw new Error(`Workflow blocked: ${workflowKillSwitch.reason}`);
    }

    // Check workflow depth for nested workflows
    if (input.parentWorkflowId) {
      const parentHierarchy = await this.hierarchyRepository.findByWorkflowId(input.parentWorkflowId);
      if (parentHierarchy && parentHierarchy.depth >= MAX_WORKFLOW_DEPTH) {
        throw new Error(`Maximum workflow nesting depth (${MAX_WORKFLOW_DEPTH}) exceeded`);
      }
    }

    const workflow = await this.repository.create(input);

    // Create hierarchy record
    const depth = input.parentWorkflowId ?
      ((await this.hierarchyRepository.findByWorkflowId(input.parentWorkflowId))?.depth ?? 0) + 1 : 0;

    const rootWorkflowId = input.parentWorkflowId ?
      (await this.hierarchyRepository.findByWorkflowId(input.parentWorkflowId))?.rootWorkflowId ?? workflow.id :
      workflow.id;

    await this.hierarchyRepository.create({
      workflowId: workflow.id,
      parentWorkflowId: input.parentWorkflowId ?? null,
      depth,
      rootWorkflowId,
    });

    logger.info('Started workflow', {
      workflowId: workflow.id,
      tenantId: input.tenantId,
      parentWorkflowId: input.parentWorkflowId,
      depth,
    });

    return workflow;
  }

  async getWorkflow(id: string): Promise<Workflow | null> {
    return this.repository.findById(id);
  }

  async getWorkflowHierarchy(id: string): Promise<WorkflowHierarchy | null> {
    return this.hierarchyRepository.findByWorkflowId(id);
  }

  async getChildWorkflows(parentWorkflowId: string): Promise<Workflow[]> {
    return this.repository.findChildWorkflows(parentWorkflowId);
  }

  // ==========================================
  // Per Section 6: Child Task Spawning
  // Per Section 6: Agent restrictions on workflow graph mutation
  // ==========================================

  async spawnChildTask(input: SpawnChildTaskInput): Promise<ChildTask> {
    // Legacy spawn_child_task path: the caller supplies a REAL parent task +
    // workflow, so verify existence + ownership before mutating the graph.
    // (The DAG executor uses server-generated free-UUID grouping keys and calls
    // insertChildTaskRow directly — see C1 in the DAG review.)
    const parentTask = await this.repository.findTaskById(input.parentTaskId);
    if (!parentTask) {
      throw new Error(`Parent task ${input.parentTaskId} not found`);
    }

    // Per Section 6: Verify agent owns the workflow (agent restrictions on graph mutation)
    const workflow = await this.repository.findById(input.workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${input.workflowId} not found`);
    }

    // Check that the requesting agent owns this workflow
    if (input.agentId && workflow.agentId !== input.agentId) {
      logger.warn('Agent attempted to modify another agent\'s workflow', {
        requestingAgentId: input.agentId,
        workflowAgentId: workflow.agentId,
        workflowId: input.workflowId,
        operation: 'spawnChildTask',
      });
      throw new Error(
        `Agent ${input.agentId} cannot modify workflow owned by agent ${workflow.agentId}`
      );
    }

    // Verify tenant match as additional safety check
    if (input.tenantId && workflow.tenantId !== input.tenantId) {
      throw new Error(`Tenant mismatch: workflow belongs to tenant ${workflow.tenantId}`);
    }

    return this.insertChildTaskRow(input);
  }

  /** Create a child_tasks row (handoff-context objective rewrite + persist) WITHOUT
   *  parent-task/workflow existence or ownership verification. The DAG executor's
   *  parentTaskId/workflowId are free UUIDs minted per-invocation in spawn_task_graph
   *  (migration 305 dropped the child_tasks FKs), so there are no rows to verify and
   *  no cross-agent surface — the ids never come from the model. */
  private async insertChildTaskRow(input: SpawnChildTaskInput): Promise<ChildTask> {
    let childObjective = input.objective;
    if (input.handoffContext && input.parentInvocationId) {
      try {
        const parentRunState = await agentRunStateService.load(input.parentInvocationId);
        if (parentRunState) {
          let contextPrefix = '';
          if (input.handoffContext.collapseHistory?.enabled) {
            contextPrefix = await collapseHistory(parentRunState.items, input.handoffContext.collapseHistory);
          } else if (input.handoffContext.includeLastNMessages) {
            const msgs = parentRunState.items
              .filter(i => i.type === 'message_output')
              .slice(-(input.handoffContext!.includeLastNMessages!));
            contextPrefix = buildInputFromItems(msgs);
          } else if (input.handoffContext.filter) {
            const filtered = input.handoffContext.filter(parentRunState.items);
            contextPrefix = buildInputFromItems(filtered);
          }
          if (contextPrefix) childObjective = `${contextPrefix}\n\nYour task: ${input.objective}`;
        }
      } catch (err) {
        logger.warn({ err }, 'Non-fatal: handoffContext collapseHistory failed — using original objective');
      }
    }

    // Server-owned taint: stamp the parent run's trust into the child's persisted
    // inputData so it inherits when it executes. Only when untrusted, to keep
    // trusted payloads clean. Never sourced from model-provided data.
    const childInputData = input.originTrust === 'untrusted_inbound'
      ? { ...(input.inputData ?? {}), _originTrust: 'untrusted_inbound' as const }
      : input.inputData;

    const childTask = await this.childTaskRepository.create({
      parentTaskId: input.parentTaskId,
      workflowId: input.workflowId,
      objective: childObjective,
      inputData: childInputData,
      executorAgentId: input.executorAgentId,
    });

    logger.info('Spawned child task', {
      childTaskId: childTask.id,
      parentTaskId: input.parentTaskId,
      workflowId: input.workflowId,
      objective: input.objective,
    });

    return childTask;
  }

  async getChildTasks(parentTaskId: string): Promise<ChildTask[]> {
    return this.childTaskRepository.findByParentTaskId(parentTaskId);
  }

  // Per Section 6: Agent restrictions on workflow graph mutation
  async completeChildTask(
    childTaskId: string,
    result: unknown,
    requestingAgentId?: string
  ): Promise<ChildTask> {
    // Get the child task first to find the workflow
    const childTask = await this.childTaskRepository.findById(childTaskId);
    if (!childTask) {
      throw new Error(`Child task ${childTaskId} not found`);
    }

    // Per Section 6: Verify agent owns the workflow before mutation
    if (requestingAgentId) {
      const workflow = await this.repository.findById(childTask.workflowId);
      if (workflow && workflow.agentId !== requestingAgentId) {
        logger.warn('Agent attempted to complete child task in another agent\'s workflow', {
          requestingAgentId,
          workflowAgentId: workflow.agentId,
          childTaskId,
          operation: 'completeChildTask',
        });
        throw new Error(
          `Agent ${requestingAgentId} cannot modify workflow owned by agent ${workflow.agentId}`
        );
      }
    }

    const completedTask = await this.childTaskRepository.complete(childTaskId, result);

    logger.info('Completed child task', {
      childTaskId,
      parentTaskId: completedTask.parentTaskId,
      success: true,
    });

    // Check if all sibling child tasks are complete
    await this.checkChildTasksCompletion(completedTask.parentTaskId);

    return completedTask;
  }

  // Per Section 6: Agent restrictions on workflow graph mutation
  async failChildTask(
    childTaskId: string,
    error: string,
    requestingAgentId?: string
  ): Promise<ChildTask> {
    // Get the child task first to find the workflow
    const childTask = await this.childTaskRepository.findById(childTaskId);
    if (!childTask) {
      throw new Error(`Child task ${childTaskId} not found`);
    }

    // Per Section 6: Verify agent owns the workflow before mutation
    if (requestingAgentId) {
      const workflow = await this.repository.findById(childTask.workflowId);
      if (workflow && workflow.agentId !== requestingAgentId) {
        logger.warn('Agent attempted to fail child task in another agent\'s workflow', {
          requestingAgentId,
          workflowAgentId: workflow.agentId,
          childTaskId,
          operation: 'failChildTask',
        });
        throw new Error(
          `Agent ${requestingAgentId} cannot modify workflow owned by agent ${workflow.agentId}`
        );
      }
    }

    const failedTask = await this.childTaskRepository.fail(childTaskId, error);

    logger.error('Child task failed', {
      childTaskId,
      parentTaskId: failedTask.parentTaskId,
      error,
    });

    await this.checkChildTasksCompletion(failedTask.parentTaskId);
    return failedTask;
  }

  private async checkChildTasksCompletion(parentTaskId: string): Promise<void> {
    const pool = getPoolForService('scheduled-execution');
    const client = await pool.connect();
    // Newly-unblocked children to dispatch AFTER the lock/commit (no network in-txn).
    let toAdvance: Array<{ id: string; objective: string; agent_id: string | null }> = [];
    let allTerminal = false;
    // Async-graph parent context (present only when a parent is paused on this graph).
    let parent: { id: string; scheduled_by_invocation_id: string; agent_id: string; tenant_id: string; hitl_level: number | null } | null = null;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [parentTaskId]);

      // Resolve the paused parent (async multi-level dispatch + fan-in target).
      const pauseRow = await client.query<{ id: string; scheduled_by_invocation_id: string; agent_id: string; tenant_id: string; workflow_resume_payload: { delegationHitlLevel?: number } | null }>(
        `SELECT id, scheduled_by_invocation_id, agent_id, tenant_id, workflow_resume_payload
           FROM agent_scheduled_invocations WHERE context_ref = $1 AND status = 'pending' LIMIT 1`, [`deleg:${parentTaskId}`]);
      if (pauseRow.rows.length > 0) {
        const pr = pauseRow.rows[0];
        parent = { id: pr.id, scheduled_by_invocation_id: pr.scheduled_by_invocation_id, agent_id: pr.agent_id, tenant_id: pr.tenant_id, hitl_level: pr.workflow_resume_payload?.delegationHitlLevel ?? null };
      }

      // A) Cascade-fail FIRST: transitively fail every blocked child that depends —
      // directly or through a chain — on a FAILED child, so a failed task takes its
      // whole downstream with it (mirrors the sync path's shouldSkipForDependency).
      // Must run before advance (B): otherwise a child whose dep FAILED would be
      // advanced to 'pending' and dispatched to run without its upstream input.
      await client.query(
        `WITH RECURSIVE doomed(id) AS (
           SELECT c.id FROM child_tasks c
             JOIN workflow_task_dependencies d ON d.task_id = c.id
             JOIN child_tasks dep ON dep.id = d.depends_on_task_id
            WHERE c.parent_task_id = $1 AND c.status = 'blocked' AND dep.status = 'failed'
           UNION
           SELECT c.id FROM child_tasks c
             JOIN workflow_task_dependencies d ON d.task_id = c.id
             JOIN doomed dm ON dm.id = d.depends_on_task_id
            WHERE c.parent_task_id = $1 AND c.status = 'blocked')
         UPDATE child_tasks SET status='failed', error='dependency_failed', updated_at=NOW()
           WHERE id IN (SELECT id FROM doomed)`, [parentTaskId]);
      // B) Advance blocked children whose deps are ALL 'completed'. A failed dep (just
      // cascaded above) or a still-running dep blocks advancement — only a fully
      // successful upstream lets a child proceed.
      const advanced = await client.query<{ id: string; objective: string; agent_id: string | null }>(
        `UPDATE child_tasks c SET status='pending', updated_at=NOW()
           WHERE c.parent_task_id=$1 AND c.status='blocked'
             AND NOT EXISTS (
               SELECT 1 FROM workflow_task_dependencies d
               JOIN child_tasks dep ON dep.id = d.depends_on_task_id
               WHERE d.task_id = c.id AND dep.status <> 'completed')
         RETURNING c.id, c.objective, c.agent_id`, [parentTaskId]);
      toAdvance = advanced.rows;
      // B) recount AFTER advancing.
      const pend = await client.query<{ pending: string }>(
        // An abandoned task has given up; counting it as pending would hold the
        // whole graph open on a task nothing will ever run again.
        `SELECT count(*) FILTER (WHERE status NOT IN (${TERMINAL_CHILD_STATUS_SQL})) AS pending FROM child_tasks WHERE parent_task_id=$1`, [parentTaskId]);
      allTerminal = Number(pend.rows[0].pending) === 0;
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* already terminated */ }
      throw e;
    } finally {
      client.release();
    }

    // C) dispatch the newly-unblocked (outside the lock). Only possible for an
    // async-paused graph (which carries the parent context); sync graphs never
    // create 'blocked' rows so toAdvance is empty.
    if (parent && toAdvance.length > 0) {
      const gInput = {
        parentTaskId, workflowId: '', agentId: parent.agent_id, tenantId: parent.tenant_id,
        parentInvocationId: parent.scheduled_by_invocation_id, hitlLevel: parent.hitl_level ?? undefined,
      } as ExecuteTaskGraphInput;
      // Advanced children are the SAME graph level as the first wave, so they carry
      // the same depth = parentInvocation.delegation_depth + 1 (not a hardcoded 1,
      // which would let a nested graph under-report depth and evade the depth cap).
      const dpool = getPoolForService('default');
      const depthRow = await dpool.query<{ delegation_depth: number | null }>(
        'SELECT delegation_depth FROM invocations WHERE id = $1', [parent.scheduled_by_invocation_id]);
      const advancedDepth = (depthRow.rows[0]?.delegation_depth ?? 0) + 1;
      for (const row of toAdvance) {
        await this.dispatchChild(
          { id: row.id } as ChildTask,
          { id: row.id, objective: row.objective, executorAgentId: row.agent_id ?? undefined } as unknown as TaskNode,
          gInput, advancedDepth, await this.buildDepInput(row.id),
        );
      }
    }

    if (!allTerminal) return;   // still work outstanding → no aggregation / resume yet

    // All terminal → aggregate results + (if a parent is paused) enqueue its resume.
    const children = await this.childTaskRepository.findByParentTaskId(parentTaskId);
    const results: ChildTaskResult[] = children.map(t => ({ childTaskId: t.id, success: t.status === 'completed', result: t.result, error: t.error }));
    await this.repository.updateTaskChildResults(parentTaskId, results);

    if (parent) {
      await enqueueAgentExecution(parent.tenant_id, parent.agent_id, {
        // The parent's ids are recovered by resumeFromDelegation from its pause row; none passed here.
        objective: 'delegation-resolved', threadId: '',
        triggeredBy: 'agent', scheduleKey: `deleg-resume-${parentTaskId}`,   // deterministic → Cloud Tasks dedups
        contextRef: `deleg:${parentTaskId}`, receiverPath: '/api/tasks/resume-execution',
        receiverBody: {
          invocationId: parent.scheduled_by_invocation_id, tenantId: parent.tenant_id, agentId: parent.agent_id,
          workflowResume: { kind: 'delegation-resolved', scheduledInvocationId: parent.id, parentTaskId },
        },
      });
    }
  }

  private async buildDepInput(childTaskId: string): Promise<Record<string, unknown>> {
    const pool = getPoolForService('default');
    const rows = await pool.query<{ depends_on_task_id: string; result: unknown }>(
      `SELECT d.depends_on_task_id, dep.result FROM workflow_task_dependencies d
         JOIN child_tasks dep ON dep.id=d.depends_on_task_id WHERE d.task_id=$1`, [childTaskId]);
    const deps: Record<string, unknown> = {};
    for (const r of rows.rows) deps[r.depends_on_task_id] = r.result;
    const self = await pool.query<{ input_data: Record<string, unknown> }>(`SELECT input_data FROM child_tasks WHERE id=$1`, [childTaskId]);
    return { ...(self.rows[0]?.input_data ?? {}), _dependencyResults: deps };
  }

  // ==========================================
  // Per Section 6: Sub-Workflow Spawning
  // Per Section 6: Agent restrictions on workflow graph mutation
  // ==========================================

  async spawnSubWorkflow(input: SpawnSubWorkflowInput): Promise<Workflow> {
    // Verify parent task exists
    const parentTask = await this.repository.findTaskById(input.parentTaskId);
    if (!parentTask) {
      throw new Error(`Parent task ${input.parentTaskId} not found`);
    }

    // Per Section 6: Verify agent owns the parent workflow (agent restrictions)
    const parentWorkflow = await this.repository.findById(input.parentWorkflowId);
    if (!parentWorkflow) {
      throw new Error(`Parent workflow ${input.parentWorkflowId} not found`);
    }

    // Check that the requesting agent owns the parent workflow
    if (parentWorkflow.agentId !== input.agentId) {
      logger.warn('Agent attempted to spawn sub-workflow in another agent\'s workflow', {
        requestingAgentId: input.agentId,
        workflowAgentId: parentWorkflow.agentId,
        parentWorkflowId: input.parentWorkflowId,
        operation: 'spawnSubWorkflow',
      });
      throw new Error(
        `Agent ${input.agentId} cannot spawn sub-workflow in workflow owned by agent ${parentWorkflow.agentId}`
      );
    }

    // Verify tenant match
    if (parentWorkflow.tenantId !== input.tenantId) {
      throw new Error(`Tenant mismatch: workflow belongs to tenant ${parentWorkflow.tenantId}`);
    }

    // Create sub-workflow
    const subWorkflow = await this.startWorkflow({
      tenantId: input.tenantId,
      agentId: input.agentId,
      objective: input.objective,
      parentWorkflowId: input.parentWorkflowId,
      parentTaskId: input.parentTaskId,
    });

    // Create child task record to track the sub-workflow
    await this.childTaskRepository.create({
      parentTaskId: input.parentTaskId,
      workflowId: input.parentWorkflowId,
      objective: input.objective,
      inputData: {
        ...input.inputData,
        subWorkflowId: subWorkflow.id,
        taskType: 'subworkflow',
      },
    });

    logger.info('Spawned sub-workflow', {
      subWorkflowId: subWorkflow.id,
      parentWorkflowId: input.parentWorkflowId,
      parentTaskId: input.parentTaskId,
      tenantId: input.tenantId,
    });

    return subWorkflow;
  }

  async completeSubWorkflow(subWorkflowId: string): Promise<SubWorkflowResult> {
    const subWorkflow = await this.repository.findById(subWorkflowId);
    if (!subWorkflow) {
      throw new Error(`Sub-workflow ${subWorkflowId} not found`);
    }

    const hierarchy = await this.hierarchyRepository.findByWorkflowId(subWorkflowId);
    if (!hierarchy || !hierarchy.parentWorkflowId) {
      throw new Error(`Sub-workflow ${subWorkflowId} has no parent`);
    }

    logger.info('Sub-workflow completed', {
      subWorkflowId,
      parentWorkflowId: hierarchy.parentWorkflowId,
      success: subWorkflow.finalOutcome?.success ?? false,
    });

    // Find and update the child task that tracks this sub-workflow
    const parentWorkflow = await this.repository.findById(hierarchy.parentWorkflowId);
    if (parentWorkflow) {
      // Notify parent workflow that sub-workflow completed
      await this.notifyParentWorkflow(hierarchy.parentWorkflowId, subWorkflowId, subWorkflow);
    }

    return {
      subWorkflowId,
      success: subWorkflow.finalOutcome?.success ?? false,
      outcome: subWorkflow.finalOutcome,
    };
  }

  private async notifyParentWorkflow(
    parentWorkflowId: string,
    subWorkflowId: string,
    subWorkflow: Workflow
  ): Promise<void> {
    // Find child tasks in parent workflow that reference this sub-workflow
    const parentWorkflowTasks = await this.repository.findTasksByWorkflowId(parentWorkflowId);

    for (const task of parentWorkflowTasks) {
      const childTasks = await this.childTaskRepository.findByParentTaskId(task.id);

      for (const childTask of childTasks) {
        const inputData = childTask.result as Record<string, unknown> | null;
        if (inputData?.subWorkflowId === subWorkflowId) {
          // Update child task with sub-workflow result
          if (subWorkflow.finalOutcome?.success) {
            await this.childTaskRepository.complete(childTask.id, subWorkflow.finalOutcome);
          } else {
            await this.childTaskRepository.fail(
              childTask.id,
              subWorkflow.finalOutcome?.error ?? 'Sub-workflow failed'
            );
          }
        }
      }
    }
  }

  async waitForChildTasks(parentTaskId: string): Promise<ChildTaskResult[]> {
    // Poll for child task completion
    const maxWaitTime = 30 * 60 * 1000; // 30 minutes
    const pollInterval = 1000; // 1 second
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      const childTasks = await this.childTaskRepository.findByParentTaskId(parentTaskId);
      const allComplete = childTasks.every((t) => isTerminalChildStatus(t.status));

      if (allComplete) {
        return childTasks.map((t) => ({
          childTaskId: t.id,
          success: t.status === 'completed',
          result: t.result,
          error: t.error,
        }));
      }

      // Wait before polling again
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error(`Timeout waiting for child tasks of ${parentTaskId}`);
  }

  private async dispatchChild(
    child: ChildTask,
    task: TaskNode,
    input: ExecuteTaskGraphInput,
    childDepth: number,
    augmentedInput: Record<string, unknown>,   // the SAME input persisted on the row (incl. _dependencyResults)
  ): Promise<void> {
    const executorAgentId = task.executorAgentId ?? input.agentId;
    const childWorkflowId = randomUUID();
    const childTaskId = randomUUID();          // synthetic run context (matches /agent-scheduled)
    await enqueueAgentExecution(input.tenantId, executorAgentId, {
      queue: 'child-tasks',                    // dedicated queue (see cloud-tasks.ts edit)
      workflowId: childWorkflowId, taskId: childTaskId,
      objective: task.objective, threadId: '',
      triggeredBy: 'agent', triggeredByLabel: `child_task:${child.id}`,
      scheduleKey: child.id,                   // stable → dedup; becomes executeTask triggerKey
      contextRef: `child:${child.id}`,         // cancellable via cancelScheduledAgentExecution
      receiverPath: '/api/tasks/child-execution',
      receiverBody: {
        tenantId: input.tenantId, agentId: executorAgentId,
        workflowId: childWorkflowId, taskId: childTaskId,
        objective: task.objective,
        inputData: augmentedInput,             // real deps (buildAugmentedInput(task, completedResults))
        childTaskId: child.id,
        parentInvocationId: input.parentInvocationId,
        delegationDepth: childDepth,
        triggerKey: child.id,
        hitlLevel: input.hitlLevel,
        execTimeoutMsOverride: 240_000,        // Gap-4: finalize inside the 270s delivery
      },
    });
    child_task_dispatched_total.inc({ tenant_id: input.tenantId });
  }

  /** Orphan backstop for async graphs: fail any non-terminal children so the
   *  graph becomes all-terminal, letting the parent resume with partial results
   *  (invoked from the delegation-expiry Cloud Task).
   *
   *  Only non-terminal children are touched. A task that reached its failure
   *  limit is already terminal and already carries the error that explains why;
   *  restamping it `graph_timeout` would replace a real diagnosis with the
   *  generic one and lose the record that the task gave up on its own. */
  async expireGraphIfStuck(parentTaskId: string): Promise<void> {
    const pool = getPoolForService('default');
    await pool.query(
      `UPDATE child_tasks SET status='failed', error='graph_timeout', completed_at=NOW(), updated_at=NOW()
         WHERE parent_task_id=$1 AND status NOT IN (${TERMINAL_CHILD_STATUS_SQL})`, [parentTaskId]);
  }

  async dispatchGraphAsync(input: ExecuteTaskGraphInput): Promise<{ childTaskIds: string[] }> {
    const admit = await this.admissionService.checkAdmission({ tenantId: input.tenantId, agentId: input.agentId, checkType: 'task' });
    if (!admit.allowed) throw new DelegationError(`Fan-out blocked: ${admit.reason}`, 'admission_denied');
    const gate = await loadDispatchGate(input.tenantId);
    await assertNotSpawnPaused(input.tenantId);
    assertFanoutWithinCap(input.tasks.length, gate, input.tenantId);
    const childDepth = input.parentInvocationId ? await assertDepthWithinCap(input.parentInvocationId, gate) : 1;
    await assertSameTenantAgents(input.tenantId, input.agentId, input.tasks.map(t => t.executorAgentId).filter((x): x is string => !!x));
    buildLevels(input.tasks);   // validates DAG (throws on cycle) — result unused here

    // 1) create ALL rows; localId → childTaskId; dep-free = 'pending', dependent = 'blocked'
    const idByLocal = new Map<string, string>();
    for (const t of input.tasks) {
      const child = await this.insertChildTaskRow({ parentTaskId: input.parentTaskId, workflowId: input.workflowId, objective: t.objective,
        inputData: t.inputData ?? {}, agentId: input.agentId, executorAgentId: t.executorAgentId, tenantId: input.tenantId, parentInvocationId: input.parentInvocationId, originTrust: input.originTrust });
      idByLocal.set(t.id, child.id);
      if ((t.dependsOn ?? []).length > 0) await this.childTaskRepository.updateStatus(child.id, 'blocked');
    }
    // 2) persist dependency edges (childTaskId → depChildTaskId)
    for (const t of input.tasks)
      for (const dep of t.dependsOn ?? [])
        await this.repository.insertTaskDependency(idByLocal.get(t.id)!, idByLocal.get(dep)!);
    // 3) dispatch dep-free nodes now
    const dispatched: string[] = [];
    for (const t of input.tasks) if ((t.dependsOn ?? []).length === 0) {
      await this.dispatchChild({ id: idByLocal.get(t.id)! } as ChildTask, t, input, childDepth, buildAugmentedInput(t, new Map()));
      dispatched.push(idByLocal.get(t.id)!);
    }
    return { childTaskIds: [...idByLocal.values()] };
  }

  async executeTaskGraph(input: ExecuteTaskGraphInput): Promise<ExecuteTaskGraphResult> {
    // No parent-task/workflow existence or ownership verification here: the graph's
    // parentTaskId/workflowId are free UUIDs minted per-invocation in spawn_task_graph
    // (migration 305 dropped the child_tasks FKs), never anchor rows and never
    // model-supplied — so there is nothing to look up and no cross-agent surface. See
    // C1 in the DAG review. The tenant/agent identity comes from the invocation below.

    // Gate the whole fan-out up front (Gap-15 + caps).
    const admit = await this.admissionService.checkAdmission({ tenantId: input.tenantId, agentId: input.agentId, checkType: 'task' });
    if (!admit.allowed) throw new DelegationError(`Fan-out blocked: ${admit.reason}`, 'admission_denied');
    const gate = await loadDispatchGate(input.tenantId);
    await assertNotSpawnPaused(input.tenantId);
    assertFanoutWithinCap(input.tasks.length, gate, input.tenantId);
    const childDepth = input.parentInvocationId
      ? await assertDepthWithinCap(input.parentInvocationId, gate)
      : 1;
    await assertSameTenantAgents(input.tenantId, input.agentId,
      input.tasks.map(t => t.executorAgentId).filter((x): x is string => !!x));

    const levels = buildLevels(input.tasks);  // throws on cycle / validation error
    const graphTimeoutMs = input.graphTimeoutMs ?? 30 * 60 * 1000;
    const graphStartTime = Date.now();

    logger.info({
      parentTaskId: input.parentTaskId,
      levelCount: levels.length,
      totalTasks: input.tasks.length,
      graphTimeoutMs,
    }, 'Executing task graph');

    const resultsByLocalId = new Map<string, TaskNodeResult>();
    const completedResults = new Map<string, unknown>();
    const failedOrSkipped = new Set<string>();

    for (const [levelIndex, level] of levels.entries()) {
      // Enforce graph-level timeout before kicking off each level
      if (Date.now() - graphStartTime > graphTimeoutMs) {
        // Mark all unstarted tasks as skipped with a timeout reason
        for (const task of level) {
          if (!resultsByLocalId.has(task.id)) {
            resultsByLocalId.set(task.id, {
              id: task.id,
              childTaskId: null,
              status: 'skipped',
              result: null,
              error: 'graph_timeout',
            });
          }
        }
        // Mark all tasks in subsequent levels as skipped too
        for (let i = levelIndex + 1; i < levels.length; i++) {
          for (const task of levels[i]) {
            if (!resultsByLocalId.has(task.id)) {
              resultsByLocalId.set(task.id, {
                id: task.id,
                childTaskId: null,
                status: 'skipped',
                result: null,
                error: 'graph_timeout',
              });
            }
          }
        }
        logger.warn({ parentTaskId: input.parentTaskId, elapsedMs: Date.now() - graphStartTime }, 'Task graph timeout exceeded');
        task_graph_timeout_total.inc({ tenant_id: input.tenantId });
        break;
      }
      // Determine which tasks in this level must be skipped due to upstream failure
      const toRun: TaskNode[] = [];
      for (const task of level) {
        const blockedBy = shouldSkipForDependency(task, failedOrSkipped);
        if (blockedBy) {
          resultsByLocalId.set(task.id, {
            id: task.id,
            childTaskId: null,
            status: 'skipped',
            result: null,
            error: `dependency_failed: ${blockedBy}`,
          });
          failedOrSkipped.add(task.id);
        } else {
          toRun.push(task);
        }
      }

      if (toRun.length === 0) continue;

      // Spawn the level's runnable tasks in parallel
      const spawnPromises = toRun.map(async (task) => {
        const augmentedInput = buildAugmentedInput(task, completedResults);
        const child = await this.insertChildTaskRow({
          parentTaskId: input.parentTaskId,
          workflowId: input.workflowId,
          objective: task.objective,
          inputData: augmentedInput,
          agentId: input.agentId,                  // requesting agent
          executorAgentId: task.executorAgentId,   // optional specialist for execution
          tenantId: input.tenantId,
          parentInvocationId: input.parentInvocationId,
          originTrust: input.originTrust,
        });
        await this.dispatchChild(child, task, input, childDepth, augmentedInput);
        return { task, childTaskId: child.id };
      });
      const spawned = await Promise.all(spawnPromises);

      // Persist dependency edges for inspection / audit
      for (const { task, childTaskId } of spawned) {
        for (const depLocalId of task.dependsOn ?? []) {
          const depResult = resultsByLocalId.get(depLocalId);
          if (depResult?.childTaskId) {
            await this.repository.insertTaskDependency(childTaskId, depResult.childTaskId);
          }
        }
      }

      // Wait for this level's children to terminate, then collect outcomes.
      // The polling loop in waitForChildTasksInSet handles the per-level fetch;
      // no need to pre-query here. Bound the wait by the graph deadline so a
      // single hung/lost child can't blow past the (clamped) sync budget.
      const childIds = new Set(spawned.map(s => s.childTaskId));
      const levelResults = await this.waitForChildTasksInSet(input.parentTaskId, childIds, graphStartTime + graphTimeoutMs);

      for (const r of levelResults) {
        const matchedSpawn = spawned.find(s => s.childTaskId === r.childTaskId);
        if (!matchedSpawn) continue;
        const node: TaskNodeResult = {
          id: matchedSpawn.task.id,
          childTaskId: r.childTaskId,
          status: r.success ? 'completed' : 'failed',
          result: r.result,
          error: r.error,
        };
        resultsByLocalId.set(node.id, node);
        if (node.status === 'completed') {
          completedResults.set(node.id, node.result);
        } else {
          failedOrSkipped.add(node.id);
        }
      }

      logger.info({
        parentTaskId: input.parentTaskId,
        levelIndex,
        completed: levelResults.filter(r => r.success).length,
        failed: levelResults.filter(r => !r.success).length,
      }, 'Task graph level complete');
    }

    // Preserve declaration order in the response
    const results = input.tasks.map(t => resultsByLocalId.get(t.id)!);
    const summary: ExecuteTaskGraphResult = {
      parentTaskId: input.parentTaskId,
      totalTasks: input.tasks.length,
      completed: results.filter(r => r.status === 'completed').length,
      failed: results.filter(r => r.status === 'failed').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      results,
    };
    logger.info({ ...summary, results: undefined }, 'Task graph execution complete');
    task_graph_completed_total.inc({ tenant_id: input.tenantId, outcome: summary.failed > 0 ? 'partial' : 'ok' });
    return summary;
  }

  /** Like waitForChildTasks but scoped to a specific set of child IDs, and bounded
   *  by an absolute deadline (the graph budget). On deadline, returns the terminal
   *  children and synthesizes a 'graph_timeout' failure for any straggler so the
   *  caller always gets one result per id (never hangs, never throws). */
  private async waitForChildTasksInSet(
    parentTaskId: string,
    childTaskIds: Set<string>,
    deadlineTs?: number,
  ): Promise<ChildTaskResult[]> {
    const pollInterval = 1000;
    const hardDeadline = deadlineTs ?? (Date.now() + 30 * 60 * 1000);

    const collect = (): Promise<ChildTaskResult[] | null> =>
      this.childTaskRepository.findByParentTaskId(parentTaskId).then(childTasks => {
        const byId = new Map(childTasks.filter(t => childTaskIds.has(t.id)).map(t => [t.id, t]));
        const allTerminal = byId.size === childTaskIds.size &&
          [...byId.values()].every(t => isTerminalChildStatus(t.status));
        if (!allTerminal) return null;
        return [...byId.values()].map(t => ({ childTaskId: t.id, success: t.status === 'completed', result: t.result, error: t.error }));
      });

    while (Date.now() < hardDeadline) {
      const done = await collect();
      if (done) return done;
      await new Promise(r => setTimeout(r, pollInterval));
    }

    // Deadline hit: return whatever's terminal; the rest are graph_timeout.
    const childTasks = await this.childTaskRepository.findByParentTaskId(parentTaskId);
    const byId = new Map(childTasks.filter(t => childTaskIds.has(t.id)).map(t => [t.id, t]));
    return [...childTaskIds].map(id => {
      const t = byId.get(id);
      return t && isTerminalChildStatus(t.status)
        ? { childTaskId: id, success: t.status === 'completed', result: t.result, error: t.error }
        : { childTaskId: id, success: false, result: null, error: 'graph_timeout' };
    });
  }

  // ==========================================
  // Per Section 7: Resume from checkpoint
  // ==========================================

  async resumeWorkflow(id: string): Promise<void> {
    const workflow = await this.repository.findById(id);
    if (!workflow) throw new Error('Workflow not found');

    // Per Section 7: On crash or restart:
    // - coordinator scans leased and incomplete tasks
    // - reconciles by idempotency key and persisted action state
    // - determines whether the side effect already happened
    // - resumes from the last durable checkpoint
    await this.reconcileAndResume(workflow);
  }

  // Per Section 7: Coordinator scans leased and incomplete tasks
  async reconcileWorkflow(id: string): Promise<void> {
    const workflow = await this.repository.findById(id);
    if (!workflow) throw new Error('Workflow not found');

    await this.reconcileAndResume(workflow);
  }

  // Per Section 19: Reconcile mode for startup after crash/restore
  // Per Section 19: Restore rule - restart coordinator in reconcile mode
  async runReconciliation(): Promise<void> {
    logger.info({ message: 'Starting full reconciliation of all in-flight workflows' });

    // Per Section 19: Step 2 - restart coordinator in reconcile mode
    // Per Section 19: Step 3 - replay/reconcile in-flight workflows using checkpoints,
    // idempotency keys, and action ledger

    // Find all workflows that are not in terminal state
    const activeWorkflows = await this.repository.findActiveWorkflows();

    for (const workflow of activeWorkflows) {
      logger.info({
        message: 'Reconciling workflow',
        workflow_id: workflow.id,
        tenant_id: workflow.tenantId,
      });

      try {
        await this.reconcileAndResume(workflow);
      } catch (error) {
        logger.error({
          message: 'Failed to reconcile workflow',
          workflow_id: workflow.id,
          error: (error as Error).message,
        });
      }
    }

    logger.info({ message: 'Full reconciliation complete' });
  }

  private async reconcileAndResume(workflow: Workflow): Promise<void> {
    // Per Section 7: Reconciliation logic
    // 1. Scan leased and incomplete tasks
    const incompleteTasks = await this.repository.findLeasedAndIncompleteTasks(workflow.id);

    for (const task of incompleteTasks) {
      // 2. For each task, check idempotency key and action state
      const actions = await this.actionRepository.findByTaskId(task.id);

      for (const action of actions) {
        // 3. Determine if side effect already happened
        if (action.status === 'completed') {
          // Side effect happened, mark task as complete
          logger.info({
            message: 'Action already completed, resuming from checkpoint',
            task_id: task.id,
            action_id: action.id,
            workflow_id: workflow.id,
          });
        } else if (action.status === 'pending' || action.status === 'executing') {
          // Per Section 19: Step 4 - verify external-system state before resuming
          // Check external system to determine if side effect happened
          logger.info({
            message: 'Action in unknown state, needs external verification',
            task_id: task.id,
            action_id: action.id,
            idempotency_key: action.idempotencyKey,
          });
        }
      }

      // 4. Check for incomplete child tasks
      const childTasks = await this.childTaskRepository.findByParentTaskId(task.id);
      const incompleteChildren = childTasks.filter(
        (t) => t.status !== 'completed' && t.status !== 'failed'
      );

      if (incompleteChildren.length > 0) {
        logger.info({
          message: 'Task has incomplete child tasks',
          task_id: task.id,
          incomplete_children: incompleteChildren.length,
          workflow_id: workflow.id,
        });
      }

      // 5. Resume from checkpoint or retry
      const checkpoint = await this.repository.getCheckpoint(workflow.id, task.id);
      if (checkpoint) {
        logger.info({
          message: 'Resuming from checkpoint',
          task_id: task.id,
          workflow_id: workflow.id,
          checkpoint_id: checkpoint.id,
          pending_tool_calls: checkpoint.pendingToolCalls?.length ?? 0,
        });

        // Per Section 7: Resume task execution from checkpoint state
        await this.resumeFromCheckpoint(workflow, task, checkpoint);
      }
    }

    // 6. Reconcile child workflows
    const childWorkflows = await this.repository.findChildWorkflows(workflow.id);
    for (const childWorkflow of childWorkflows) {
      if (childWorkflow.status !== 'completed' && childWorkflow.status !== 'failed') {
        logger.info({
          message: 'Reconciling child workflow',
          parent_workflow_id: workflow.id,
          child_workflow_id: childWorkflow.id,
        });
        await this.reconcileAndResume(childWorkflow);
      }
    }
  }

  // Per Section 7: Resume task execution from checkpoint
  private async resumeFromCheckpoint(
    workflow: Workflow,
    task: WorkflowTask,
    checkpoint: WorkflowCheckpoint
  ): Promise<void> {
    logger.info({
      message: 'Resuming task execution from checkpoint',
      workflow_id: workflow.id,
      task_id: task.id,
      checkpoint_id: checkpoint.id,
      idempotency_key: checkpoint.idempotencyKey,
    });

    // 1. Restore task state from checkpoint
    const _restoredState = checkpoint.state;

    // 2. Replay pending tool calls that were not completed
    const pendingToolCalls = checkpoint.pendingToolCalls || [];
    const remainingToolCalls: ToolCall[] = [];

    for (const toolCall of pendingToolCalls) {
      if (toolCall.status === 'completed') {
        // Tool call already completed, skip
        logger.info({
          message: 'Tool call already completed, skipping',
          tool_call_id: toolCall.id,
          task_id: task.id,
        });
        continue;
      }

      // Check if this tool call was already executed by checking action ledger
      const existingAction = await this.actionRepository.findByIdempotencyKey(
        `${checkpoint.idempotencyKey}-${toolCall.id}`
      );

      if (existingAction && existingAction.status === 'completed') {
        // Tool call was executed successfully, mark as complete
        toolCall.status = 'completed';
        toolCall.result = existingAction.externalResponse;
        logger.info({
          message: 'Tool call found in action ledger as completed',
          tool_call_id: toolCall.id,
          action_id: existingAction.id,
        });
      } else if (existingAction && existingAction.status === 'failed') {
        // Tool call failed previously, mark as failed
        toolCall.status = 'failed';
        toolCall.error = existingAction.error ?? 'Previous execution failed';
        remainingToolCalls.push(toolCall);
        logger.info({
          message: 'Tool call found in action ledger as failed, will retry',
          tool_call_id: toolCall.id,
          action_id: existingAction.id,
        });
      } else {
        // Tool call not executed or in unknown state, execute it
        try {
          const result = await this.adapter.executeToolCall(workflow, task, toolCall, checkpoint);
          toolCall.status = 'completed';
          toolCall.result = result;
          logger.info({
            message: 'Tool call executed successfully on resume',
            tool_call_id: toolCall.id,
            task_id: task.id,
          });
        } catch (error) {
          toolCall.status = 'failed';
          toolCall.error = (error as Error).message;
          remainingToolCalls.push(toolCall);
          logger.error({
            message: 'Tool call failed on resume',
            tool_call_id: toolCall.id,
            task_id: task.id,
            error: (error as Error).message,
          });
        }
      }
    }

    // 3. Update checkpoint with remaining tool calls
    if (remainingToolCalls.length > 0) {
      await this.repository.updateCheckpointToolCalls(checkpoint.id, remainingToolCalls);
      logger.info({
        message: 'Updated checkpoint with remaining tool calls',
        checkpoint_id: checkpoint.id,
        remaining_count: remainingToolCalls.length,
      });
    } else {
      // All tool calls completed, delete checkpoint
      await this.repository.deleteCheckpoint(checkpoint.id);
      logger.info({
        message: 'All tool calls completed, checkpoint deleted',
        checkpoint_id: checkpoint.id,
        task_id: task.id,
      });
    }

    // 4. Continue workflow execution if all pending work is done
    if (remainingToolCalls.length === 0) {
      logger.info({
        message: 'Checkpoint resume complete, continuing workflow',
        workflow_id: workflow.id,
        task_id: task.id,
      });
    }
  }

  // ==========================================
  // Per Section 7: Workflow State Transition Commit
  // ==========================================

  // Per Section 7: Commit workflow transition with checkpoint
  // This ensures durability before proceeding with side effects
  async commitTransition(input: {
    workflowId: string;
    taskId: string;
    idempotencyKey: string;
    newState: any;
    pendingToolCalls: ToolCall[];
  }): Promise<WorkflowCheckpoint> {
    const { workflowId, taskId, idempotencyKey, newState, pendingToolCalls } = input;

    logger.info({
      message: 'Committing workflow transition',
      workflow_id: workflowId,
      task_id: taskId,
      idempotency_key: idempotencyKey,
      pending_tool_calls: pendingToolCalls.length,
    });

    // Check for existing checkpoint with same idempotency key (idempotent operation)
    const existingCheckpoint = await this.repository.findCheckpointByIdempotencyKey(idempotencyKey);
    if (existingCheckpoint) {
      logger.info({
        message: 'Checkpoint already exists for idempotency key, returning existing',
        idempotency_key: idempotencyKey,
        checkpoint_id: existingCheckpoint.id,
      });
      return existingCheckpoint;
    }

    // Per Section 7: Persist checkpoint before executing side effects
    const checkpoint = await this.repository.saveCheckpoint({
      workflowId,
      taskId,
      state: newState,
      idempotencyKey,
      pendingToolCalls,
    });

    logger.info({
      message: 'Workflow transition committed',
      workflow_id: workflowId,
      task_id: taskId,
      checkpoint_id: checkpoint.id,
      idempotency_key: idempotencyKey,
    });

    return checkpoint;
  }

  // Per Section 7: Execute pending tool calls after transition commit
  async executePendingToolCalls(checkpoint: WorkflowCheckpoint): Promise<{
    completed: ToolCall[];
    failed: ToolCall[];
  }> {
    const workflow = await this.repository.findById(checkpoint.workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${checkpoint.workflowId} not found`);
    }

    const task = await this.repository.findTaskById(checkpoint.taskId);
    if (!task) {
      throw new Error(`Task ${checkpoint.taskId} not found`);
    }

    const completed: ToolCall[] = [];
    const failed: ToolCall[] = [];
    const updatedToolCalls = [...checkpoint.pendingToolCalls];

    for (let i = 0; i < updatedToolCalls.length; i++) {
      const toolCall = updatedToolCalls[i];

      if (toolCall.status === 'completed' || toolCall.status === 'failed') {
        // Already processed
        if (toolCall.status === 'completed') completed.push(toolCall);
        else failed.push(toolCall);
        continue;
      }

      try {
        // Mark as executing
        toolCall.status = 'executing';
        await this.repository.updateCheckpointToolCalls(checkpoint.id, updatedToolCalls);

        // Execute the tool call
        const result = await this.adapter.executeToolCall(workflow, task, toolCall, checkpoint);

        // Mark as completed
        toolCall.status = 'completed';
        toolCall.result = result;
        completed.push(toolCall);

        // Persist updated state
        await this.repository.updateCheckpointToolCalls(checkpoint.id, updatedToolCalls);

        logger.info({
          message: 'Tool call executed successfully',
          tool_call_id: toolCall.id,
          checkpoint_id: checkpoint.id,
        });
      } catch (error) {
        // Mark as failed
        toolCall.status = 'failed';
        toolCall.error = (error as Error).message;
        failed.push(toolCall);

        // Persist updated state
        await this.repository.updateCheckpointToolCalls(checkpoint.id, updatedToolCalls);

        logger.error({
          message: 'Tool call execution failed',
          tool_call_id: toolCall.id,
          checkpoint_id: checkpoint.id,
          error: (error as Error).message,
        });
      }
    }

    // If all tool calls completed successfully, delete the checkpoint
    if (failed.length === 0 && updatedToolCalls.every((tc) => tc.status === 'completed')) {
      await this.repository.deleteCheckpoint(checkpoint.id);
      logger.info({
        message: 'All tool calls completed, checkpoint deleted',
        checkpoint_id: checkpoint.id,
      });
    }

    return { completed, failed };
  }

  // Per Section 7: Complete a workflow transition after all tool calls succeed
  async completeTransition(checkpointId: string): Promise<void> {
    const checkpoint = await this.repository.findCheckpointByIdempotencyKey(checkpointId);
    if (!checkpoint) {
      // Checkpoint already cleaned up, transition was completed
      logger.info({
        message: 'Checkpoint not found, transition already completed',
        checkpoint_id: checkpointId,
      });
      return;
    }

    // Verify all pending tool calls are completed
    const pendingOrFailed = checkpoint.pendingToolCalls.filter(
      (tc) => tc.status !== 'completed'
    );

    if (pendingOrFailed.length > 0) {
      throw new Error(
        `Cannot complete transition: ${pendingOrFailed.length} tool calls are not completed`
      );
    }

    // Delete the checkpoint
    await this.repository.deleteCheckpoint(checkpoint.id);

    logger.info({
      message: 'Transition completed, checkpoint deleted',
      checkpoint_id: checkpoint.id,
      workflow_id: checkpoint.workflowId,
      task_id: checkpoint.taskId,
    });
  }

  // ==========================================
  // Per Section 16: Workflow Completion with Reflection Triggers
  // ==========================================

  // Complete a workflow successfully
  async completeWorkflow(workflowId: string, outcome: any): Promise<Workflow> {
    const workflow = await this.repository.findById(workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found`);
    }

    // Update workflow status and outcome
    await this.repository.updateStatus(workflowId, 'completed');
    await this.repository.setFinalOutcome(workflowId, { success: true, result: outcome });

    logger.info('Workflow completed successfully', {
      workflow_id: workflowId,
      tenant_id: workflow.tenantId,
      agent_id: workflow.agentId,
    });

    // Per Section 16: Trigger reflection after N successful runs
    // This runs asynchronously to not block the completion
    reflectionTriggerService.onWorkflowCompleted(
      workflow.agentId,
      workflow.tenantId,
      workflowId
    ).catch(err => {
      logger.error('Failed to trigger reflection on workflow completion', {
        workflow_id: workflowId,
        error: err.message,
      });
    });

    return {
      ...workflow,
      status: 'completed',
      finalOutcome: { success: true, result: outcome },
    };
  }

  // Fail a workflow
  async failWorkflow(workflowId: string, error: string): Promise<Workflow> {
    const workflow = await this.repository.findById(workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found`);
    }

    // Update workflow status and outcome
    await this.repository.updateStatus(workflowId, 'failed');
    await this.repository.setFinalOutcome(workflowId, { success: false, error });

    logger.error('Workflow failed', {
      workflow_id: workflowId,
      tenant_id: workflow.tenantId,
      agent_id: workflow.agentId,
      error,
    });

    // Count failures for this agent to determine if reflection should be triggered
    const failureCount = await this.repository.countRecentFailures(workflow.agentId);

    // Per Section 16: Trigger reflection after repeated failures
    // This runs asynchronously to not block the failure handling
    reflectionTriggerService.onWorkflowFailed(
      workflow.agentId,
      workflow.tenantId,
      workflowId,
      failureCount
    ).catch(err => {
      logger.error('Failed to trigger reflection on workflow failure', {
        workflow_id: workflowId,
        error: err.message,
      });
    });

    return {
      ...workflow,
      status: 'failed',
      finalOutcome: { success: false, result: undefined, error },
    };
  }

  // ==========================================
  // Per Section 7: Compensation/Undo Execution
  // ==========================================

  // Trigger compensation for a workflow
  async compensateWorkflow(workflowId: string, reason: string): Promise<{
    success: boolean;
    errors: string[];
  }> {
    const workflow = await this.repository.findById(workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found`);
    }

    logger.info('Starting workflow compensation', {
      workflowId,
      reason,
      currentStatus: workflow.status,
    });

    // Update workflow status to compensating
    await this.repository.updateStatus(workflowId, 'compensating');

    // Build compensation plan
    const plan = await this.compensationService.buildCompensationPlan(workflowId, reason);

    // Also compensate any child workflows
    const childWorkflows = await this.repository.findChildWorkflows(workflowId);
    for (const childWorkflow of childWorkflows) {
      if (childWorkflow.status !== 'compensated') {
        logger.info('Compensating child workflow', {
          parentWorkflowId: workflowId,
          childWorkflowId: childWorkflow.id,
        });
        await this.compensateWorkflow(childWorkflow.id, `Parent workflow compensation: ${reason}`);
      }
    }

    // Execute the compensation plan
    const result = await this.compensationService.executeCompensationPlan(workflowId);

    // Update workflow compensation state
    await this.updateCompensationState(workflowId, {
      reason,
      compensatedTasks: plan.actions.filter((a) => a.status === 'completed').map((a) => a.actionId),
      pendingCompensations: plan.actions.filter((a) => a.status !== 'completed').map((a) => a.actionId),
    });

    // Update workflow status
    if (result.success) {
      await this.repository.updateStatus(workflowId, 'failed'); // Workflow failed but was compensated
      logger.info('Workflow compensation complete', { workflowId, success: true });
    } else {
      logger.error('Workflow compensation partial', {
        workflowId,
        errors: result.errors,
      });
    }

    return {
      success: result.success,
      errors: result.errors,
    };
  }

  // Get compensation status for a workflow
  async getCompensationStatus(workflowId: string): Promise<{
    status: string;
    completedCount: number;
    pendingCount: number;
    failedCount: number;
  }> {
    const status = await this.compensationService.getCompensationStatus(workflowId);
    return {
      status: status.plan?.status ?? 'none',
      completedCount: status.completedCount,
      pendingCount: status.pendingCount,
      failedCount: status.failedCount,
    };
  }

  // Compensate a specific action
  async compensateAction(actionId: string, reason: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    logger.info('Compensating single action', { actionId, reason });

    const result = await this.compensationService.compensateAction(actionId, reason);

    return {
      success: result.success,
      error: result.error,
    };
  }

  // Update compensation state on workflow
  private async updateCompensationState(
    workflowId: string,
    state: { reason: string; compensatedTasks: string[]; pendingCompensations: string[] }
  ): Promise<void> {
    await this.repository.updateCompensationState(workflowId, state);
  }

  // ==========================================
  // Per Section 12: Kill Switch Enforcement
  // ==========================================

  // Cache for workflow kill switches
  private workflowKillSwitchCache: Map<string, { disabled: boolean; reason?: string; expiresAt: Date }> = new Map();
  private readonly KILL_SWITCH_CACHE_TTL_MS = 30 * 1000; // 30 seconds

  // Per Section 12: Check if workflows are disabled for tenant or agent
  private async checkWorkflowKillSwitch(
    tenantId: string,
    agentId?: string
  ): Promise<{ disabled: boolean; reason?: string }> {
    const cacheKey = `${tenantId}:${agentId || 'all'}`;
    const now = new Date();

    // Check cache
    const cached = this.workflowKillSwitchCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return { disabled: cached.disabled, reason: cached.reason };
    }

    const pool = getPool();

    // Check for workflow disable at tenant or agent level
    const result = await pool.query(
      `SELECT reason, scope FROM workflow_kill_switches
       WHERE tenant_id = $1
       AND enabled = true
       AND (expires_at IS NULL OR expires_at > NOW())
       AND (agent_id IS NULL OR agent_id = $2)
       ORDER BY agent_id DESC NULLS LAST
       LIMIT 1`,
      [tenantId, agentId]
    );

    if (result.rows.length > 0) {
      const row = result.rows[0];
      const response = {
        disabled: true,
        reason: row.reason || 'Workflows disabled for this tenant/agent',
      };

      // Cache the result
      this.workflowKillSwitchCache.set(cacheKey, {
        ...response,
        expiresAt: new Date(now.getTime() + this.KILL_SWITCH_CACHE_TTL_MS),
      });

      return response;
    }

    // Cache negative result
    this.workflowKillSwitchCache.set(cacheKey, {
      disabled: false,
      expiresAt: new Date(now.getTime() + this.KILL_SWITCH_CACHE_TTL_MS),
    });

    return { disabled: false };
  }

  // Clear workflow kill switch cache (called when status changes)
  clearWorkflowKillSwitchCache(tenantId?: string): void {
    if (tenantId) {
      for (const key of this.workflowKillSwitchCache.keys()) {
        if (key.startsWith(`${tenantId}:`)) {
          this.workflowKillSwitchCache.delete(key);
        }
      }
    } else {
      this.workflowKillSwitchCache.clear();
    }
  }

  // ===========================================
  // GAP-004 FIX: Handoff Operations
  // Per Section 6: Methods for createHandoff(), acceptHandoff(), rejectHandoff()
  // ===========================================

  async createHandoff(input: CreateHandoffInput): Promise<WorkflowHandoff> {
    const pool = getPool();

    // Verify workflow exists and belongs to the from agent
    const workflow = await this.repository.findById(input.workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${input.workflowId} not found`);
    }

    if (workflow.agentId !== input.fromAgentId) {
      throw new Error(`Agent ${input.fromAgentId} does not own workflow ${input.workflowId}`);
    }

    // Verify task exists
    const task = await this.repository.findTaskById(input.taskId);
    if (!task) {
      throw new Error(`Task ${input.taskId} not found`);
    }

    // Create handoff record
    const handoffId = uuidv4();
    await pool.query(
      `INSERT INTO workflow_handoffs (
        id, workflow_id, from_agent_id, to_agent_id, task_id, status,
        context, reason, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, NOW(), NOW())`,
      [
        handoffId,
        input.workflowId,
        input.fromAgentId,
        input.toAgentId,
        input.taskId,
        JSON.stringify(input.context || {}),
        input.reason || null,
      ]
    );

    logger.info('Handoff created', {
      handoff_id: handoffId,
      workflow_id: input.workflowId,
      from_agent: input.fromAgentId,
      to_agent: input.toAgentId,
      task_id: input.taskId,
    });

    return {
      id: handoffId,
      workflowId: input.workflowId,
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      taskId: input.taskId,
      status: 'pending',
      createdAt: new Date(),
    };
  }

  async acceptHandoff(handoffId: string, acceptingAgentId: string): Promise<WorkflowHandoff> {
    const pool = getPool();

    // Get handoff
    const result = await pool.query(
      `SELECT * FROM workflow_handoffs WHERE id = $1`,
      [handoffId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Handoff ${handoffId} not found`);
    }

    const handoff = result.rows[0];

    // Verify the accepting agent is the intended recipient
    if (handoff.to_agent_id !== acceptingAgentId) {
      throw new Error(`Agent ${acceptingAgentId} is not the intended recipient of handoff ${handoffId}`);
    }

    // Verify handoff is pending
    if (handoff.status !== 'pending') {
      throw new Error(`Handoff ${handoffId} is not pending (status: ${handoff.status})`);
    }

    // Update handoff status
    await pool.query(
      `UPDATE workflow_handoffs
       SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [handoffId]
    );

    // Transfer workflow ownership to the accepting agent
    await pool.query(
      `UPDATE workflows SET agent_id = $1, updated_at = NOW() WHERE id = $2`,
      [acceptingAgentId, handoff.workflow_id]
    );

    // Transfer task lease to the accepting agent
    await pool.query(
      `UPDATE workflow_tasks SET agent_id = $1, updated_at = NOW() WHERE id = $2`,
      [acceptingAgentId, handoff.task_id]
    );

    logger.info('Handoff accepted', {
      handoff_id: handoffId,
      workflow_id: handoff.workflow_id,
      from_agent: handoff.from_agent_id,
      to_agent: acceptingAgentId,
    });

    return {
      id: handoffId,
      workflowId: handoff.workflow_id,
      fromAgentId: handoff.from_agent_id,
      toAgentId: acceptingAgentId,
      taskId: handoff.task_id,
      status: 'accepted',
      createdAt: handoff.created_at,
    };
  }

  async rejectHandoff(handoffId: string, rejectingAgentId: string, reason?: string): Promise<WorkflowHandoff> {
    const pool = getPool();

    // Get handoff
    const result = await pool.query(
      `SELECT * FROM workflow_handoffs WHERE id = $1`,
      [handoffId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Handoff ${handoffId} not found`);
    }

    const handoff = result.rows[0];

    // Verify the rejecting agent is the intended recipient
    if (handoff.to_agent_id !== rejectingAgentId) {
      throw new Error(`Agent ${rejectingAgentId} is not the intended recipient of handoff ${handoffId}`);
    }

    // Verify handoff is pending
    if (handoff.status !== 'pending') {
      throw new Error(`Handoff ${handoffId} is not pending (status: ${handoff.status})`);
    }

    // Update handoff status
    await pool.query(
      `UPDATE workflow_handoffs
       SET status = 'rejected', rejection_reason = $2, rejected_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [handoffId, reason || null]
    );

    logger.info('Handoff rejected', {
      handoff_id: handoffId,
      workflow_id: handoff.workflow_id,
      from_agent: handoff.from_agent_id,
      to_agent: rejectingAgentId,
      reason,
    });

    return {
      id: handoffId,
      workflowId: handoff.workflow_id,
      fromAgentId: handoff.from_agent_id,
      toAgentId: rejectingAgentId,
      taskId: handoff.task_id,
      status: 'rejected',
      createdAt: handoff.created_at,
    };
  }

  async getPendingHandoffs(agentId: string): Promise<WorkflowHandoff[]> {
    const pool = getPool();

    const result = await pool.query(
      `SELECT * FROM workflow_handoffs
       WHERE to_agent_id = $1 AND status = 'pending'
       ORDER BY created_at ASC`,
      [agentId]
    );

    return result.rows.map((row: any) => ({
      id: row.id,
      workflowId: row.workflow_id,
      fromAgentId: row.from_agent_id,
      toAgentId: row.to_agent_id,
      taskId: row.task_id,
      status: row.status,
      createdAt: row.created_at,
    }));
  }

  // ===========================================
  // GAP-005 FIX: Lease Acquisition Methods
  // Per Section 6: acquireLease(), renewLease(), releaseLease()
  // ===========================================

  private static readonly LEASE_DURATION_MS = 5 * 60 * 1000; // 5 minutes default

  async acquireLease(taskId: string, workerId: string): Promise<WorkflowLease | null> {
    const pool = getPool();

    // Try to acquire lease using optimistic locking
    // Only succeed if no active lease exists
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CoordinatorService.LEASE_DURATION_MS);
    const leaseId = uuidv4();

    try {
      // Atomic check-and-acquire using a transaction
      await pool.query('BEGIN');

      // Check for existing active lease
      const existingLease = await pool.query(
        `SELECT * FROM workflow_leases
         WHERE task_id = $1 AND expires_at > NOW()
         FOR UPDATE`,
        [taskId]
      );

      if (existingLease.rows.length > 0) {
        await pool.query('ROLLBACK');
        logger.info('Lease already held by another worker', {
          task_id: taskId,
          existing_worker: existingLease.rows[0].worker_id,
          requesting_worker: workerId,
        });
        return null; // Lease already held
      }

      // Delete any expired leases
      await pool.query(
        `DELETE FROM workflow_leases WHERE task_id = $1 AND expires_at <= NOW()`,
        [taskId]
      );

      // Create new lease
      await pool.query(
        `INSERT INTO workflow_leases (id, task_id, worker_id, expires_at, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [leaseId, taskId, workerId, expiresAt]
      );

      // Update task with lease info
      await pool.query(
        `UPDATE workflow_tasks
         SET lease_id = $1, lease_expires_at = $2, status = 'leased', updated_at = NOW()
         WHERE id = $3`,
        [leaseId, expiresAt, taskId]
      );

      await pool.query('COMMIT');

      logger.info('Lease acquired', {
        lease_id: leaseId,
        task_id: taskId,
        worker_id: workerId,
        expires_at: expiresAt.toISOString(),
      });

      return {
        id: leaseId,
        taskId,
        workerId,
        expiresAt,
        createdAt: now,
      };
    } catch (error) {
      await pool.query('ROLLBACK');
      logger.error('Failed to acquire lease', {
        task_id: taskId,
        worker_id: workerId,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  async renewLease(leaseId: string, workerId: string): Promise<WorkflowLease | null> {
    const pool = getPool();

    const now = new Date();
    const newExpiresAt = new Date(now.getTime() + CoordinatorService.LEASE_DURATION_MS);

    // Only renew if the worker still holds the lease
    const result = await pool.query(
      `UPDATE workflow_leases
       SET expires_at = $1
       WHERE id = $2 AND worker_id = $3 AND expires_at > NOW()
       RETURNING *`,
      [newExpiresAt, leaseId, workerId]
    );

    if (result.rows.length === 0) {
      logger.warn('Lease renewal failed - lease not found or expired', {
        lease_id: leaseId,
        worker_id: workerId,
      });
      return null;
    }

    const lease = result.rows[0];

    // Update task lease expiry
    await pool.query(
      `UPDATE workflow_tasks SET lease_expires_at = $1, updated_at = NOW() WHERE lease_id = $2`,
      [newExpiresAt, leaseId]
    );

    logger.info('Lease renewed', {
      lease_id: leaseId,
      task_id: lease.task_id,
      worker_id: workerId,
      new_expires_at: newExpiresAt.toISOString(),
    });

    return {
      id: leaseId,
      taskId: lease.task_id,
      workerId,
      expiresAt: newExpiresAt,
      createdAt: lease.created_at,
    };
  }

  async releaseLease(leaseId: string, workerId: string): Promise<boolean> {
    const pool = getPool();

    try {
      await pool.query('BEGIN');

      // Get lease and verify ownership
      const leaseResult = await pool.query(
        `SELECT * FROM workflow_leases WHERE id = $1 FOR UPDATE`,
        [leaseId]
      );

      if (leaseResult.rows.length === 0) {
        await pool.query('ROLLBACK');
        return false;
      }

      const lease = leaseResult.rows[0];

      // Verify worker owns the lease
      if (lease.worker_id !== workerId) {
        await pool.query('ROLLBACK');
        logger.warn('Lease release denied - worker mismatch', {
          lease_id: leaseId,
          lease_worker: lease.worker_id,
          requesting_worker: workerId,
        });
        return false;
      }

      // Delete lease
      await pool.query(`DELETE FROM workflow_leases WHERE id = $1`, [leaseId]);

      // Clear lease from task
      await pool.query(
        `UPDATE workflow_tasks
         SET lease_id = NULL, lease_expires_at = NULL, status = 'pending', updated_at = NOW()
         WHERE lease_id = $1`,
        [leaseId]
      );

      await pool.query('COMMIT');

      logger.info('Lease released', {
        lease_id: leaseId,
        task_id: lease.task_id,
        worker_id: workerId,
      });

      return true;
    } catch (error) {
      await pool.query('ROLLBACK');
      logger.error('Failed to release lease', {
        lease_id: leaseId,
        worker_id: workerId,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  // Clean up expired leases (run periodically)
  async cleanupExpiredLeases(): Promise<number> {
    const pool = getPool();

    // Find and release expired leases
    const result = await pool.query(
      `DELETE FROM workflow_leases WHERE expires_at <= NOW() RETURNING task_id`
    );

    if (result.rows.length > 0) {
      // Reset tasks that had expired leases
      const taskIds = result.rows.map((r: any) => r.task_id);
      await pool.query(
        `UPDATE workflow_tasks
         SET lease_id = NULL, lease_expires_at = NULL, status = 'pending', updated_at = NOW()
         WHERE id = ANY($1)`,
        [taskIds]
      );

      logger.info('Cleaned up expired leases', {
        count: result.rows.length,
        task_ids: taskIds,
      });
    }

    return result.rows.length;
  }
}

// Handoff input type
interface CreateHandoffInput {
  workflowId: string;
  fromAgentId: string;
  toAgentId: string;
  taskId: string;
  context?: Record<string, unknown>;
  reason?: string;
}
