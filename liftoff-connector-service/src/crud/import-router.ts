// Import placeholders for Liftoff Switch.
//
// A migration from OpenClaw or Hermes brings across which integrations an
// imported team used, never their credentials — those belong to another
// installation and, for Composio-backed connectors, to another Composio project
// and connected-account identity entirely. So each recognised integration
// becomes a credential-less placeholder that the user reconnects here.
//
// Why this is a separate route rather than a flag on POST /api/connectors:
// the public create endpoint accepts only `pending` and `active`, deliberately.
// `error` carries a product meaning on the Connections page — the card renders
// as "Needs Reconnect" and its action opens the connector's normal setup flow,
// which then heals THAT row to active instead of creating a duplicate. Letting
// any caller create rows in `error` would make an error state assertable by
// anyone; keeping it here means only a service-authenticated import can.
//
// Mounted under /api/internal/connectors, behind the same verifyServiceAuth
// gate as everything else in this service.

import { Router, type Request, type Response } from 'express';
import { logger } from '../infra/logging.js';
import { connectorCrudService } from './service.js';
import { withTenantScope } from '../db/pool.js';
import { CONNECTOR_DISPLAY_NAMES, type ConnectorType } from '../types.js';

/** Same check the CRUD router applies: a type is valid when the catalog knows
 *  how to display it. Kept local rather than exported from the CRUD router so
 *  the two mounts stay independent. */
function isValidConnectorType(type: string): type is ConnectorType {
  return type in CONNECTOR_DISPLAY_NAMES;
}

export const connectorImportRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Markers this endpoint will stamp. The caller names the kind of import,
 *  because it is the one that knows; the allowlist is here because this service
 *  owns the row and an arbitrary caller-supplied reason would let anyone author
 *  the field that reconnection adoption keys on. */
const ALLOWED_DISCONNECT_REASONS = new Set(['source_import']);
const DEFAULT_DISCONNECT_REASON = 'source_import';

interface ImportRequirement {
  type: ConnectorType;
  name?: string;
  /** Stable reference within the source installation. Half of the idempotency
   *  key, so a re-run adopts the existing placeholder. */
  sourceRef: string;
  externalAccountLabel?: string;
  /** Non-secret endpoint config for an imported custom MCP server. Never an
   *  authentication secret, never a custom header VALUE. */
  endpointUrl?: string;
}

/**
 * POST /api/internal/connectors/import-requirements
 *
 * Body: { tenantId, migrationId, importSource, requirements: ImportRequirement[] }
 *
 * Creates one credential-less `error` placeholder per requirement, idempotent
 * on (tenant, migrationId, sourceRef). Returns the connector id for each so the
 * caller can bind imported agents to the exact UUID: binding by connector TYPE
 * cannot tell two accounts of the same type apart, which is how an agent ends
 * up on the wrong Gmail.
 */
