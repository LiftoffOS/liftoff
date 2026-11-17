// Connections, for the assistants: what the Connections page shows, and the
// connect kinds a conversation can start. Only the kinds that need no secret
// typed into a chat are startable here (D5):
//   static_oauth / dcr_oauth / composio-managed OAuth  → the vendor's consent
//                       screen, handed to the person as a link; zendesk and
//                       bamboohr need a subdomain first
//   github              → the App install: targets in the preview, the
//                       install link on confirm
//   iam_grant           → provision (a service account + the grant steps),
//                       then verify once the person has granted it
//   slack               → the OAuth branch
//   microsoft_teams     → the Microsoft sign-in URL
//   api_key / keypair / custom_mcp with a token → refused, naming the page.
// Every mutation is owner/admin (connections:manage).

import { getCatalog } from '../connectors/connector-service-client';
import {
  deleteConnectorForTenant,
  getConnectorForTenant,
  getConnectorHealthStats,
  listConnectorsForTenant,
  listGithubInstallTargets,
  startGithubInstall,
  startIamGrantConnect,
  startOAuthConnect,
  verifyIamGrantConnect,
  describeCustomApiSpec,
  type GitHubInstallTarget,
} from '../connectors/connector-service-client';
import { buildTeamsConnectUrl } from '../agent-chat/teams-adapter/admin-routes';
import { customMcpServerService } from '../custom-mcp-servers/service';
import type { CustomMcpServer } from '../custom-mcp-servers/types';
import { tunnelsService } from '../tunnels/service';
import { requestApiAccess, CUSTOM_API_CONNECTOR_TYPE } from '../custom-api-connectors/service';
import type {
  CustomApiSpec,
  RequestApiAccessResult,
  UnsupportedSchemeReason,
} from '../custom-api-connectors/types';
import { requirePermission, type Actor } from './actor';
import { writeAudit } from './audit';

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://example.com';
const CONNECTIONS_PAGE = '/dashboard/connections';

/** The connectors whose OAuth authorise URL is per-company: the subdomain is
 *  collected first (ConnectIntegrationModal). */
export const SUBDOMAIN_CONNECTORS: Record<string, { label: string; suffix: string }> = {
  zendesk: { label: 'Zendesk subdomain', suffix: '.zendesk.com' },
  bamboohr: { label: 'BambooHR subdomain', suffix: '.bamboohr.com' },
};

/** Keyless IAM-grant connectors and their routes (useIamGrantConnect). */
const IAM_GRANT_ROUTES: Record<string, string> = {
  google_bigquery: '/api/connectors/bigquery',
};

export interface ConnectionsView {
  connected: Array<{ id: string; type: string; name: string | null; status: string | null }>;
  /** An install a vendor is holding for an organisation owner to approve. The
   *  one unfinished state the Connections page renders, so the one the model
   *  may speak about. */
  awaitingOrgApproval: Array<{ id: string; type: string; name: string | null }>;
  available: Array<{ type: string; name: string; category: string; authKind: string; startableHere: boolean }>;
  health: { totalConnectors: number; healthyConnectors: number; degradedConnectors: number; errorConnectors: number; activeIncidents: number } | null;
  customMcpServers: Array<{ id: string; name: string; deliveryMode: string; endpointHost: string; toolCount: number }>;
}

function authKindOf(def: { auth?: { kind?: string } }): string {
  return def.auth?.kind ?? 'none';
}

function startableHere(type: string, authKind: string): boolean {
  if (type === 'microsoft_teams' || type === 'slack' || type === 'github') return true;
  if (authKind === 'static_oauth' || authKind === 'dcr_oauth' || authKind === 'iam_grant' || authKind === 'none') return true;
  // Deliberately false for `custom_api`. It IS startable from a conversation,
  // but not by `connection_start`: this flag says whether THAT tool can do it,
  // and the one that can is `connection_request_api_access`. Saying true here
  // would send an assistant to a tool that refuses.
  return false;
}

