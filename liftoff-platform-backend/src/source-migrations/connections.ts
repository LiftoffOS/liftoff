// Liftoff Switch — imported connection placeholders.
//
// Every source integration lands in exactly one of three destinations. A
// generic "connector requirement" is not specific enough to implement safely,
// so the three are kept apart here:
//
//   A. Catalog connector  — a credential-less placeholder with status 'error'
//      and disconnect_reason 'source_import'. It shows on /dashboard/connections
//      as Needs Reconnect, and the connector's NORMAL setup flow heals that same
//      row to 'active' rather than creating a duplicate.
//   B. Remote HTTP MCP    — the same canonical pair a manually added server
//      gets: a connectors row (type custom_mcp_server, status 'error') plus a
//      custom_mcp_servers row holding non-secret endpoint config, no auth
//      secret and no discovered tools yet.
//   C. Local stdio        — NOT created here at all. It has no callable
//      endpoint, so it stays an unresolved requirement shown as Requires
//      hosting. A fake row would advertise a capability that cannot work.
//
// Placeholders are materialized when the bundle is accepted (pre-payment), so
// the user can reconnect credentials during review — before the subscription
// step — and so imported agents can bind to concrete UUIDs at conversion time.
//
// Connector ids belong to connector-service's own database (INV-PB-012 /
// ADR-049). Nothing here FKs a connector id to the local `connectors` table.

import {
  createImportPlaceholders,
  listConnectorsForTenant,
} from '../connectors/connector-service-client';
import { log } from '../infrastructure/logging';
import {
  lookupServerByPackage,
  normalizePackageName,
  type McpPackageIdentity,
} from './mcp-registry';
import { sourceMigrationRepository } from './repository';
import type {
  CatalogConnectorRequirement,
  CustomMcpServerRequirement,
  HostingRequirement,
  SourceMigrationConnection,
} from './types';

/** Marks a connector row as an import placeholder. `error` carries a
 *  deliberate product meaning on the Connections page: the card renders as
 *  Needs Reconnect and its action opens the normal setup flow. */
export const IMPORT_DISCONNECT_REASON = 'source_import';

export const CUSTOM_MCP_SERVER_CONNECTOR_TYPE = 'custom_mcp_server';

export interface PlaceholderContext {
  tenantId: string;
  accountId: string;
  migrationId: string;
  source: string;
}

/** Record the requirements, then materialize a placeholder for each.
 *
 *  Recording happens first and separately: if connector-service is briefly
 *  unavailable, the requirement survives and the placeholder is created on the
 *  next attempt, rather than the whole import failing. */
