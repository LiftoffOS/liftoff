// Resource Validator
// Per implementation plan: Validate resource exists before correction

import { logger } from '../infrastructure/logging';
import { ResourceValidationResult } from './types';
import { getToolGatewayDispatcher } from '../tool-gateway/dispatcher';

// Phase 4: dispatcher resolves to HTTP client under split SERVICE_TYPE.
const toolGateway = getToolGatewayDispatcher();

/**
 * Validate that a resource still exists before attempting correction
 */
export async function validateResourceExists(
  tenantId: string,
  correctionToolName: string,
  resourceId: string,
  traceId: string
): Promise<ResourceValidationResult> {
  const connector = getConnectorFromToolName(correctionToolName);
  const resourceType = getResourceTypeFromToolName(correctionToolName);

  try {
    // Use Tool Gateway to fetch the resource
    const result = await toolGateway.execute({
      tenantId,
      agentId: 'system:correction-validator',
      instructionVersion: 0,
      connector,
      entityType: resourceType,
      actionType: 'get',
      payload: { id: resourceId },
      traceId,
      idempotencyKey: `validate:${resourceId}:${traceId}`,
    });

    if (result.success && result.data) {
      return { exists: true, resourceType };
    }

    // Check if error indicates not found
    if (isNotFoundError(result.error)) {
      return {
        exists: false,
        error: 'Resource no longer exists',
        resourceType,
      };
    }

    // Other error - treat as exists (fail-open for availability)
    logger.warn('Resource validation returned error, assuming exists', {
      tenantId,
      resourceId,
      error: result.error,
      traceId,
    });

    return { exists: true, resourceType };
  } catch (error) {
    // Check if it's a not found error
    if (isNotFoundError(error)) {
      return {
        exists: false,
        error: 'Resource no longer exists',
        resourceType,
      };
    }

    // Network or other transient error - assume exists to avoid blocking
    logger.warn('Resource validation failed, assuming exists', {
      tenantId,
      resourceId,
      error: error instanceof Error ? error.message : String(error),
      traceId,
    });

    return { exists: true, resourceType };
  }
}

/**
 * Check if error indicates resource not found
 */
export function isNotFoundError(error: unknown): boolean {
  if (!error) return false;

  const errorString = typeof error === 'string'
    ? error.toLowerCase()
    : error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();

  const notFoundPatterns = [
    'not found',
    'not_found',
    'notfound',
    '404',
    'does not exist',
    'no longer exists',
    'deleted',
    'removed',
  ];

  return notFoundPatterns.some((pattern) => errorString.includes(pattern));
}

/**
 * Parse connector from tool name
 */
function getConnectorFromToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts[0];
}

/**
 * Parse resource type from tool name
 */
function getResourceTypeFromToolName(toolName: string): string {
  const parts = toolName.split('_');
  // e.g., "slack_delete_message" -> "message"
  // e.g., "linear_archive_issue" -> "issue"
  return parts.length > 2 ? parts[parts.length - 1] : parts[1];
}

/**
 * Validate multiple resources
 */
export async function validateResourcesExist(
  tenantId: string,
  resources: Array<{ correctionToolName: string; resourceId: string }>,
  traceId: string
): Promise<Map<string, ResourceValidationResult>> {
  const results = new Map<string, ResourceValidationResult>();

  await Promise.all(
    resources.map(async ({ correctionToolName, resourceId }) => {
      const result = await validateResourceExists(
        tenantId,
        correctionToolName,
        resourceId,
        traceId
      );
      results.set(resourceId, result);
    })
  );

  return results;
}