connectorImportRouter.post('/import-requirements', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    tenantId?: unknown;
    migrationId?: unknown;
    importSource?: unknown;
    disconnectReason?: unknown;
    requirements?: unknown;
  };

  const tenantId = typeof body.tenantId === 'string' ? body.tenantId : null;
  const migrationId = typeof body.migrationId === 'string' ? body.migrationId : null;
  const importSource = typeof body.importSource === 'string' ? body.importSource : null;

  if (!tenantId || !UUID_RE.test(tenantId)) {
    return res.status(400).json({ error: 'tenantId (UUID) is required' });
  }
  if (!migrationId || !UUID_RE.test(migrationId)) {
    return res.status(400).json({ error: 'migrationId (UUID) is required' });
  }
  if (!importSource || (importSource !== 'openclaw' && importSource !== 'hermes')) {
    return res.status(400).json({ error: 'importSource must be openclaw or hermes' });
  }

  const disconnectReason =
    typeof body.disconnectReason === 'string' ? body.disconnectReason : DEFAULT_DISCONNECT_REASON;
  if (!ALLOWED_DISCONNECT_REASONS.has(disconnectReason)) {
    return res.status(400).json({
      error: `Unsupported disconnectReason: ${disconnectReason}`,
    });
  }
  if (!Array.isArray(body.requirements) || body.requirements.length === 0) {
    return res.status(400).json({ error: 'requirements must be a non-empty array' });
  }
  if (body.requirements.length > 200) {
    return res.status(400).json({ error: 'at most 200 requirements per call' });
  }

  const requirements: ImportRequirement[] = [];
  for (const raw of body.requirements) {
    if (!raw || typeof raw !== 'object') {
      return res.status(400).json({ error: 'each requirement must be an object' });
    }
    const r = raw as Record<string, unknown>;
    const type = typeof r.type === 'string' ? r.type : null;
    const sourceRef = typeof r.sourceRef === 'string' ? r.sourceRef : null;
    if (!type || !sourceRef) {
      return res.status(400).json({ error: 'each requirement needs type and sourceRef' });
    }
    // Only KNOWN catalog types. An unrecognised type would produce a card whose
    // reconnect action cannot work, which is worse than reporting it upstream
    // as unsupported.
    if (!isValidConnectorType(type)) {
      return res.status(400).json({ error: `Unknown connector type: ${type}` });
    }
    requirements.push({
      type,
      sourceRef,
      name: typeof r.name === 'string' ? r.name : undefined,
      externalAccountLabel:
        typeof r.externalAccountLabel === 'string' ? r.externalAccountLabel : undefined,
      endpointUrl: typeof r.endpointUrl === 'string' ? r.endpointUrl : undefined,
    });
  }

  try {
    const created: Array<{ sourceRef: string; connectorId: string; type: string; adopted: boolean }> = [];

    for (const requirement of requirements) {
      // Idempotency: an existing placeholder for the same migration and source
      // ref is adopted, never duplicated. Keyed inside config because these two
      // values are import-specific and do not belong in the connectors schema.
      const existing = await withTenantScope<{ rows: Array<{ id: string }> }>(tenantId, (client) =>
        client.query<{ id: string }>(
          `SELECT id FROM connectors
            WHERE tenant_id = $1
              AND config->>'import_migration_id' = $2
              AND config->>'import_source_ref' = $3
            LIMIT 1`,
          [tenantId, migrationId, requirement.sourceRef],
        ),
      );

      if (existing.rows.length > 0) {
        created.push({
          sourceRef: requirement.sourceRef,
          connectorId: existing.rows[0].id,
          type: requirement.type,
          adopted: true,
        });
        continue;
      }

      const config: Record<string, unknown> = {
        disconnect_reason: disconnectReason,
        import_source: importSource,
        import_migration_id: migrationId,
        import_source_ref: requirement.sourceRef,
      };
      if (requirement.externalAccountLabel) {
        config.externalAccountLabel = requirement.externalAccountLabel;
      }
      if (requirement.endpointUrl) {
        config.endpointUrl = requirement.endpointUrl;
        config.deliveryMode = 'public_url';
      }

      const connector = await connectorCrudService.create({
        tenantId,
        type: requirement.type,
        name: requirement.name ?? connectorCrudService.getDisplayName(requirement.type),
        config,
        status: 'error',
      });

      logger.info(
        {
          audit: true,
          connectorId: connector.id,
          connectorType: requirement.type,
          tenantId,
          migrationId,
          importSource,
        },
        'connector.import_placeholder_created',
      );

      created.push({
        sourceRef: requirement.sourceRef,
        connectorId: connector.id,
        type: requirement.type,
        adopted: false,
      });
    }

    return res.status(201).json({ placeholders: created });
  } catch (err) {
    logger.error(
      { error: (err as Error).message, tenantId, migrationId },
      'import-requirements failed',
    );
    return res.status(500).json({ error: (err as Error).message });
  }
});
