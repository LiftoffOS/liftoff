// Control Plane Client
// Per implementation plan: API client for writing correction audit logs to control plane

import { logger } from '../infrastructure/logging';
import { readBoundedErrorText } from '../infrastructure/bounded-error-body';
import { getPlatformBackendUrl } from '../infrastructure/runtime-env';
import { CreateAuditLogRequest } from './types';
import { getManagedSecret } from '../infrastructure/secret-store';

// Read at call time, not module-load time. The service token is hydrated
// from Secret Manager by loadSecretsToEnv() at startup, so any module-load
// snapshot would race the bootstrap and capture undefined.
//
// PLATFORM_BACKEND_URL (env-specific, terraform-set) — the legacy
// CONTROL_PLANE_URL fallback to the prod alias was a cross-env trust footgun:
// a dev runtime missing CONTROL_PLANE_URL would silently post audit logs into
// prod.
const getControlPlaneUrl = (): string => getPlatformBackendUrl();
const getServiceToken = (): string => getManagedSecret('TENANT_RUNTIME_SERVICE_TOKEN') || '';

interface AuditLogResponse {
  id: string;
  tenantId: string;
  action: string;
  outcome: 'success' | 'error' | 'gated';
  createdAt: string;
}

/**
 * Create correction audit log in control plane
 */
export async function createCorrectionAuditLog(
  request: CreateAuditLogRequest
): Promise<AuditLogResponse | null> {
  try {
    const response = await fetch(`${getControlPlaneUrl()}/api/agent-audit-logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Auth': getServiceToken(),
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await readBoundedErrorText(response);
      logger.error('Failed to create correction audit log', {
        tenantId: request.tenantId,
        action: request.action,
        status: response.status,
        error: errorText,
      });
      return null;
    }

    const data = await response.json() as AuditLogResponse;

    logger.debug('Correction audit log created', {
      auditLogId: data.id,
      tenantId: request.tenantId,
      action: request.action,
      outcome: request.outcome,
    });

    return data;
  } catch (error) {
    logger.error('Error creating correction audit log', {
      tenantId: request.tenantId,
      action: request.action,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Fetch original audit log from control plane
 */
export async function getAuditLog(
  tenantId: string,
  auditLogId: string
): Promise<{
  id: string;
  action: string;
  inputArgs: Record<string, unknown>;
  outputSummary: string | null;
  outcome: 'success' | 'error' | 'gated';
  triggeredBy: string;
} | null> {
  try {
    const response = await fetch(
      `${getControlPlaneUrl()}/api/agent-audit-logs/${auditLogId}?tenantId=${tenantId}`,
      {
        headers: {
          'X-Service-Auth': getServiceToken(),
        },
      }
    );

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      logger.error('Failed to fetch audit log', {
        tenantId,
        auditLogId,
        status: response.status,
      });
      return null;
    }

    const data = await response.json() as {
      id: string;
      action: string;
      inputArgs: Record<string, unknown>;
      outputSummary: string | null;
      outcome: 'success' | 'error' | 'gated';
      triggeredBy: string;
    };
    return data;
  } catch (error) {
    logger.error('Error fetching audit log', {
      tenantId,
      auditLogId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Get correction registry entry from control plane
 */
export async function getCorrectionRegistryEntry(
  toolName: string
): Promise<{
  correctionToolName: string | null;
  correctionType: string;
  requiresPreviousState: boolean;
  timeWindowSeconds: number | null;
} | null> {
  try {
    const response = await fetch(
      `${getControlPlaneUrl()}/api/correction-registry/${toolName}`,
      {
        headers: {
          'X-Service-Auth': getServiceToken(),
        },
      }
    );

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      logger.error('Failed to fetch correction registry entry', {
        toolName,
        status: response.status,
      });
      return null;
    }

    const data = await response.json() as {
      correctionToolName: string | null;
      correctionType: string;
      requiresPreviousState: boolean;
      timeWindowSeconds: number | null;
    };
    return data;
  } catch (error) {
    logger.error('Error fetching correction registry entry', {
      toolName,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
