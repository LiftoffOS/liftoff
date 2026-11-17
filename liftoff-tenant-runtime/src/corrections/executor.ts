// Correction Executor
// Per implementation plan: Correction action execution via Tool Gateway

import { logger } from '../infrastructure/logging';
import { getToolGatewayDispatcher } from '../tool-gateway/dispatcher';
import { getPreActionSnapshot } from './state-resolver';
import { validateResourceExists } from './resource-validator';
import { createCorrectionAuditLog, getAuditLog } from './control-plane-client';
import {
  CorrectionExecutionInput,
  CorrectionExecutionResult,
  PreActionSnapshot,
} from './types';

// Phase 4: dispatcher resolves to HTTP client under split SERVICE_TYPE.
const toolGateway = getToolGatewayDispatcher();

/**
 * Execute a correction action via Tool Gateway
 */
export async function executeCorrection(
  input: CorrectionExecutionInput
): Promise<CorrectionExecutionResult> {
  const {
    tenantId,
    correctionRequestId,
    originalAuditLogId,
    correctionToolName,
    correctionType,
    requiresPreviousState,
    reason,
    requestedBy: _requestedBy,
    traceId,
    agentId = 'system:correction',
    instructionVersion = 0,
  } = input;

  logger.info('Executing correction', {
    correctionRequestId,
    tenantId,
    correctionToolName,
    correctionType,
    traceId,
  });

  try {
    // Step 1: Get original action state from Action Ledger (if required)
    let previousState: PreActionSnapshot | null = null;
    if (requiresPreviousState) {
      previousState = await getPreActionSnapshot(tenantId, originalAuditLogId);

      if (!previousState) {
        const error = 'Pre-action state not available for AMEND correction';
        logger.warn(error, { correctionRequestId, originalAuditLogId, traceId });

        await createCorrectionAuditLog({
          tenantId,
          action: correctionToolName,
          inputArgs: { error },
          outputSummary: error,
          outcome: 'error',
          errorCode: 'SNAPSHOT_NOT_AVAILABLE',
          triggeredBy: 'event:correction',
          correctionOf: originalAuditLogId,
        });

        return {
          success: false,
          error,
          errorCode: 'SNAPSHOT_NOT_AVAILABLE',
          retryable: false,
        };
      }
    }

    // Step 2: Validate resource still exists
    const resourceId = await extractResourceId(tenantId, originalAuditLogId);
    if (resourceId) {
      const validation = await validateResourceExists(
        tenantId,
        correctionToolName,
        resourceId,
        traceId
      );

      if (!validation.exists) {
        const error = validation.error || 'Resource no longer exists';
        logger.warn('Resource validation failed', {
          correctionRequestId,
          resourceId,
          error,
          traceId,
        });

        await createCorrectionAuditLog({
          tenantId,
          action: correctionToolName,
          inputArgs: { resourceId, error },
          outputSummary: error,
          outcome: 'error',
          errorCode: 'RESOURCE_NOT_FOUND',
          triggeredBy: 'event:correction',
          correctionOf: originalAuditLogId,
        });

        return {
          success: false,
          error,
          errorCode: 'RESOURCE_NOT_FOUND',
          retryable: false,
        };
      }
    }

    // Step 3: Build correction arguments
    const correctionArgs = buildCorrectionArgs(
      correctionToolName,
      correctionType,
      resourceId,
      previousState,
      reason
    );

    logger.debug('Correction args built', { correctionArgs, traceId });

    // Step 4: Execute via Tool Gateway
    const result = await toolGateway.execute({
      tenantId,
      agentId,
      instructionVersion,
      connector: getConnectorFromToolName(correctionToolName),
      entityType: getEntityTypeFromToolName(correctionToolName),
      actionType: getActionTypeFromToolName(correctionToolName),
      payload: correctionArgs,
      traceId,
      idempotencyKey: `correction:${correctionRequestId}`,
    });

    if (!result.success) {
      logger.error('Tool Gateway execution failed', {
        correctionRequestId,
        error: result.error,
        traceId,
      });

      await createCorrectionAuditLog({
        tenantId,
        action: correctionToolName,
        inputArgs: correctionArgs,
        outputSummary: result.error,
        outcome: 'error',
        errorCode: 'TOOL_EXECUTION_FAILED',
        triggeredBy: 'event:correction',
        correctionOf: originalAuditLogId,
      });

      return {
        success: false,
        error: result.error,
        errorCode: 'TOOL_EXECUTION_FAILED',
        retryable: true,
      };
    }

    // Step 5: Write success result to control plane audit logs
    const auditLogResult = await createCorrectionAuditLog({
      tenantId,
      action: correctionToolName,
      inputArgs: correctionArgs,
      outputSummary: JSON.stringify(result.data).substring(0, 4096),
      outcome: 'success',
      triggeredBy: 'event:correction',
      correctionOf: originalAuditLogId,
    });

    logger.info('Correction executed successfully', {
      correctionRequestId,
      correctionAuditLogId: auditLogResult?.id,
      traceId,
    });

    return {
      success: true,
      correctionAuditLogId: auditLogResult?.id,
    };
  } catch (error) {
    logger.error('Correction execution failed', {
      correctionRequestId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      traceId,
    });

    // SE-010: Sanitize error message to prevent internal detail leakage
    const sanitizedError = sanitizeErrorMessage(
      error instanceof Error ? error.message : String(error)
    );

    throw new Error(sanitizedError);
  }
}