/** Whether a connector row is one the Connections page shows as connected.
 *
 *  The page renders a connector when its status is `active` or `error`
 *  (liftoff-react, useIntegrations.ts) and NOTHING else, bar the org-approval
 *  case below. A `pending` row with no install state, and every `disconnected`
 *  row, appear nowhere: their catalog tile sits under "Available", which is to
 *  say the app reads as not connected.
 *
 *  Handed every row with its raw status, the model can report pending rows to a
 *  person as "started but never finished", then send them to the Connections
 *  page to finish them. The page cannot show those rows, so that is a dead end,
 *  and a half-written connector row is the platform's inner workings rather
 *  than anything the person did (INV-PB-015). An unfinished setup is finished
 *  by starting the
 *  connection again, which `connection_start` does and which is what the page
 *  offers.
 *
 *  The tool's own description opens "The Connections page:". This is what makes
 *  that true. */
export function showsAsConnected(status: string | null | undefined): boolean {
  return status === 'active' || status === 'error';
}

/** The page's one exception: a GitHub App install requested against an
 *  organisation, which it renders in its own section rather than dropping. */
function awaitingOrgApproval(c: { status?: string | null; installState?: string | null }): boolean {
  return c.status === 'pending' && c.installState === 'awaiting_org_approval';
}

export async function listConnections(actor: Actor): Promise<ConnectionsView> {
  const { tenantId, accountId } = actor;
  const [catalog, connectors, health, custom] = await Promise.all([
    getCatalog(),
    listConnectorsForTenant(tenantId, accountId),
    getConnectorHealthStats(tenantId, accountId).catch(() => null),
    customMcpServerService.list(tenantId).catch(() => [] as CustomMcpServer[]),
  ]);
  const byType = new Map(catalog.connectors.map((c) => [c.type, c]));
  return {
    connected: connectors
      .filter((c) => showsAsConnected(c.status))
      .map((c) => ({ id: c.id, type: c.type ?? '', name: c.name ?? byType.get(c.type ?? '')?.displayName ?? null, status: c.status ?? null })),
    awaitingOrgApproval: connectors
      .filter((c) => awaitingOrgApproval(c))
      .map((c) => ({ id: c.id, type: c.type ?? '', name: c.name ?? byType.get(c.type ?? '')?.displayName ?? null })),
    available: catalog.connectors
      .filter((c) => c.status === 'available')
      .map((c) => ({ type: c.type, name: c.displayName, category: c.category, authKind: authKindOf(c), startableHere: startableHere(c.type, authKindOf(c)) })),
    health: health ? { totalConnectors: health.totalConnectors, healthyConnectors: health.healthyConnectors, degradedConnectors: health.degradedConnectors, errorConnectors: health.errorConnectors, activeIncidents: health.activeIncidents } : null,
    customMcpServers: custom.map((s) => {
      let endpointHost = '';
      try { endpointHost = new URL(s.endpointUrl).host; } catch { /* display only */ }
      return { id: s.id, name: s.name, deliveryMode: s.deliveryMode, endpointHost, toolCount: s.rawMcpTools.length };
    }),
  };
}

export type StartConnectPreview =
  | { kind: 'oauth'; connectorType: string; name: string; subdomainRequired?: { label: string; suffix: string } }
  | { kind: 'github_app'; connectorType: 'github'; name: string; targets: GitHubInstallTarget[] }
  | { kind: 'iam_grant'; connectorType: string; name: string; fields: string[] }
  | { kind: 'microsoft_teams'; connectorType: 'microsoft_teams'; name: string }
  | { refused: 'page_only' | 'unknown_connector' | 'unavailable' | 'use_request_api_access'; message: string; page?: string };

