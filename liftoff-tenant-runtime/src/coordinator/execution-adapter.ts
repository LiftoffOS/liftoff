// ExecutionAdapter — thin seam between CoordinatorService and the tool execution backend.
// Enables future strategy swap (e.g. direct sandbox vs. Cloud Tasks writeback).

import type { Workflow, WorkflowTask, WorkflowCheckpoint, ToolCall } from './types';
import type { ToolCallResult } from '../agent-execution/types';
import type { ToolGatewayDispatcher } from '../tool-gateway/dispatcher';
import { enqueueConnectorWriteback } from '../infrastructure/cloud-tasks';
import { logger } from '../infrastructure/logging';

const WRITE_ACTION_TYPES = ['create', 'update', 'write', 'patch', 'delete'];

export interface ExecutionAdapter {
  executeToolCall(
    workflow: Workflow,
    task: WorkflowTask,
    toolCall: ToolCall,
    checkpoint: WorkflowCheckpoint,
  ): Promise<ToolCallResult>;
  supportsResume(): boolean;
  needsSandbox(): boolean;
  destroy(): Promise<void>;
}

export class SandboxedAdapter implements ExecutionAdapter {
  constructor(private readonly toolGateway: ToolGatewayDispatcher) {}

  async executeToolCall(
    workflow: Workflow,
    task: WorkflowTask,
    toolCall: ToolCall,
    checkpoint: WorkflowCheckpoint,
  ): Promise<ToolCallResult> {
    const idempotencyKey = `${checkpoint.idempotencyKey}-${toolCall.id}`;

    logger.info({
      message: 'Executing tool call',
      tool_call_id: toolCall.id,
      connector: toolCall.connector,
      entity_type: toolCall.entityType,
      action_type: toolCall.actionType,
      idempotency_key: idempotencyKey,
    });

    const isWriteAction = WRITE_ACTION_TYPES.includes(toolCall.actionType);

    if (isWriteAction && toolCall.connector) {
      const taskName = await enqueueConnectorWriteback(toolCall.connector, {
        tenantId: workflow.tenantId,
        agentId: workflow.agentId,
        workflowId: workflow.id,
        taskId: task.id,
        actionType: toolCall.actionType,
        payload: {
          connector: toolCall.connector,
          entityType: toolCall.entityType,
          payload: toolCall.payload,
          instructionVersion: 1,
          traceId: `writeback-${workflow.id}-${task.id}-${toolCall.id}`,
        },
        idempotencyKey,
      });

      logger.info({
        message: 'Write operation enqueued via Cloud Tasks',
        tool_call_id: toolCall.id,
        connector: toolCall.connector,
        cloud_task_name: taskName,
      });

      return { enqueued: true, taskName, idempotencyKey } as unknown as ToolCallResult;
    }

    const result = await this.toolGateway.execute({
      tenantId: workflow.tenantId,
      agentId: workflow.agentId,
      instructionVersion: 1,
      traceId: `resume-${workflow.id}-${task.id}-${toolCall.id}`,
      idempotencyKey,
      connector: toolCall.connector,
      entityType: toolCall.entityType,
      actionType: toolCall.actionType,
      payload: toolCall.payload,
    });

    return result as unknown as ToolCallResult;
  }

  supportsResume(): boolean { return true; }
  needsSandbox(): boolean { return true; }
  async destroy(): Promise<void> {}
}