export async function materializeCatalogPlaceholders(
  ctx: PlaceholderContext,
  requirements: CatalogConnectorRequirement[],
  opts: { connectableTypes?: Set<string> } = {},
): Promise<{ created: SourceMigrationConnection[]; unsupported: string[] }> {
  const created: SourceMigrationConnection[] = [];
  const unsupported: string[] = [];

  // Adopt what the workspace already has before minting anything.
  //
  // A person switching from OpenClaw very often already uses Liftoff with Slack
  // or GitHub connected. Creating a placeholder anyway produced a SECOND
  // connector of the same type, and the reconnect flow heals the original — so
  // the placeholder stayed in `error` forever, the card never cleared, and the
  // build gate never let go. Reconnecting could not fix it: there was nothing
  // wrong with the connector the person was reconnecting.
  //
  // Adopting is also the right answer on its own terms. Being asked to
  // reconnect an account that is connected and working is a question with no
  // correct answer.
  const existingByType = new Map<string, { id: string; status?: string }>();
  const liveById = new Map<string, { id: string; status?: string }>();
  try {
    for (const c of await listConnectorsForTenant(ctx.tenantId, ctx.accountId)) {
      liveById.set(c.id, { id: c.id, status: c.status });
      if (!c.type) continue;
      const held = existingByType.get(c.type);
      // Prefer an active one; a type may also carry an older broken row.
      if (!held || (held.status !== 'active' && c.status === 'active')) {
        existingByType.set(c.type, { id: c.id, status: c.status });
      }
    }
  } catch (err) {
    // Fall through to creating placeholders. A duplicate is recoverable; a
    // failed import is not.
    log.warn({ tenantId: ctx.tenantId, err }, 'source-migrations: could not read existing connectors');
  }

  for (const req of requirements) {
    // A catalog entry that is not currently connectable must never produce a
    // Needs Reconnect card whose reconnect action cannot work.
    if (opts.connectableTypes && !opts.connectableTypes.has(req.connectorType)) {
      unsupported.push(req.connectorType);
      continue;
    }

    const row = await sourceMigrationRepository.upsertConnection(ctx.tenantId, {
      migrationId: ctx.migrationId,
      sourceRef: req.sourceRef,
      kind: 'catalog',
      connectorType: req.connectorType,
      displayName: req.connectorType,
      externalAccountLabel: req.externalAccountLabel ?? null,
    });

    const existing = existingByType.get(req.connectorType);

    if (row.connectorId) {
      // Re-bind a row pointing at a connector that does not work, when the
      // workspace has one of the same type that does.
      //
      // Adoption on its own only helped migrations created after it shipped.
      // Every migration already in flight kept pointing at the placeholder it
      // was given, so the card kept asking for a reconnect that could never
      // land — the fix would have been real and reached nobody who had already
      // started.
      const bound = liveById.get(row.connectorId);
      if (bound?.status !== 'active' && existing && existing.status === 'active') {
        await sourceMigrationRepository.attachConnectorId(ctx.tenantId, row.id, {
          connectorId: existing.id,
          status: 'active',
        });
        created.push({ ...row, connectorId: existing.id, status: 'active' });
        continue;
      }
      created.push(row);
      continue;
    }

    if (existing) {
      const status = existing.status === 'active' ? 'active' : 'needs_reconnect';
      await sourceMigrationRepository.attachConnectorId(ctx.tenantId, row.id, {
        connectorId: existing.id,
        status,
      });
      created.push({ ...row, connectorId: existing.id, status });
      continue;
    }

    try {
      const connector = await createImportPlaceholder(ctx, {
        type: req.connectorType,
        name: req.externalAccountLabel
          ? `${req.connectorType} (${req.externalAccountLabel})`
          : req.connectorType,
        sourceRef: req.sourceRef,
        externalAccountLabel: req.externalAccountLabel,
      });
      await sourceMigrationRepository.attachConnectorId(ctx.tenantId, row.id, {
        connectorId: connector.id,
        status: 'needs_reconnect',
      });
      created.push({ ...row, connectorId: connector.id, status: 'needs_reconnect' });
    } catch (err) {
      log.error(
        {
          error: (err as Error).message,
          tenantId: ctx.tenantId,
          migrationId: ctx.migrationId,
          connectorType: req.connectorType,
        },
        'source-migrations: catalog placeholder creation failed; requirement kept for retry',
      );
    }
  }

  return { created, unsupported };
}

/** Create the credential-less `error` placeholder in connector-service.
 *
 *  Goes through the narrowly scoped, service-authenticated import route rather
 *  than the ordinary public create endpoint: `error` is not one of that
 *  endpoint's accepted initial states, and it should stay that way. The
 *  `disconnect_reason: 'source_import'` marker and the migration/source-ref
 *  keys are stamped by connector-service, which owns the row. */
async function createImportPlaceholder(
  ctx: PlaceholderContext,
  params: {
    type: string;
    name: string;
    sourceRef: string;
    externalAccountLabel?: string;
    endpointUrl?: string;
  },
): Promise<{ id: string }> {
  const result = await createImportPlaceholders(
    ctx.tenantId,
    ctx.migrationId,
    ctx.source,
    [
      {
        type: params.type,
        name: params.name,
        sourceRef: params.sourceRef,
        externalAccountLabel: params.externalAccountLabel,
        endpointUrl: params.endpointUrl,
      },
    ],
    IMPORT_DISCONNECT_REASON,
  );
  const placeholder = result[0];
  if (!placeholder) {
    throw new Error('connector-service returned no placeholder for the import requirement');
  }
  return { id: placeholder.connectorId };
}