/** What starting a connection of this type means, before the person confirms. */
export async function previewConnect(actor: Actor, connectorType: string): Promise<StartConnectPreview> {
  requirePermission(actor, 'connections:manage');
  const { tenantId, accountId } = actor;
  if (connectorType === 'microsoft_teams') {
    return { kind: 'microsoft_teams', connectorType: 'microsoft_teams', name: 'Microsoft Teams' };
  }
  const catalog = await getCatalog();
  const def = catalog.connectors.find((c) => c.type === connectorType);
  if (!def) return { refused: 'unknown_connector', message: `No connector named "${connectorType}" in the catalog.` };
  if (def.status !== 'available') return { refused: 'unavailable', message: def.statusReason ?? `${def.displayName} is not available to connect right now.` };
  const authKind = authKindOf(def);
  if (connectorType === 'github') {
    const targets = await listGithubInstallTargets(tenantId, accountId).catch(() => [] as GitHubInstallTarget[]);
    return { kind: 'github_app', connectorType: 'github', name: def.displayName, targets };
  }
  if (authKind === 'iam_grant') {
    return { kind: 'iam_grant', connectorType, name: def.displayName, fields: ['projectId', 'dataset'] };
  }
  // The one generic custom-API type has no static form to start, and the
  // page-only refusal below would be actively misleading: the Connections page
  // has no form for a service we have never coded, which is the whole reason
  // this family exists. Name the tool that does the job instead.
  if (authKind === 'custom_api') {
    return {
      refused: 'use_request_api_access',
      message: 'An API with no connector of its own is connected with connection_request_api_access: read the provider\'s own documentation, describe the connection, and the person gets a link to enter the key.',
    };
  }
  if (authKind === 'static_oauth' || authKind === 'dcr_oauth' || authKind === 'none' || connectorType === 'slack') {
    return {
      kind: 'oauth',
      connectorType,
      name: def.displayName,
      ...(SUBDOMAIN_CONNECTORS[connectorType] ? { subdomainRequired: SUBDOMAIN_CONNECTORS[connectorType] } : {}),
    };
  }
  return {
    refused: 'page_only',
    message: `${def.displayName} connects with a key or token, which is entered on the Connections page, never in a conversation.`,
    page: `${FRONTEND_URL}${CONNECTIONS_PAGE}`,
  };
}

export type StartConnectResult =
  | { kind: 'oauth'; connectorType: string; link: string; note: string }
  | { kind: 'github_app'; connectorType: 'github'; link: string; targetLogin: string; note: string }
  | { kind: 'iam_grant'; connectorType: string; connectorId: string; serviceAccountEmail: string; grantInstructions: string; status: 'active' | 'pending_grant'; note: string }
  | { kind: 'microsoft_teams'; connectorType: 'microsoft_teams'; link: string; note: string }
  | { refused: 'page_only' | 'unknown_connector' | 'unavailable' | 'validation' | 'not_configured' | 'use_request_api_access'; message: string; page?: string };

export async function startConnect(
  actor: Actor,
  connectorType: string,
  opts: { subdomain?: string; targetLogin?: string; targetId?: number; fields?: Record<string, string>; reconnectConnectorId?: string } = {},
): Promise<StartConnectResult> {
  requirePermission(actor, 'connections:manage');
  const { tenantId, accountId } = actor;
  const returnUrl = `${FRONTEND_URL}/oauth/callback`;

  const preview = await previewConnect(actor, connectorType);
  if ('refused' in preview) return preview;

  if (preview.kind === 'microsoft_teams') {
    const link = buildTeamsConnectUrl(tenantId, accountId);
    if (!link) return { refused: 'not_configured', message: 'Microsoft Teams is not configured for this deployment.' };
    writeAudit(actor, 'connection.start', { connectorType });
    return { kind: 'microsoft_teams', connectorType: 'microsoft_teams', link, note: 'Hand this link to the person: a Microsoft administrator signs in there and consents once; the workspace is connected when they return.' };
  }

  if (preview.kind === 'github_app') {
    const targetLogin = opts.targetLogin?.trim();
    if (!targetLogin) {
      return { refused: 'validation', message: 'Choose which GitHub account or organisation to install on (targetLogin, from the preview\'s targets).' };
    }
    const { installUrl } = await startGithubInstall(tenantId, accountId, { redirectUri: returnUrl, targetLogin, ...(opts.targetId !== undefined ? { targetId: opts.targetId } : {}) });
    writeAudit(actor, 'connection.start', { connectorType, targetLogin });
    return { kind: 'github_app', connectorType: 'github', link: installUrl, targetLogin, note: 'Hand this link to the person: GitHub\'s own install screen opens there. An organisation may need an owner to approve; the Connections page shows the result.' };
  }

  if (preview.kind === 'iam_grant') {
    const route = IAM_GRANT_ROUTES[connectorType];
    if (!route) return { refused: 'page_only', message: `${preview.name} is connected on the Connections page.`, page: `${FRONTEND_URL}${CONNECTIONS_PAGE}` };
    const projectId = opts.fields?.projectId?.trim();
    if (!projectId) return { refused: 'validation', message: 'projectId is required (fields.projectId).' };
    const result = await startIamGrantConnect(tenantId, accountId, route, { projectId, dataset: opts.fields?.dataset?.trim() || undefined });
    writeAudit(actor, 'connection.start', { connectorType, connectorId: result.connectorId });
    return {
      kind: 'iam_grant',
      connectorType,
      connectorId: result.connectorId,
      serviceAccountEmail: result.serviceAccountEmail,
      grantInstructions: result.grantInstructions,
      status: result.status,
      note: result.status === 'active'
        ? 'Connected.'
        : 'Give the person the service account email and the grant steps. Once they have granted access, call connection_verify with this connectorId.',
    };
  }

  // OAuth (static, DCR, Composio-managed, Slack).
  let dynamicUrlParams: Record<string, string> | undefined;
  if (preview.subdomainRequired) {
    const subdomain = opts.subdomain?.trim();
    if (!subdomain) {
      return { refused: 'validation', message: `${preview.name} needs the company's ${preview.subdomainRequired.label} first (the part before ${preview.subdomainRequired.suffix}).` };
    }
    dynamicUrlParams = { subdomain };
  }
  const { authUrl } = await startOAuthConnect(tenantId, accountId, connectorType, {
    returnUrl,
    ...(dynamicUrlParams ? { dynamicUrlParams } : {}),
    ...(opts.reconnectConnectorId ? { connectorId: opts.reconnectConnectorId } : {}),
  });
  writeAudit(actor, 'connection.start', { connectorType, reconnect: !!opts.reconnectConnectorId });
  return {
    kind: 'oauth',
    connectorType,
    link: authUrl,
    note: 'Hand this link to the person: the vendor\'s own consent screen opens there, and the connection completes when they return; the page they land on says they can close it.',
  };
}