/**
 * SE-010: Sanitize error messages to prevent internal detail leakage
 */
function sanitizeErrorMessage(message: string): string {
  // Patterns that might leak internal details
  const sensitivePatterns = [
    /at\s+[\w/.]+:\d+:\d+/g, // Stack trace line numbers
    /\/[\w/.-]+\.(ts|js|mjs)/g, // File paths
    /password[=:]\s*["']?[^"'\s]+/gi, // Passwords
    /api[_-]?key[=:]\s*["']?[^"'\s]+/gi, // API keys
    /token[=:]\s*["']?[^"'\s]+/gi, // Tokens
    /secret[=:]\s*["']?[^"'\s]+/gi, // Secrets
    /\b(postgres|mysql|redis):\/\/[^\s]+/gi, // Connection strings
    /ECONNREFUSED\s+[\d.]+:\d+/g, // Connection errors with IPs
    /at\s+Object\.<anonymous>/g, // Anonymous stack traces
    /Error:\s*ENOENT/g, // File system errors
  ];

  let sanitized = message;
  for (const pattern of sensitivePatterns) {
    sanitized = sanitized.replace(pattern, '[redacted]');
  }

  // Generic fallback for very long error messages
  if (sanitized.length > 200) {
    sanitized = sanitized.substring(0, 200) + '...';
  }

  return sanitized;
}

/**
 * Build correction arguments based on correction type
 */
function buildCorrectionArgs(
  correctionToolName: string,
  correctionType: string,
  resourceId: string | null,
  previousState: PreActionSnapshot | null,
  reason?: string
): Record<string, unknown> {
  const args: Record<string, unknown> = {};

  if (reason) {
    args.reason = reason;
  }

  // For CREATE → ARCHIVE/DELETE: use resource ID
  if (
    correctionToolName.includes('delete') ||
    correctionToolName.includes('archive')
  ) {
    if (resourceId) {
      args.id = resourceId;
    }
    return args;
  }

  // For UPDATE → AMEND: use previous state
  if (correctionType === 'amend' && previousState) {
    return { ...previousState.data, ...args };
  }

  // For financial corrections (refund): derive from resource
  if (correctionToolName.includes('refund')) {
    if (resourceId) {
      args.chargeId = resourceId;
    }
    // Amount would be extracted from original action
    return args;
  }

  // For cancel/void
  if (
    correctionToolName.includes('cancel') ||
    correctionToolName.includes('void')
  ) {
    if (resourceId) {
      args.id = resourceId;
    }
    return args;
  }

  return args;
}

/**
 * BE-006: Extract resource ID from original action's output summary or input args
 */
async function extractResourceId(
  tenantId: string,
  auditLogId: string
): Promise<string | null> {
  try {
    const auditLog = await getAuditLog(tenantId, auditLogId);
    if (!auditLog) {
      return null;
    }

    // Try to extract ID from output summary (created resources)
    if (auditLog.outputSummary) {
      try {
        const output = JSON.parse(auditLog.outputSummary);
        // Common ID field names
        const idFields = ['id', 'resourceId', 'messageId', 'eventId', 'chargeId', 'userId', 'recordId'];
        for (const field of idFields) {
          if (output[field]) {
            return String(output[field]);
          }
        }
        // Nested under common wrappers
        if (output.data?.id) return String(output.data.id);
        if (output.result?.id) return String(output.result.id);
      } catch {
        // outputSummary wasn't JSON, try regex extraction
        const idMatch = auditLog.outputSummary.match(/(?:id|ID)[\s:="']+([a-zA-Z0-9_-]+)/);
        if (idMatch) {
          return idMatch[1];
        }
      }
    }

    // Try to extract from input args (operations on existing resources)
    if (auditLog.inputArgs) {
      const args = auditLog.inputArgs as Record<string, unknown>;
      const idFields = ['id', 'resourceId', 'messageId', 'eventId', 'chargeId', 'userId', 'recordId'];
      for (const field of idFields) {
        if (args[field]) {
          return String(args[field]);
        }
      }
    }

    return null;
  } catch (error) {
    logger.warn('Failed to extract resource ID', {
      tenantId,
      auditLogId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Parse connector from tool name (e.g., "slack_delete_message" -> "slack")
 */
function getConnectorFromToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts[0];
}

/**
 * Parse entity type from tool name (e.g., "slack_delete_message" -> "message")
 */
function getEntityTypeFromToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts.length > 2 ? parts[parts.length - 1] : parts[1];
}

/**
 * Parse action type from tool name (e.g., "slack_delete_message" -> "delete")
 */
function getActionTypeFromToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts.length > 2 ? parts[1] : 'execute';
}