/** Materialize the canonical pair for a customer-owned remote MCP server.
 *
 *  Both projections start unusable on purpose: no auth secret is carried from
 *  the source, and no tools are discovered until the user supplies fresh
 *  credentials through the completion flow. */
export async function materializeMcpPlaceholders(
  ctx: PlaceholderContext,
  requirements: CustomMcpServerRequirement[],
): Promise<SourceMigrationConnection[]> {
  const out: SourceMigrationConnection[] = [];

  // Adopt an MCP server the workspace already has, exactly as the catalog path
  // does. connector-service enforces UNIQUE (tenant, type, name), so importing
  // a server the workspace already knows about failed with a duplicate-key 500:
  // the placeholder was never created, the connection stayed
  // `placeholder_pending`, and that status blocks the build. Importing the same
  // server twice — from a second source, or a second import — was enough.
  const existingByName = new Map<string, { id: string; status?: string }>();
  try {
    for (const c of await listConnectorsForTenant(ctx.tenantId, ctx.accountId)) {
      if (c.type !== CUSTOM_MCP_SERVER_CONNECTOR_TYPE || !c.name) continue;
      existingByName.set(c.name, { id: c.id, status: c.status });
    }
  } catch (err) {
    log.warn({ tenantId: ctx.tenantId, err }, 'source-migrations: could not read existing MCP servers');
  }

  for (const req of requirements) {
    const row = await sourceMigrationRepository.upsertConnection(ctx.tenantId, {
      migrationId: ctx.migrationId,
      sourceRef: req.sourceRef,
      kind: 'mcp_http',
      connectorType: CUSTOM_MCP_SERVER_CONNECTOR_TYPE,
      displayName: req.name,
      endpointUrl: req.url,
      authScheme: req.authScheme,
      // Header NAMES only. A header VALUE is a credential and never crosses
      // the import boundary.
      customHeaderNames: req.customHeaderNames ?? [],
    });

    if (row.connectorId) {
      out.push(row);
      continue;
    }

    const existing = existingByName.get(req.name);
    if (existing) {
      const status = existing.status === 'active' ? 'active' : 'needs_reconnect';
      await sourceMigrationRepository.attachConnectorId(ctx.tenantId, row.id, {
        connectorId: existing.id,
        status,
      });
      out.push({ ...row, connectorId: existing.id, status });
      continue;
    }

    try {
      const connector = await createImportPlaceholder(ctx, {
        type: CUSTOM_MCP_SERVER_CONNECTOR_TYPE,
        name: req.name,
        sourceRef: req.sourceRef,
        endpointUrl: req.url,
      });
      await sourceMigrationRepository.attachConnectorId(ctx.tenantId, row.id, {
        connectorId: connector.id,
        status: 'needs_reconnect',
      });
      out.push({ ...row, connectorId: connector.id, status: 'needs_reconnect' });
    } catch (err) {
      log.error(
        {
          error: (err as Error).message,
          tenantId: ctx.tenantId,
          migrationId: ctx.migrationId,
          server: req.name,
        },
        'source-migrations: MCP placeholder creation failed; requirement kept for retry',
      );
    }
  }

  return out;
}

// ── stdio resolution ───────────────────────────────────────────────────

/** Packages we answer with a Liftoff catalog connector instead of an endpoint.
 *
 *  The ONE hand-curated piece of stdio resolution, and it is a product
 *  preference rather than a compatibility table: when a capability exists both
 *  as a package someone runs locally and as a connector in our catalog, the
 *  connector wins, because a connector is governed and metered and a raw MCP
 *  endpoint is neither. That is the same precedence `connector-map.ts` applies
 *  to a source's own integration names.
 *
 *  Every entry was verified to exist on the npm registry, and
 *  every target is a type `connector-map.ts` already knows. The three
 *  `@modelcontextprotocol/server-*` packages are deprecated upstream, which is
 *  precisely why they are here: a deprecated package is frozen in the configs
 *  that already reference it, and those are the configs being imported. */