export async function verifyConnect(actor: Actor, connectorType: string, connectorId: string): Promise<{ connectorId: string; status: 'active' | 'pending_grant'; detail?: string } | { refused: 'unknown_connector'; message: string }> {
  requirePermission(actor, 'connections:manage');
  const route = IAM_GRANT_ROUTES[connectorType];
  if (!route) return { refused: 'unknown_connector', message: `${connectorType} has no grant to verify.` };
  const result = await verifyIamGrantConnect(actor.tenantId, actor.accountId, route, connectorId);
  writeAudit(actor, 'connection.verify', { connectorType, connectorId, status: result.status });
  return result;
}

export interface DisconnectPreview {
  connector: { id: string; type: string; name: string | null; status: string | null };
  /** Set when the connector is a GitHub App installation: disconnecting
   *  deletes our row and does NOT uninstall the App; access stays until
   *  someone removes the installation in GitHub. */
  githubAppCaveat?: string;
  /** Set for a custom API connection, for the same reason GitHub's is set.
   *
   *  Repair and removal are FOUR separate controls and none of them implies
   *  another: reconnecting replaces the key and keeps the connection, removing
   *  the connection discards our copy of the key and leaves the key itself
   *  working at the provider, revoking at the provider is the person's own
   *  action there, and the schedules of any agents bound to it are theirs to
   *  change. A person who removes a connection believing they have revoked a
   *  key has revoked nothing. */
  customApiCaveat?: string;
}

export async function previewDisconnect(actor: Actor, connectorId: string): Promise<DisconnectPreview | { refused: 'not_found'; message: string }> {
  requirePermission(actor, 'connections:manage');
  const connector = await getConnectorForTenant(actor.tenantId, actor.accountId, connectorId);
  if (!connector) return { refused: 'not_found', message: 'No connection with that id.' };
  const hasGitHubApp = connector.type === 'github' && connector.config !== undefined && (connector.config as { installationId?: unknown }).installationId !== undefined;
  const isCustomApi = connector.type === CUSTOM_API_CONNECTOR_TYPE;
  return {
    connector: { id: connector.id, type: connector.type ?? '', name: connector.name ?? null, status: connector.status ?? null },
    ...(hasGitHubApp ? { githubAppCaveat: 'Disconnecting removes this connection from Liftoff but does not uninstall the Liftoff GitHub App: it keeps its access until someone removes the installation in GitHub\'s settings.' } : {}),
    ...(isCustomApi ? { customApiCaveat: 'Removing this connection discards our copy of the key. It does not revoke the key at the provider, which is done there, and it does not change the schedule of any agent that was bound to it. To replace an expired key without removing anything, ask for a new connection link instead.' } : {}),
  };
}

