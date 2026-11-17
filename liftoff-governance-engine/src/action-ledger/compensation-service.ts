// Compensation Service
// Per Section 7: Undo/compensation execution logic

import { ActionRepository, CompensationRepository } from './repository';
import {
  Action,
  CompensationPlan,
  CompensationType,
  CompensationResult,
  CompensationStep,
} from './types';
import { logger } from '../infrastructure/logging';
import { reflectionTriggerService } from '../reflection-engine/trigger-service';
import { getConnectorServiceClient } from '../connectors/connector-service-client';

// Connector-specific compensation handlers
type CompensationHandler = (action: Action, compensationData: any) => Promise<CompensationResult>;

// Credential service interface — kept for backwards compatibility with
// callers that still inject one. No longer used for compensation dispatch
// (Phase 2b cutover moved dispatch onto the connector-service Execute RPC),
// but removing the setter would break existing construction sites.
interface ConnectorCredentialsShape {
  accessToken: string;
  refreshToken?: string;
  instanceUrl?: string;
  expiresAt?: Date;
}
interface CredentialService {
  getCredentials(tenantId: string, connector: string): Promise<ConnectorCredentialsShape>;
}

/**
 * Phase 2b replacement for the old in-process CompensationClient. Each
 * method translates into a proto ExecuteRequest against the connector-
 * service, using conventional function names (`delete`, `update`,
 * `restore`, `semantic_inverse`). The connector-service owns the vendor
 * SDK / HTTP dispatch now; tenant-runtime only forwards the intent.
 */
interface CompensationRpcResult {
  success: boolean;
  error?: string;
  data?: unknown;
}

