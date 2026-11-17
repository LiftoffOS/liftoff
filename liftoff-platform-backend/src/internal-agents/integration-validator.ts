// WS-5.1 — UUID + connectorType validation on internal_agents.integrations
// JSONB write path. Rejects literal-string ids like "slack" and references
// to unknown connectorTypes BEFORE the row reaches the DB.

import { z } from 'zod';
import { resolveConnectorTypes } from '../connectors/connector-service-client';
import { fetchRegistry } from '../connectors/connector-type-registry';
import { log } from '../infrastructure/logging';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IntegrationElement = z
  .object({
    id: z.string().refine((v) => UUID_RE.test(v), {
      message: 'integration.id must be a valid UUID (literal connector-type strings like "slack" are not accepted)',
    }),
    // `type` distinguishes connector instances from peer-agent references.
    // Peer agents (external_agent / internal_agent) point at another agent,
    // not at a row in the `connectors` table — they must skip the
    // connector-lookup phase below.
    type: z.string().optional(),
    selectedObjects: z.array(z.string()).default([]),
  })
  .passthrough();

export const IntegrationsArraySchema = z.array(IntegrationElement);

export class IntegrationValidationError extends Error {
  constructor(message: string, public readonly context: Record<string, unknown>) {
    super(message);
    this.name = 'IntegrationValidationError';
  }
}

/**
 * Validates an integrations JSONB array against the UUID requirement AND
 * verifies every `id` resolves to a connector_instance with a connectorType
 * that's in the live connector-service registry. Throws an
 * IntegrationValidationError on first failure; the caller surfaces it as HTTP 400.
 */
export async function validateIntegrationsArray(
  raw: unknown,
  ctx: { tenantId: string; agentId?: string },
): Promise<z.infer<typeof IntegrationsArraySchema>> {
  const parsed = IntegrationsArraySchema.parse(raw);
  if (parsed.length === 0) return parsed;

  // Peer-agent integrations (external_agent / internal_agent) point at
  // another agent's id — they are NOT connector instances and never appear
  // in the `connectors` table. Exempt them from the connector-resolution
  // check; the runtime resolves them through internal_agents lookup at
  // execution time (delegate_to_agent dispatch).
  const PEER_AGENT_TYPES = new Set(['external_agent', 'internal_agent']);
  const connectorRows = parsed.filter(
    (p) => !p.type || !PEER_AGENT_TYPES.has(p.type),
  );
  if (connectorRows.length === 0) return parsed;

  // Resolve connector ids against connector-service — the authoritative
  // source. PB's local `connectors` table (migration 013) is only a partial
  // mirror: custom_mcp_server rows are written by custom-mcp-servers/service.ts
  // and slack workspace rows are written by the Slack adapter, but OAuth
  // connectors (Gmail, Google Drive, Outlook, GitHub, etc.) live exclusively
  // in connector-service and never land in the PB mirror. Querying the local
  // table here would falsely reject every OAuth-only integration. The
  // _resolve endpoint queries connector-service's DB directly and returns
  // the live id → type → status mapping.
  const ids = connectorRows.map((p) => p.id);
  let resolved: Array<{ id: string; type: string; status: string }> = [];
  try {
    resolved = await resolveConnectorTypes(ctx.tenantId, ids);
  } catch (err) {
    // Fail open on connector-service outage — distill should not block on a
    // transient resolver failure. The UUID + zod parse above remain the
    // primary integrity guarantee; the runtime will surface any genuinely
    // unresolvable id at execution time.
    log.warn(
      { err: (err as Error).message, tenantId: ctx.tenantId, idCount: ids.length },
      'integration-validator: resolveConnectorTypes failed — fail-open and skip remaining checks',
    );
    return parsed;
  }
  const found = new Map<string, string>(
    resolved.filter((r) => r.status !== 'disabled').map((r) => [r.id, r.type]),
  );

  // Reject ids that don't resolve.
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new IntegrationValidationError(
      `integration.id values do not resolve to active connector instances: ${missing.join(', ')}`,
      { tenantId: ctx.tenantId, missingIds: missing },
    );
  }

  // Validate each connector_type is in the live registry. fetchRegistry
  // already returns an empty map on missing CONNECTOR_SERVICE_URL — extend
  // the same fail-open behavior to HTTP-error responses so a 401 / 503 from
  // connector-service degrades gracefully instead of blocking every
  // distill across the tenant.
  let registry: Awaited<ReturnType<typeof fetchRegistry>>;
  try {
    registry = await fetchRegistry();
  } catch {
    registry = new Map();
  }
  const unknownTypes = [...new Set([...found.values()].filter((t) => !registry.has(t)))];
  if (unknownTypes.length > 0 && registry.size > 0) {
    // If registry is empty (connector-service unreachable), skip the type check
    // rather than block writes. The UUID + resolve check above is the
    // primary integrity guarantee.
    throw new IntegrationValidationError(
      `integration.id references unknown connectorTypes: ${unknownTypes.join(', ')}`,
      { tenantId: ctx.tenantId, unknownTypes },
    );
  }

  return parsed;
}