export async function disconnect(actor: Actor, connectorId: string): Promise<{ disconnected: true; connectorType: string } | { refused: 'not_found'; message: string }> {
  requirePermission(actor, 'connections:manage');
  // The connection is read under THIS tenant before it is deleted: the id is
  // caller-supplied, and the delete route is addressed by id alone.
  const connector = await getConnectorForTenant(actor.tenantId, actor.accountId, connectorId);
  if (!connector) return { refused: 'not_found', message: 'No connection with that id.' };
  await deleteConnectorForTenant(connectorId, actor.accountId);
  writeAudit(actor, 'connection.disconnect', { connectorId, connectorType: connector.type ?? null });
  return { disconnected: true, connectorType: connector.type ?? '' };
}

// ── Custom MCP servers ───────────────────────────────────────────────────

export function customMcpView(s: CustomMcpServer) {
  let endpointHost = '';
  try { endpointHost = new URL(s.endpointUrl).host; } catch { /* display only */ }
  return {
    id: s.id,
    name: s.name,
    deliveryMode: s.deliveryMode,
    endpointHost,
    authType: s.authType,
    tunnelRouteId: s.tunnelRouteId,
    connectorId: s.connectorId,
    tools: s.rawMcpTools.map((t) => ({ name: t.name, description: t.description ?? null })),
  };
}

export async function customMcpConnect(actor: Actor, input: { name: string; endpointUrl: string }): Promise<{ server: ReturnType<typeof customMcpView> }> {
  requirePermission(actor, 'connections:manage');
  const server = await customMcpServerService.create(actor.tenantId, actor.accountId, {
    name: input.name,
    deliveryMode: 'public_url',
    endpointUrl: input.endpointUrl,
    authType: 'none',
  });
  writeAudit(actor, 'custom_mcp_server.created', { customMcpServerId: server.id, name: server.name });
  return { server: customMcpView(server) };
}

export async function customMcpUpdate(actor: Actor, id: string, patch: { endpointUrl?: string; name?: string }): Promise<{ server: ReturnType<typeof customMcpView> } | { refused: 'not_found' | 'tunnelled'; message: string }> {
  requirePermission(actor, 'connections:manage');
  const existing = await customMcpServerService.get(actor.tenantId, id);
  if (!existing) return { refused: 'not_found', message: 'No custom MCP server with that id.' };
  if (patch.endpointUrl && existing.deliveryMode === 'tunneled') {
    return { refused: 'tunnelled', message: 'A tunnelled server owns its endpoint; change the tunnel route on the Connections page instead.' };
  }
  const updated = await customMcpServerService.update(actor.tenantId, id, patch);
  if (!updated) return { refused: 'not_found', message: 'No custom MCP server with that id.' };
  writeAudit(actor, 'custom_mcp_server.updated', { customMcpServerId: id, fields: Object.keys(patch) });
  return { server: customMcpView(updated) };
}

export async function customMcpDelete(actor: Actor, id: string): Promise<{ deleted: true } | { refused: 'not_found'; message: string }> {
  requirePermission(actor, 'connections:manage');
  const ok = await customMcpServerService.delete(actor.tenantId, actor.accountId, id);
  if (!ok) return { refused: 'not_found', message: 'No custom MCP server with that id.' };
  writeAudit(actor, 'custom_mcp_server.deleted', { customMcpServerId: id });
  return { deleted: true };
}

export async function customMcpTools(actor: Actor, id: string): Promise<{ server: ReturnType<typeof customMcpView> } | { refused: 'not_found'; message: string }> {
  const server = await customMcpServerService.get(actor.tenantId, id);
  if (!server) return { refused: 'not_found', message: 'No custom MCP server with that id.' };
  return { server: customMcpView(server) };
}

