// Run a connection's operations through the one classifier, batched through
// platform-backend's existing internal classify endpoint.
//
// With 200 operations live, the HITL classification of each one is what stands
// between an agent and a destructive call, so this step is not optional — but
// it is also not allowed to fail a registration. A classifier that is
// unreachable leaves every operation on `spec-codegen`'s conservative seed,
// which is the safe direction: a read that gates costs one approval prompt, a
// write that does not gate is an unreviewed mutation.
//
// The cache namespace is PER INSTANCE (`custom_api_connector:<connectorId>`)
// and the row carries the tenant, so the global (`tenant_id IS NULL`) fallback
// in the control plane's `getCachedClassification` cannot match another
// workspace's row — two workspaces may both connect a provider whose
// operations have the same names.

import { logger } from '../infra/logging.js';
import {
  CLASSIFY_ROUTE_MAX_TOOLS,
  ClassifyRouteRateLimited,
  classifyToolsViaRoute,
  type ClassifyRouteResult,
} from '../scripts/classify-tools-route-client.js';
import type { OperationClassifierAnswer } from './operations.js';
import type { CustomApiOperation } from './types.js';

/** The per-instance namespace a connection's classifications are cached under. */
export function classificationNamespace(connectorId: string): string {
  return `custom_api_connector:${connectorId}`;
}

/**
 * Classify one connection's operations.
 *
 * Returns whatever the classifier answered. An operation missing from the
 * result simply keeps its seed — `mergeClassification`'s fourth rule.
 */
export async function classifyOperations(args: {
  tenantId: string;
  connectorId: string;
  operations: readonly CustomApiOperation[];
}): Promise<OperationClassifierAnswer[]> {
  const pbUrl = process.env.PLATFORM_BACKEND_URL;
  const serviceToken = process.env.CONNECTOR_SERVICE_TOKEN;
  if (!pbUrl || !serviceToken) {
    logger.warn(
      { connectorId: args.connectorId, operations: args.operations.length },
      'custom_api_classification_skipped_unconfigured',
    );
    return [];
  }

  const answers: ClassifyRouteResult[] = [];
  for (let i = 0; i < args.operations.length; i += CLASSIFY_ROUTE_MAX_TOOLS) {
    const batch = args.operations.slice(i, i + CLASSIFY_ROUTE_MAX_TOOLS);
    try {
      const results = await classifyToolsViaRoute(
        pbUrl,
        serviceToken,
        batch.map((op) => ({ name: op.name, description: op.description })),
        // The tenant's own classification, attributed to them, and cached
        // under this connection alone.
        { kind: 'tenant', tenantId: args.tenantId },
        fetch,
        { integrationType: classificationNamespace(args.connectorId) },
      );
      answers.push(...results);
    } catch (err) {
      // Rate limited or unreachable: the seeds stand. Logged at warn because
      // running on seeds alone is a real, temporary loss of precision — every
      // non-GET gates — and someone should be able to see that it happened.
      logger.warn(
        {
          connectorId: args.connectorId,
          batchStart: i,
          rateLimited: err instanceof ClassifyRouteRateLimited,
          err: (err as Error).message,
        },
        'custom_api_classification_batch_failed',
      );
    }
  }
  return answers.map((a) => ({ name: a.name, categories: a.categories, effectClass: a.effectClass }));
}
