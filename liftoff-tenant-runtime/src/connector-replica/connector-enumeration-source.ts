// Turning a connector's own list functions into census pages.
//
// The worker is deliberately vendor-agnostic: it takes an `EnumerationSource`
// and does the reconciliation. This is the source. It dispatches the connector's
// declared `list_*` function through the tool gateway — the same path a tool
// call takes, so quota, governance and error translation all apply unchanged.
//
// READ-ONLY AND METADATA-ONLY. It calls list functions and reads identifiers,
// names and versions off the results. It never calls a `get_*` or `read_*`, so
// a census can never turn into a content crawl by accident.

import type { ConnectorFunction } from '@liftoffos/connector-types';
import { getToolSchemas } from '../connectors/tool-schema-cache';
import { logger } from '../infrastructure/logging';
import type { ToolGatewayDispatcher } from '../tool-gateway/dispatcher';
import {
  EnumerationRateLimited,
  type EnumeratedEntity,
  type EnumerationBatch,
  type EnumerationSource,
} from './enumerate-worker';

/** Functions that enumerate. Matched on the declared name, because that is what
 *  the connector author controls and what the tool catalog exposes. */
function isListFunction(fn: ConnectorFunction): boolean {
  return /^(list|search|query)_/.test(fn.name);
}

/** The list functions for a connector, one per entity type it enumerates.
 *  Exported so the scheduler can decide whether a connector is enumerable at
 *  all before it creates a job for it. */
export function enumerableFunctions(connectorType: string): ConnectorFunction[] {
  try {
    return getToolSchemas(connectorType).filter(isListFunction);
  } catch (err) {
    logger.warn({ err: (err as Error).message, connectorType }, 'enumerable_functions_lookup_failed');
    return [];
  }
}

/** Pull the entity identifier out of a vendor row. Vendors disagree about the
 *  key; none of them omit it. */
function remoteIdOf(row: Record<string, unknown>): string | null {
  for (const key of ['id', 'remoteId', 'remote_id', 'key', 'name', 'gid', 'uid']) {
    const v = row[key];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  return null;
}

/** A human-readable label, when the vendor gives one. Never required: an entity
 *  with no title is still a real entity, and inventing one would put a
 *  fabricated name into a surface agents read as fact. */
function titleOf(row: Record<string, unknown>): string | null {
  for (const key of ['name', 'title', 'subject', 'displayName', 'display_name', 'label']) {
    const v = row[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function versionOf(row: Record<string, unknown>): string | null {
  for (const key of ['updatedAt', 'updated_at', 'modifiedAt', 'lastModified', 'etag', 'version', 'SystemModstamp']) {
    const v = row[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/** A stable, readable address for an entity. Deterministic, so re-enumeration
 *  produces the same path and the row updates rather than duplicating. */
function projectedPath(connectorType: string, entityType: string, remoteId: string): string {
  const slug = remoteId.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120);
  return `${connectorType}/${entityType}/${slug}`;
}

/** Rows out of a list response, whatever the connector calls the array. */
function rowsFrom(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (!data || typeof data !== 'object') return [];
  const obj = data as Record<string, unknown>;
  for (const key of ['items', 'results', 'records', 'data', 'messages', 'channels', 'files', 'rows']) {
    if (Array.isArray(obj[key])) return obj[key] as Record<string, unknown>[];
  }
  return [];
}

function cursorFrom(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  for (const key of ['nextPageToken', 'next_page_token', 'nextCursor', 'next_cursor', 'cursor', 'offset']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * Build a source that enumerates one entity type through the tool gateway.
 *
 * `scope` names the connector function to call, so a job per scope is a job per
 * entity type and a slow one cannot hold up the others.
 */
export function buildConnectorEnumerationSource(args: {
  toolGateway: ToolGatewayDispatcher;
  agentId: string;
  instructionVersion: number;
  traceId: string;
}): EnumerationSource {
  return async ({ tenantId, connectorId, connectorType, scope, cursor }): Promise<EnumerationBatch> => {
    const fn = enumerableFunctions(connectorType).find((f) => f.name === scope);
    if (!fn) {
      // Not an error: a connector can stop declaring a function between runs.
      // Reporting an empty INCREMENTAL batch means nothing gets marked deleted
      // on the strength of a function that is no longer there.
      logger.info({ tenantId, connectorType, scope }, 'enumeration_source_function_absent');
      return { entities: [], cursor: null, kind: 'incremental' };
    }

    let result;
    try {
      result = await args.toolGateway.execute({
        tenantId,
        agentId: args.agentId,
        instructionVersion: args.instructionVersion,
        traceId: args.traceId,
        idempotencyKey: `census-${tenantId}-${connectorId}-${scope}-${cursor ?? 'start'}`,
        connector: connectorId,
        entityType: fn.entityType ?? scope,
        actionType: fn.name,
        payload: cursor ? { cursor, pageToken: cursor } : {},
        estimatedCredits: 1,
        _internalSkipHitl: true,
      });
    } catch (err) {
      // A quota refusal is not a failure of this job — it is the platform
      // telling it to come back later, and the worker parks on it.
      const code = (err as { code?: string }).code;
      const retryAfterMs = (err as { retryAfterMs?: number }).retryAfterMs;
      if (code === 'rate_limited') {
        throw new EnumerationRateLimited(retryAfterMs ?? 60_000);
      }
      throw err;
    }

    if (!result.success) {
      if (result.errorCode === 'rate_limited' || result.retryable === true) {
        throw new EnumerationRateLimited(result.retryAfterMs ?? 60_000);
      }
      throw new Error(result.error ?? `enumeration failed for ${connectorType}.${scope}`);
    }

    const entityType = fn.entityType ?? scope.replace(/^(list|search|query)_/, '');
    const entities: EnumeratedEntity[] = [];
    for (const row of rowsFrom(result.data)) {
      const remoteId = remoteIdOf(row);
      // A row with no identifier cannot be addressed later, so it is dropped
      // rather than stored under a synthesized key that nothing can resolve.
      if (!remoteId) continue;
      entities.push({
        remoteId,
        entityType,
        title: titleOf(row),
        projectedPath: projectedPath(connectorType, entityType, remoteId),
        parentRemoteId: null,
        remoteVersion: versionOf(row),
      });
    }

    const next = cursorFrom(result.data);
    return {
      entities,
      cursor: next,
      // A page with no cursor ends a series that covered the whole scope, so it
      // is COMPLETE and deletion detection may run. A page that hands back a
      // cursor has, by definition, not seen everything yet.
      kind: next ? 'incremental' : 'complete',
    };
  };
}