export async function customMcpRediscover(actor: Actor, id: string): Promise<{ server: ReturnType<typeof customMcpView> } | { refused: 'not_found'; message: string }> {
  requirePermission(actor, 'connections:manage');
  const server = await customMcpServerService.rediscover(actor.tenantId, id, () => undefined);
  if (!server) return { refused: 'not_found', message: 'No custom MCP server with that id.' };
  writeAudit(actor, 'custom_mcp_server.rediscovered', { customMcpServerId: id, toolCount: server.rawMcpTools.length });
  return { server: customMcpView(server) };
}

export async function tunnelsState(actor: Actor): Promise<{ deployments: Array<{ id: string; name: string; status: string; lastSeenAt: Date | null; routes: Array<{ id: string; subdomain: string; publicUrl: string }> }> }> {
  const deployments = await tunnelsService.listDeployments(actor.tenantId);
  const routes = await tunnelsService.listRoutes(actor.tenantId);
  return {
    deployments: deployments.map((d) => ({
      id: d.id,
      name: d.name,
      status: d.status,
      lastSeenAt: d.lastSeenAt,
      routes: routes.filter((r) => r.deploymentId === d.id).map((r) => ({ id: r.id, subdomain: r.subdomain, publicUrl: r.publicUrl })),
    })),
  };
}

// ── Custom API connections ───────────────────────────────────────────────
//
// An assistant meets a service the workspace wants and there is no connector
// for it. Rather than sending the person to a page that has no form for a
// service we have never coded, the conversation finishes the job: the
// assistant reads the provider's own documentation, describes the connection,
// and this mints a link for the person to enter the credential on.
//
// THREE ANSWERS, NEVER A FOURTH: already connected (name the existing
// connection), unsupported scheme (a named reason the assistant can relay), or
// a capture link. The mint writes a capture-token row and nothing else — no
// connector row yet, so an abandoned flow leaves no tile to clean up.

export async function requestApiAccessForActor(
  actor: Actor,
  input: {
    spec: CustomApiSpec;
    unsupportedScheme?: UnsupportedSchemeReason;
    reconnectConnectorId?: string;
  },
): Promise<RequestApiAccessResult> {
  requirePermission(actor, 'connections:manage');
  const result = await requestApiAccess({
    tenantId: actor.tenantId,
    accountId: actor.accountId,
    spec: input.spec,
    ...(input.unsupportedScheme ? { unsupportedScheme: input.unsupportedScheme } : {}),
    ...(input.reconnectConnectorId ? { reconnectConnectorId: input.reconnectConnectorId } : {}),
  });
  writeAudit(actor, 'connection.request_api_access', {
    provider: input.spec.providerSlug,
    outcome: result.kind,
    ...(result.kind === 'already_connected' ? { connectorId: result.connectorId } : {}),
    ...(result.kind === 'unsupported_scheme' ? { reason: result.reason } : {}),
    ...(input.reconnectConnectorId ? { reconnect: true } : {}),
  });
  return result;
}

/** What connecting this specification would give, for the confirmation the
 *  person sees. Reads the provider's document through connector-service, which
 *  owns the OpenAPI machinery, and creates nothing. */
export async function previewApiAccess(
  actor: Actor,
  spec: CustomApiSpec,
): Promise<
  | {
    operationCount: number;
    sampleOperations: string[];
    skippedCount?: number;
    skippedOperations?: string[];
    skippedReasons?: string[];
  }
  | { refused: string; message: string; operations?: string[] }
> {
  requirePermission(actor, 'connections:manage');
  const result = await describeCustomApiSpec({
    tenantId: actor.tenantId,
    accountId: actor.accountId,
    spec: spec as unknown as Record<string, unknown>,
  });
  if ('refused' in result) {
    return {
      refused: result.refused,
      message: result.message,
      ...(result.operations ? { operations: result.operations } : {}),
    };
  }
  return {
    operationCount: result.operationCount,
    sampleOperations: result.sampleOperations,
    // Carried through rather than rebuilt from the fields this function knew
    // about when it was written: a preview that drops what it was not taught
    // is how a person finds out about a missing endpoint afterwards.
    ...(result.skippedCount ? { skippedCount: result.skippedCount } : {}),
    ...(result.skippedOperations?.length ? { skippedOperations: result.skippedOperations } : {}),
    ...(result.skippedReasons?.length ? { skippedReasons: result.skippedReasons } : {}),
  };
}