const PACKAGE_TO_CATALOG_TYPE: Readonly<Record<string, string>> = {
  'npm:@modelcontextprotocol/server-github': 'github',
  'npm:@modelcontextprotocol/server-slack': 'slack',
  'npm:@modelcontextprotocol/server-gitlab': 'gitlab',
  'npm:@notionhq/notion-mcp-server': 'notion',
  'npm:@hubspot/mcp-server': 'hubspot',
  'npm:airtable-mcp-server': 'airtable',
};

function overlayCatalogType(identity: McpPackageIdentity): string | null {
  const key = `${identity.registryType}:${normalizePackageName(identity.registryType, identity.name)}`;
  return PACKAGE_TO_CATALOG_TYPE[key] ?? null;
}

export interface HostingResolution {
  /** Requirements answered by a catalog connector the workspace can connect. */
  catalog: CatalogConnectorRequirement[];
  /** Requirements answered by an endpoint the vendor hosts. */
  mcp: CustomMcpServerRequirement[];
  /** Everything still needing hosting, exactly as it arrived. */
  remaining: HostingRequirement[];
  diagnostics: string[];
}

/** Decide what each local stdio server actually IS, before anything is
 *  materialized.
 *
 *  A stdio MCP server is a program on the importer's machine that forwards to
 *  an API. Liftoff cannot run their machine, so the question is which
 *  capability it is and where that capability lives here. Three answers, in
 *  precedence order: our own catalog connector, the endpoint the vendor hosts,
 *  or — for someone's in-house script, which has neither — the Requires hosting
 *  card it already got.
 *
 *  Every failure lands on that last answer. A registry that cannot be reached
 *  knows nothing about the server, so it must not change the outcome, and it
 *  must never block an upload. */
export async function resolveHostingRequirements(
  requirements: HostingRequirement[],
): Promise<HostingResolution> {
  const catalog: CatalogConnectorRequirement[] = [];
  const mcp: CustomMcpServerRequirement[] = [];
  const remaining: HostingRequirement[] = [];
  const diagnostics: string[] = [];

  for (const req of requirements) {
    // An endpoint we already know about but could not reach is not a packaging
    // question, and a registry lookup cannot make it reachable.
    if (!req.packageIdentity || req.reason !== 'stdio_mcp_requires_hosting') {
      remaining.push(req);
      continue;
    }

    const direct = overlayCatalogType(req.packageIdentity);
    if (direct) {
      catalog.push(catalogRequirementFrom(req, direct));
      diagnostics.push(`${req.name}: resolved to the ${direct} connector instead of local hosting`);
      continue;
    }

    const { match, lookupFailed } = await lookupServerByPackage(req.packageIdentity);
    if (lookupFailed) {
      remaining.push(req);
      diagnostics.push(`${req.name}: the MCP registry could not be reached; left as requiring hosting`);
      continue;
    }
    if (!match) {
      remaining.push(req);
      continue;
    }

    // The registry knows this server under a name of its own, and it may
    // publish the same capability to several package registries. A catalog
    // match on ANY of them still beats a raw endpoint.
    const viaServer = match.packages.map(overlayCatalogType).find((t): t is string => t !== null);
    if (viaServer) {
      catalog.push(catalogRequirementFrom(req, viaServer));
      diagnostics.push(`${req.name}: resolved to the ${viaServer} connector instead of local hosting`);
      continue;
    }

    const remote = match.remotes.find((r) => r.url.startsWith('https://'));
    if (!remote) {
      remaining.push(req);
      continue;
    }

    mcp.push({
      sourceRef: req.sourceRef,
      name: req.name,
      url: remote.url,
      transport: 'http',
      // No credential crosses the import boundary, so a resolved server starts
      // with no auth and is completed through the normal custom-MCP flow.
      authScheme: 'none',
      usedByIdentityRefs: req.usedByIdentityRefs,
    });
    diagnostics.push(
      `${req.name}: resolved to the hosted endpoint published by ${match.serverName}`,
    );
  }

  return { catalog, mcp, remaining, diagnostics };
}

function catalogRequirementFrom(
  req: HostingRequirement,
  connectorType: string,
): CatalogConnectorRequirement {
  return {
    sourceRef: req.sourceRef,
    connectorType,
    usedByIdentityRefs: req.usedByIdentityRefs,
    usedByRoutineRefs: [],
  };
}