async function executeCompensationRpc(
  action: Action,
  functionName: string,
  payload: Record<string, unknown>,
): Promise<CompensationRpcResult> {
  try {
    const client = getConnectorServiceClient();
    const resp = await client.execute({
      tenantContext: { tenantId: action.tenantId },
      connectorId: action.connector,
      functionName,
      input: payload as never,
      idempotencyKey: `compensate-${action.id}-${functionName}`,
      traceId: `compensate-${action.id}`,
    });
    return {
      success: resp.success,
      error: resp.error || undefined,
      data: resp.result ?? undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export class CompensationService {
  private actionRepository = new ActionRepository();
  private compensationRepository = new CompensationRepository();
  private handlers: Map<string, CompensationHandler> = new Map();
  private credentialService?: CredentialService;

  constructor() {
    this.registerDefaultHandlers();
  }

  // Inject credential service for fetching connector credentials
  setCredentialService(service: CredentialService): void {
    this.credentialService = service;
  }

  // Phase 2b: getConnectorClient() was removed along with the in-process
  // connector clients. Compensation handlers now call executeCompensationRpc()
  // directly to forward operations to the connector-service.

  // Register a compensation handler for a connector/action type
  registerHandler(connector: string, actionType: string, handler: CompensationHandler): void {
    const key = `${connector}:${actionType}`;
    this.handlers.set(key, handler);
  }

  // Per Section 7: Build compensation plan for a workflow
  async buildCompensationPlan(workflowId: string, reason: string): Promise<CompensationPlan> {
    logger.info('Building compensation plan', { workflowId, reason });

    // Find all completed actions in reverse order
    const completedActions = await this.actionRepository.findCompletedActionsForWorkflow(workflowId);

    // Build compensation steps in reverse order of execution
    const steps: CompensationStep[] = completedActions.map((action, index) => ({
      actionId: action.id,
      compensationType: this.determineCompensationType(action),
      order: index,
      status: 'pending' as const,
    }));

    // Create the plan
    const plan = await this.compensationRepository.createPlan({
      workflowId,
      reason,
      steps,
    });

    logger.info('Compensation plan created', {
      workflowId,
      totalSteps: steps.length,
      reason,
    });

    return plan;
  }

  // Determine the appropriate compensation type based on action
  private determineCompensationType(action: Action): CompensationType {
    // If we have a pre-action snapshot, we can restore
    if (action.preActionSnapshot) {
      return 'restore';
    }

    // Determine based on action type
    switch (action.actionType) {
      case 'create':
        return 'semantic'; // Delete the created entity
      case 'update':
        return 'restore'; // Restore previous state
      case 'delete':
        return 'restore'; // Recreate from snapshot
      case 'send':
      case 'publish':
        return 'manual'; // Cannot unsend messages
      default:
        return 'reverse';
    }
  }

  // Per Section 7: Execute compensation plan
  async executeCompensationPlan(workflowId: string): Promise<{
    success: boolean;
    results: CompensationResult[];
    errors: string[];
  }> {
    const plan = await this.compensationRepository.findPlanByWorkflowId(workflowId);
    if (!plan) {
      throw new Error(`No compensation plan found for workflow ${workflowId}`);
    }

    logger.info('Executing compensation plan', {
      workflowId,
      totalSteps: plan.actions.length,
    });

    await this.compensationRepository.updatePlanStatus(workflowId, 'executing');

    const results: CompensationResult[] = [];
    const errors: string[] = [];
    let hasFailures = false;

    // Execute steps in order (already reverse-ordered)
    for (const step of plan.actions) {
      if (step.compensationType === 'manual') {
        logger.warn('Manual compensation required', {
          workflowId,
          actionId: step.actionId,
        });
        await this.compensationRepository.updatePlanStep(workflowId, step.actionId, 'skipped');
        results.push({
          actionId: step.actionId,
          success: false,
          compensationType: step.compensationType,
          error: 'Manual compensation required',
        });
        continue;
      }

      try {
        const result = await this.executeCompensationStep(workflowId, step);
        results.push(result);

        if (!result.success) {
          hasFailures = true;
          errors.push(`Action ${step.actionId}: ${result.error}`);
        }
      } catch (error) {
        hasFailures = true;
        const errorMsg = (error as Error).message;
        errors.push(`Action ${step.actionId}: ${errorMsg}`);
        results.push({
          actionId: step.actionId,
          success: false,
          compensationType: step.compensationType,
          error: errorMsg,
        });

        await this.compensationRepository.updatePlanStep(workflowId, step.actionId, 'failed');
      }
    }

    // Update plan status
    const finalStatus = hasFailures ? 'partial' : 'completed';
    await this.compensationRepository.updatePlanStatus(workflowId, finalStatus);

    logger.info('Compensation plan execution complete', {
      workflowId,
      status: finalStatus,
      successCount: results.filter((r) => r.success).length,
      failureCount: results.filter((r) => !r.success).length,
    });

    return {
      success: !hasFailures,
      results,
      errors,
    };
  }

  // Execute a single compensation step
  private async executeCompensationStep(
    workflowId: string,
    step: CompensationStep
  ): Promise<CompensationResult> {
    const action = await this.actionRepository.findById(step.actionId);
    if (!action) {
      throw new Error(`Action ${step.actionId} not found`);
    }

    logger.info('Executing compensation step', {
      workflowId,
      actionId: step.actionId,
      compensationType: step.compensationType,
      connector: action.connector,
      actionType: action.actionType,
    });

    // Create compensation action record
    const compensationAction = await this.compensationRepository.createCompensationAction({
      originalActionId: action.id,
      workflowId,
      taskId: action.taskId,
      compensationType: step.compensationType,
      compensationData: this.buildCompensationData(action, step.compensationType),
    });

    await this.compensationRepository.updateCompensationStatus(compensationAction.id, 'executing');
    await this.compensationRepository.updatePlanStep(workflowId, step.actionId, 'executing');

    try {
      // Find handler for this action type
      const handlerKey = `${action.connector}:${action.actionType}`;
      const handler = this.handlers.get(handlerKey);

      let result: CompensationResult;

      if (handler) {
        // Use registered handler
        result = await handler(action, compensationAction.compensationData);
      } else {
        // Use default compensation based on type
        result = await this.executeDefaultCompensation(action, step.compensationType);
      }

      // Update statuses
      if (result.success) {
        await this.compensationRepository.updateCompensationStatus(compensationAction.id, 'completed');
        await this.compensationRepository.updatePlanStep(workflowId, step.actionId, 'completed');
        await this.actionRepository.markAsCompensated(action.id);

        // Per Section 16: Trigger reflection after repeated undos
        // This runs asynchronously to not block the compensation
        reflectionTriggerService.onActionCompensated(
          action.agentId,
          action.tenantId,
          action.id
        ).catch(err => {
          logger.error('Failed to trigger reflection on action compensation', {
            action_id: action.id,
            error: err.message,
          });
        });
      } else {
        await this.compensationRepository.updateCompensationStatus(
          compensationAction.id,
          'failed',
          result.error
        );
        await this.compensationRepository.updatePlanStep(workflowId, step.actionId, 'failed');
      }

      return result;
    } catch (error) {
      const errorMsg = (error as Error).message;
      await this.compensationRepository.updateCompensationStatus(
        compensationAction.id,
        'failed',
        errorMsg
      );
      throw error;
    }
  }

  // Build compensation data based on action and compensation type
  private buildCompensationData(action: Action, compensationType: CompensationType): any {
    switch (compensationType) {
      case 'restore':
        return {
          snapshot: action.preActionSnapshot,
          targetRef: action.targetRef,
        };
      case 'semantic':
        return {
          inverseAction: this.getSemanticInverse(action.actionType),
          targetRef: action.targetRef,
          externalResponse: action.externalResponse,
        };
      case 'reverse':
        return {
          originalAction: {
            connector: action.connector,
            entityType: action.entityType,
            actionType: action.actionType,
            targetRef: action.targetRef,
          },
        };
      default:
        return {};
    }
  }

  // Get semantic inverse of an action type
  private getSemanticInverse(actionType: string): string {
    const inverses: Record<string, string> = {
      create: 'delete',
      delete: 'create',
      add: 'remove',
      remove: 'add',
      enable: 'disable',
      disable: 'enable',
      start: 'stop',
      stop: 'start',
      open: 'close',
      close: 'open',
    };
    return inverses[actionType] || `undo_${actionType}`;
  }

  // Default compensation execution — routes to connector-service Execute RPC
  // using reserved function names `restore` / `semantic_inverse`. The
  // connector-service owns the actual vendor-specific dispatch.
  private async executeDefaultCompensation(
    action: Action,
    compensationType: CompensationType
  ): Promise<CompensationResult> {
    try {
      switch (compensationType) {
        case 'restore': {
          // Restore from pre-action snapshot via connector-service
          logger.info('Executing restore compensation', {
            actionId: action.id,
            targetRef: action.targetRef,
            hasSnapshot: !!action.preActionSnapshot,
            connector: action.connector,
          });

          if (!action.preActionSnapshot) {
            return {
              actionId: action.id,
              success: false,
              compensationType,
              error: 'No pre-action snapshot available for restore',
            };
          }

          const result = await executeCompensationRpc(action, 'restore', {
            entityType: action.entityType,
            targetRef: action.targetRef,
            snapshot: action.preActionSnapshot,
          });

          return {
            actionId: action.id,
            success: result.success,
            compensationType,
            error: result.error,
          };
        }

        case 'semantic': {
          const inverseAction = this.getSemanticInverse(action.actionType);
          logger.info('Executing semantic compensation', {
            actionId: action.id,
            originalAction: action.actionType,
            inverseAction,
            connector: action.connector,
          });

          const result = await executeCompensationRpc(action, 'semantic_inverse', {
            entityType: action.entityType,
            originalAction: action.actionType,
            targetRef: action.targetRef,
            externalResponse: action.externalResponse || {},
          });

          return {
            actionId: action.id,
            success: result.success,
            compensationType,
            error: result.error,
          };
        }

        case 'reverse': {
          // Try semantic inverse first for generic reverse
          logger.info('Attempting reverse compensation via semantic inverse', {
            actionId: action.id,
            connector: action.connector,
            actionType: action.actionType,
          });

          const result = await executeCompensationRpc(action, 'semantic_inverse', {
            entityType: action.entityType,
            originalAction: action.actionType,
            targetRef: action.targetRef,
            externalResponse: action.externalResponse || {},
          });

          if (result.success) {
            return {
              actionId: action.id,
              success: true,
              compensationType,
            };
          }

          // Fall back to requiring manual review
          logger.warn('Reverse compensation requires manual intervention', {
            actionId: action.id,
            connector: action.connector,
            actionType: action.actionType,
            error: result.error,
          });

          return {
            actionId: action.id,
            success: false,
            compensationType,
            error: result.error || 'Reverse compensation requires manual intervention',
          };
        }

        default:
          return {
            actionId: action.id,
            success: false,
            compensationType,
            error: `Unknown compensation type: ${compensationType}`,
          };
      }
    } catch (error) {
      logger.error('Compensation execution failed', {
        actionId: action.id,
        compensationType,
        error: (error as Error).message,
      });

      return {
        actionId: action.id,
        success: false,
        compensationType,
        error: (error as Error).message,
      };
    }
  }

  // Register default handlers for common connectors with real API calls
  private registerDefaultHandlers(): void {
    // Google Calendar - delete created event
    this.registerHandler('google_calendar', 'create', async (action) => {
      const eventId = action.externalResponse?.id;
      const calendarId = action.externalResponse?.organizer?.email || 'primary';
      if (!eventId) {
        return {
          actionId: action.id,
          success: false,
          compensationType: 'semantic' as const,
          error: 'No event ID found in external response',
        };
      }

      try {
        const result = await executeCompensationRpc(action, 'delete', {
          entityType: 'event',
          targetRef: `${calendarId}/${eventId}`,
        });

        logger.info('Deleted Google Calendar event', { eventId, success: result.success });
        return {
          actionId: action.id,
          success: result.success,
          compensationType: 'semantic' as const,
          error: result.error,
        };
      } catch (error) {
        return {
          actionId: action.id,
          success: false,
          compensationType: 'semantic' as const,
          error: (error as Error).message,
        };
      }
    });

    // Slack - delete sent message
    this.registerHandler('slack', 'send', async (action) => {
      const ts = action.externalResponse?.ts;
      const channel = action.externalResponse?.channel;
      if (!ts || !channel) {
        return {
          actionId: action.id,
          success: false,
          compensationType: 'semantic' as const,
          error: 'No message timestamp or channel found',
        };
      }

      try {
        const result = await executeCompensationRpc(action, 'delete', {
          entityType: 'message',
          targetRef: `${channel}:${ts}`,
        });

        logger.info('Deleted Slack message', { channel, ts, success: result.success });
        return {
          actionId: action.id,
          success: result.success,
          compensationType: 'semantic' as const,
          error: result.error,
        };
      } catch (error) {
        return {
          actionId: action.id,
          success: false,
          compensationType: 'semantic' as const,
          error: (error as Error).message,
        };
      }
    });

    // GitHub - close opened PR/issue
    this.registerHandler('github', 'create', async (action) => {
      if (action.entityType === 'pull_request' || action.entityType === 'issue') {
        const number = action.externalResponse?.number;
        const owner = action.externalResponse?.owner || action.externalResponse?.repository?.owner?.login;
        const repo = action.externalResponse?.repo || action.externalResponse?.repository?.name;

        if (!number || !owner || !repo) {
          return {
            actionId: action.id,
            success: false,
            compensationType: 'semantic' as const,
            error: 'Missing owner, repo, or number in external response',
          };
        }

        try {
          const entityId = `${owner}/${repo}/${number}`;
          const result = await executeCompensationRpc(action, 'update', {
            entityType: action.entityType,
            targetRef: entityId,
            payload: { state: 'closed' },
          });

          logger.info('Closed GitHub PR/issue', {
            entityType: action.entityType,
            entityId,
            success: result.success,
          });

          return {
            actionId: action.id,
            success: result.success,
            compensationType: 'semantic' as const,
            error: result.error,
          };
        } catch (error) {
          return {
            actionId: action.id,
            success: false,
            compensationType: 'semantic' as const,
            error: (error as Error).message,
          };
        }
      }

      // For comments, delete them
      if (action.entityType === 'comment') {
        const commentId = action.externalResponse?.id;
        const owner = action.externalResponse?.owner;
        const repo = action.externalResponse?.repo;

        if (!commentId || !owner || !repo) {
          return {
            actionId: action.id,
            success: false,
            compensationType: 'semantic' as const,
            error: 'Missing comment details in external response',
          };
        }

        try {
          const result = await executeCompensationRpc(action, 'delete', {
            entityType: 'comment',
            targetRef: `${owner}/${repo}/${commentId}`,
          });

          logger.info('Deleted GitHub comment', { commentId, success: result.success });
          return {
            actionId: action.id,
            success: result.success,
            compensationType: 'semantic' as const,
            error: result.error,
          };
        } catch (error) {
          return {
            actionId: action.id,
            success: false,
            compensationType: 'semantic' as const,
            error: (error as Error).message,
          };
        }
      }

      return {
        actionId: action.id,
        success: false,
        compensationType: 'semantic' as const,
        error: `Cannot compensate GitHub create for entity type: ${action.entityType}`,
      };
    });

    // Salesforce - delete created record
    this.registerHandler('salesforce', 'create', async (action) => {
      const recordId = action.externalResponse?.id;
      if (!recordId) {
        return {
          actionId: action.id,
          success: false,
          compensationType: 'semantic' as const,
          error: 'No record ID found in external response',
        };
      }

      try {
        const result = await executeCompensationRpc(action, 'delete', {
          entityType: action.entityType,
          targetRef: recordId,
        });

        logger.info('Deleted Salesforce record', {
          entityType: action.entityType,
          recordId,
          success: result.success,
        });

        return {
          actionId: action.id,
          success: result.success,
          compensationType: 'semantic' as const,
          error: result.error,
        };
      } catch (error) {
        return {
          actionId: action.id,
          success: false,
          compensationType: 'semantic' as const,
          error: (error as Error).message,
        };
      }
    });

    // Salesforce - restore updated record
    this.registerHandler('salesforce', 'update', async (action) => {
      if (!action.preActionSnapshot) {
        return {
          actionId: action.id,
          success: false,
          compensationType: 'restore' as const,
          error: 'No pre-action snapshot available',
        };
      }

      try {
        const result = await executeCompensationRpc(action, 'restore', {
          entityType: action.entityType,
          targetRef: action.targetRef,
          snapshot: action.preActionSnapshot,
        });

        logger.info('Restored Salesforce record', {
          entityType: action.entityType,
          targetRef: action.targetRef,
          success: result.success,
        });

        return {
          actionId: action.id,
          success: result.success,
          compensationType: 'restore' as const,
          error: result.error,
        };
      } catch (error) {
        return {
          actionId: action.id,
          success: false,
          compensationType: 'restore' as const,
          error: (error as Error).message,
        };
      }
    });
  }

  // Compensate a single action immediately
  async compensateAction(actionId: string, reason: string): Promise<CompensationResult> {
    const action = await this.actionRepository.findById(actionId);
    if (!action) {
      throw new Error(`Action ${actionId} not found`);
    }

    const compensationType = this.determineCompensationType(action);
    const step: CompensationStep = {
      actionId,
      compensationType,
      order: 0,
      status: 'pending',
    };

    logger.info('Compensating single action', {
      actionId,
      reason,
      compensationType,
    });

    return this.executeCompensationStep(action.workflowId, step);
  }

  // Get compensation status for a workflow
  async getCompensationStatus(workflowId: string): Promise<{
    plan: CompensationPlan | null;
    completedCount: number;
    pendingCount: number;
    failedCount: number;
  }> {
    const plan = await this.compensationRepository.findPlanByWorkflowId(workflowId);
    if (!plan) {
      return {
        plan: null,
        completedCount: 0,
        pendingCount: 0,
        failedCount: 0,
      };
    }

    const completedCount = plan.actions.filter((a) => a.status === 'completed').length;
    const pendingCount = plan.actions.filter((a) => a.status === 'pending').length;
    const failedCount = plan.actions.filter((a) => a.status === 'failed').length;

    return {
      plan,
      completedCount,
      pendingCount,
      failedCount,
    };
  }
}