/** Strip the source's own prefix off a ref to get a connector TYPE.
 *
 *  Only ever used for `pending_integrations`, which is type-only by design.
 *  It is never used to bind an agent: a type cannot tell two accounts of the
 *  same connector apart, which is how an agent ends up on the wrong Gmail. */
function connectorTypeFromRef(ref: string): string | null {
  const stripped = ref.replace(/^(channel|mcp):/, '').trim();
  return stripped.length > 0 ? stripped : null;
}

/** Resolve an imported agent's integration refs to CONCRETE connector UUIDs.
 *
 *  Binding to a UUID rather than a type is the whole point: `pending_integrations`
 *  is type-only and cannot tell two accounts of the same connector type apart,
 *  so it could bind an agent to the wrong Gmail or Slack account. It is used
 *  here only for a type that has no placeholder UUID at all. */
export async function resolveAgentBindings(
  tenantId: string,
  migrationId: string,
  integrationRefs: string[],
  mcpServerRefs: string[],
): Promise<{
  integrations: Array<{ id: string; name: string; type: string; selectedObjects: string[] }>;
  pendingIntegrations: string[];
}> {
  const byRef = await sourceMigrationRepository.connectorIdsBySourceRef(tenantId, migrationId);

  const integrations: Array<{ id: string; name: string; type: string; selectedObjects: string[] }> = [];
  const pendingIntegrations: string[] = [];

  for (const ref of [...integrationRefs, ...mcpServerRefs]) {
    // Channel refs are recorded with a `channel:` prefix at normalization.
    const resolved = byRef.get(ref) ?? byRef.get(`channel:${ref}`);
    if (resolved) {
      integrations.push({
        id: resolved.connectorId,
        name: resolved.connectorType,
        type: resolved.connectorType,
        selectedObjects: [],
      });
      continue;
    }

    // No placeholder UUID exists for this ref — the catalog type was not
    // connectable, or placeholder creation has not succeeded yet. Record the
    // TYPE so the requirement is still visible and the agent can be granted
    // the connection when one appears. Dropping it silently would delete a
    // capability the user asked to bring across, with nothing to show for it.
    const type = connectorTypeFromRef(ref);
    if (type && !pendingIntegrations.includes(type)) {
      pendingIntegrations.push(type);
    }
  }

  return { integrations, pendingIntegrations };
}

// ── live status ────────────────────────────────────────────────────────

/** Resolve each imported connection's status against connector-service.
 *
 *  `source_migration_connections.status` is written 'needs_reconnect' when the
 *  placeholder is created and NOTHING ever updated it. The connector itself
 *  lives in connector-service's database (ADR-049), so reconnecting flips the
 *  status over there and this copy stayed stale forever.
 *
 *  Two things read that copy, and both were wrong because of it: the review
 *  screen kept showing Needs Reconnect for a connector the person had just
 *  reconnected, and `convert`'s guard refused to build because it believed the
 *  same thing — so Continue could never succeed for anyone, in any workspace.
 *
 *  One resolver, used by both, so the screen and the gate cannot disagree
 *  about the same connector.
 */
export async function resolveConnectionStatuses(
  tenantId: string,
  accountId: string,
  connections: SourceMigrationConnection[],
): Promise<SourceMigrationConnection[]> {
  const withConnectors = connections.filter((c) => c.connectorId);
  if (withConnectors.length === 0) return connections;

  const live = await listConnectorsForTenant(tenantId, accountId);
  const statusById = new Map(live.map((c) => [c.id, c.status]));

  return connections.map((c) => {
    if (!c.connectorId) return c;
    const status = statusById.get(c.connectorId);
    // Only 'active' clears a reconnect. 'pending' is a connection someone has
    // started and not finished, and treating it as done would build against
    // credentials that do not exist yet.
    if (status === 'active') return { ...c, status: 'active' as const };
    // A connector connector-service no longer has cannot be reconnected from
    // the card, and calling it needs_reconnect would offer an action that
    // cannot work. It stays whatever it was.
    return c;
  });
}
