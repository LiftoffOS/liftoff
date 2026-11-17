// ai-teams.json, external-collaborators.json, knowledge.json, connections.json
// and members.json.
//
// Each projection writes the labels the page shows and nothing the page does
// not: the card's name, pill and description for a team or a collaborator,
// the Update Team page's headings for what each was built from, the catalog
// display name for an app, the role dropdown's word for a member. Connector display
// names come from the catalog, which by design serves its last good copy when
// a refresh fails; the export accepts a STALE catalog, but no catalog at all
// (first load failed, nothing cached) is the `connectors` 503, and a
// connector whose type is absent from the catalog is OMITTED, exactly as the
// page omits it.

import type { ConnectorCatalogResponse } from '@liftoffos/connector-types';
import { getCatalog, listConnectorsForTenant, type TenantConnectorSummary } from '../connectors/connector-service-client';
import { enrichIntegrationsWithType } from '../internal-agents/integration-enrichment';
import type { IntegrationPermission } from '../internal-agents/types';
import { ExportSourceUnavailableError } from './budget';
import type {
  TeamRow, KnowledgeRow, CustomMcpRow, MemberRow, InvitationRow, AssignmentRow, ExternalCollaboratorRow,
} from './queries';
import { projectLearnedContext, type LearnedMemory, type LearnedContextEntry } from './learned-context';
import {
  TEAM_KEYS,
  TEAM_STATUS_LABELS,
  COLLABORATOR_KEYS,
  COLLABORATOR_STATUS_LABELS,
  COLLABORATION_MODE_LABELS,
  permissionSentence,
  CONNECTION_KEYS,
  CONNECTION_STATUS_LABELS,
  KNOWLEDGE_KEYS,
  KNOWLEDGE_SECTION_LABELS,
  HELP_CENTER_CONNECTOR_TYPES,
  DOCUMENT_CONNECTOR_TYPES,
  MEMBER_KEYS,
  ROLE_LABELS,
} from './labels';

// ── Connectors: the catalog, the tenant's list, and team bindings ───────

/** The connected apps and the catalog, read together; either failing is the
 *  one `connectors` 503. */
export async function collectConnectors(
  tenantId: string, actorAccountId: string,
): Promise<{ connectors: TenantConnectorSummary[]; catalog: ConnectorCatalogResponse }> {
  let catalog: ConnectorCatalogResponse;
  try {
    catalog = await getCatalog();
  } catch (err) {
    throw new ExportSourceUnavailableError('connectors', err);
  }
  let connectors: TenantConnectorSummary[];
  try {
    connectors = await listConnectorsForTenant(tenantId, actorAccountId);
  } catch (err) {
    throw new ExportSourceUnavailableError('connectors', err);
  }
  return { connectors, catalog };
}

export function catalogDisplayNames(catalog: ConnectorCatalogResponse): Map<string, string> {
  return new Map(catalog.connectors.map((entry) => [entry.type, entry.displayName]));
}

/** enrichIntegrationsWithType's own message for a binding that resolves to
 *  nothing (integration-enrichment.ts:109): an orphan in the team's row, not a
 *  source failing. */
const ORPHAN_BINDING = /^Integration permission has no resolvable type/;

/** The bindings with a type, resolved through enrichIntegrationsWithType.
 *
 *  Whole list first, which is one round trip for the common case. The helper
 *  throws for the whole list when ANY binding is an orphan, so on that message
 *  each binding is resolved on its own and the orphans are left out: a stale
 *  id in one team's row is not a reason to refuse the workspace its export,
 *  and it is not connector-service being down either. Any other failure is. */
async function enrichBindings(tenantId: string, raw: IntegrationPermission[]): Promise<IntegrationPermission[]> {
  try {
    return await enrichIntegrationsWithType(tenantId, raw);
  } catch (err) {
    if (!ORPHAN_BINDING.test((err as Error).message ?? '')) {
      throw new ExportSourceUnavailableError('connectors', err);
    }
  }
  const resolved: IntegrationPermission[] = [];
  for (const binding of raw) {
    try {
      resolved.push(...(await enrichIntegrationsWithType(tenantId, [binding])));
    } catch (err) {
      if (ORPHAN_BINDING.test((err as Error).message ?? '')) continue;
      throw new ExportSourceUnavailableError('connectors', err);
    }
  }
  return resolved;
}

/** Who and what a team works with, by name, in the order the team's bindings
 *  hold them: the catalog display name for a connector binding, the custom MCP
 *  server's own name for one of those, the team's name for an `internal_agent`
 *  binding and the collaborator's for an `external_agent` one. `withCollaborators`
 *  says whether any agent or External Agent is among them, which is
 *  what decides the heading (IntegrationsSelector.tsx:111-113). Resolved through
 *  enrichIntegrationsWithType, which asks connector-service for any binding
 *  that carries no type; that call failing is the `connectors` 503. */
export interface TeamIntegrations {
  names: string[];
  withCollaborators: boolean;
}

export async function resolveTeamIntegrationNames(
  tenantId: string,
  teams: TeamRow[],
  displayNames: ReadonlyMap<string, string>,
  customByConnectorId: ReadonlyMap<string, CustomMcpRow>,
  teamNames: ReadonlyMap<string, string>,
  collaboratorNames: ReadonlyMap<string, string>,
): Promise<Map<string, TeamIntegrations>> {
  const out = new Map<string, TeamIntegrations>();
  for (const team of teams) {
    const raw = Array.isArray(team.integrations) ? (team.integrations as IntegrationPermission[]) : [];
    const enriched = await enrichBindings(tenantId, raw);
    const names: string[] = [];
    let withCollaborators = false;
    const push = (name: string | undefined) => {
      if (name !== undefined && !names.includes(name)) names.push(name);
    };
    for (const integration of enriched) {
      if (integration.type === 'internal_agent') {
        const name = teamNames.get(integration.id);
        if (name !== undefined) { withCollaborators = true; push(name); }
        continue;
      }
      if (integration.type === 'external_agent') {
        const name = collaboratorNames.get(integration.id);
        if (name !== undefined) { withCollaborators = true; push(name); }
        continue;
      }
      if (integration.type === 'custom_mcp_server') {
        push(customByConnectorId.get(integration.id)?.name);
        continue;
      }
      push(integration.type ? displayNames.get(integration.type) : undefined);
    }
    out.set(team.id, { names, withCollaborators });
  }
  return out;
}

// ── ai-teams.json ───────────────────────────────────────────────────────

export interface TeamEntry {
  [TEAM_KEYS.team]: string;
  [TEAM_KEYS.status]?: string;
  [TEAM_KEYS.description]?: string;
  [TEAM_KEYS.responsibilities]?: string;
  /** Exactly one of the two "work with" headings is present, the one the
   *  builder would show for this list (IntegrationsSelector.tsx:111-113). */
  [TEAM_KEYS.integrations]?: string[];
  [TEAM_KEYS.integrationsWithCollaborators]?: string[];
  [TEAM_KEYS.guidance]?: string;
  [TEAM_KEYS.learnedContext]: LearnedContextEntry[];
}

export function projectTeams(
  teams: TeamRow[],
  integrations: ReadonlyMap<string, TeamIntegrations>,
  learnedContext: ReadonlyMap<string, readonly LearnedMemory[]>,
): TeamEntry[] {
  return teams.map((team) => {
    // The card's exact expression (TeamsPage.tsx:242-244): an empty summary
    // falls through to the responsibilities.
    const description = team.summary || team.responsibilities;
    const status = TEAM_STATUS_LABELS[team.status];
    const worksWith = integrations.get(team.id) ?? { names: [], withCollaborators: false };
    const worksWithKey = worksWith.withCollaborators ? TEAM_KEYS.integrationsWithCollaborators : TEAM_KEYS.integrations;
    return {
      [TEAM_KEYS.team]: team.role,
      ...(status !== undefined ? { [TEAM_KEYS.status]: status } : {}),
      ...(description ? { [TEAM_KEYS.description]: description } : {}),
      ...(team.responsibilities ? { [TEAM_KEYS.responsibilities]: team.responsibilities } : {}),
      [worksWithKey]: worksWith.names,
      ...(team.additional_context ? { [TEAM_KEYS.guidance]: team.additional_context } : {}),
      [TEAM_KEYS.learnedContext]: projectLearnedContext(learnedContext.get(team.id) ?? []),
    };
  });
}

// ── external-collaborators.json ─────────────────────────────────────────

export interface CollaboratorCapabilityEntry {
  [COLLABORATOR_KEYS.capabilityName]: string;
  [COLLABORATOR_KEYS.capabilityDescription]?: string;
}

export interface CollaboratorRequestPermissionsEntry {
  [COLLABORATOR_KEYS.team]: string;
  [COLLABORATOR_KEYS.rules]: string[];
}

export interface CollaboratorEntry {
  [COLLABORATOR_KEYS.name]: string;
  [COLLABORATOR_KEYS.status]?: string;
  [COLLABORATOR_KEYS.description]?: string;
  [COLLABORATOR_KEYS.does]?: string;
  [COLLABORATOR_KEYS.capabilities]: CollaboratorCapabilityEntry[];
  [COLLABORATOR_KEYS.worksWith]: string[];
  [COLLABORATOR_KEYS.mode]?: string;
  [COLLABORATOR_KEYS.requestPermissions]: CollaboratorRequestPermissionsEntry[];
}

/** The order the page lays the four pills out in (src/services/externalAgents.ts:29-34). */
const REQUEST_TYPE_ORDER = ['read_summaries', 'run_analysis', 'draft_outputs', 'propose_updates'] as const;

interface StoredCapability { name?: unknown; description?: unknown }
interface StoredRule { internalAgentId?: unknown; internalAgentName?: unknown; permissions?: unknown }

/**
 * One entry per External Agent, as the Update Team page shows it.
 *
 * Team names come from the export's own resolver (a rule's stored
 * `internalAgentName` is the name at the time the rule was saved, and a team
 * can be renamed); a team the tenant no longer knows keeps the stored name,
 * and one with neither is left out. Each rule is the sentence its pill reads
 * as, in the page's order of the four request types; a permission or a type
 * the page has no words for is left out rather than shown as its code.
 */
export function projectCollaborators(
  rows: ExternalCollaboratorRow[],
  teamNames: ReadonlyMap<string, string>,
): CollaboratorEntry[] {
  return rows.map((row) => {
    // The card's expression (TeamsPage.tsx:242-244): description, then the
    // distilled summary.
    const description = row.description || row.summary;
    const status = COLLABORATOR_STATUS_LABELS[row.status];
    const mode = COLLABORATION_MODE_LABELS[row.collaboration_mode];

    const capabilities: CollaboratorCapabilityEntry[] = [];
    for (const cap of Array.isArray(row.detected_capabilities) ? (row.detected_capabilities as StoredCapability[]) : []) {
      if (typeof cap?.name !== 'string' || cap.name.length === 0) continue;
      capabilities.push({
        [COLLABORATOR_KEYS.capabilityName]: cap.name,
        ...(typeof cap.description === 'string' && cap.description ? { [COLLABORATOR_KEYS.capabilityDescription]: cap.description } : {}),
      });
    }

    const worksWith: string[] = [];
    for (const id of row.allowed_internal_agent_ids ?? []) {
      const name = teamNames.get(id);
      if (name !== undefined && !worksWith.includes(name)) worksWith.push(name);
    }

    const requestPermissions: CollaboratorRequestPermissionsEntry[] = [];
    for (const rule of Array.isArray(row.request_rules) ? (row.request_rules as StoredRule[]) : []) {
      const team = (typeof rule?.internalAgentId === 'string' ? teamNames.get(rule.internalAgentId) : undefined)
        ?? (typeof rule?.internalAgentName === 'string' && rule.internalAgentName ? rule.internalAgentName : undefined);
      if (team === undefined) continue;
      const permissions = (rule.permissions ?? {}) as Record<string, unknown>;
      const rules: string[] = [];
      for (const type of REQUEST_TYPE_ORDER) {
        const permission = permissions[type];
        const sentence = typeof permission === 'string' ? permissionSentence(permission, type) : undefined;
        if (sentence !== undefined) rules.push(sentence);
      }
      requestPermissions.push({ [COLLABORATOR_KEYS.team]: team, [COLLABORATOR_KEYS.rules]: rules });
    }

    return {
      [COLLABORATOR_KEYS.name]: row.name,
      ...(status !== undefined ? { [COLLABORATOR_KEYS.status]: status } : {}),
      ...(description ? { [COLLABORATOR_KEYS.description]: description } : {}),
      ...(row.description ? { [COLLABORATOR_KEYS.does]: row.description } : {}),
      [COLLABORATOR_KEYS.capabilities]: capabilities,
      [COLLABORATOR_KEYS.worksWith]: worksWith,
      ...(mode !== undefined ? { [COLLABORATOR_KEYS.mode]: mode } : {}),
      [COLLABORATOR_KEYS.requestPermissions]: requestPermissions,
    };
  });
}

// ── knowledge.json ──────────────────────────────────────────────────────

export interface KnowledgeEntry {
  [KNOWLEDGE_KEYS.title]: string;
  [KNOWLEDGE_KEYS.link]?: string;
  [KNOWLEDGE_KEYS.source]?: string;
  [KNOWLEDGE_KEYS.section]?: string;
  [KNOWLEDGE_KEYS.added]: string;
}

export function projectKnowledge(rows: KnowledgeRow[], displayNames: ReadonlyMap<string, string>): KnowledgeEntry[] {
  return rows.map((row) => {
    const source = row.connector_type ? displayNames.get(row.connector_type) : undefined;
    const section = row.connector_type && HELP_CENTER_CONNECTOR_TYPES.has(row.connector_type)
      ? KNOWLEDGE_SECTION_LABELS.help_center
      : row.connector_type && DOCUMENT_CONNECTOR_TYPES.has(row.connector_type)
        ? KNOWLEDGE_SECTION_LABELS.document
        : undefined;
    return {
      [KNOWLEDGE_KEYS.title]: row.title,
      ...(row.source_url ? { [KNOWLEDGE_KEYS.link]: row.source_url } : {}),
      ...(source !== undefined ? { [KNOWLEDGE_KEYS.source]: source } : {}),
      ...(section !== undefined ? { [KNOWLEDGE_KEYS.section]: section } : {}),
      [KNOWLEDGE_KEYS.added]: row.created_at.toISOString(),
    };
  });
}

// ── connections.json ────────────────────────────────────────────────────

export interface ConnectionEntry {
  [CONNECTION_KEYS.app]: string;
  [CONNECTION_KEYS.status]: string;
  [CONNECTION_KEYS.mcpEndpointUrl]?: string;
}

/** The page's Connected section: `status IN ('active','error')`
 *  (useIntegrations.ts:73) plus `pending` with `installState =
 *  'awaiting_org_approval'` (:125), created at or before asOf. Custom MCP
 *  servers are joined INTO this list by connector id, never a second list. */
export function projectConnections(
  connectors: TenantConnectorSummary[],
  displayNames: ReadonlyMap<string, string>,
  customByConnectorId: ReadonlyMap<string, CustomMcpRow>,
  asOf: Date,
): ConnectionEntry[] {
  // connector-service lists newest first; every array in the archive sorts
  // by created time ascending, then id.
  const included = connectors
    .filter((c) => {
      if (c.createdAt !== null && new Date(c.createdAt).getTime() > asOf.getTime()) return false;
      if (c.status === 'active' || c.status === 'error') return true;
      return c.status === 'pending' && c.installState === 'awaiting_org_approval';
    })
    .sort((a, b) => {
      const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return at - bt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
  const entries: ConnectionEntry[] = [];
  for (const c of included) {
    const displayName = c.type ? displayNames.get(c.type) : undefined;
    // A type the catalog does not carry is omitted, exactly as the page omits
    // it (useIntegrations.ts:84); the row's own name is never used for a
    // catalog type, since those names carry autogenerated uniqueness suffixes
    // the page is written never to surface (:90-96).
    if (displayName === undefined) continue;
    const status = c.status === 'error'
      ? CONNECTION_STATUS_LABELS.needsReconnect
      : c.status === 'pending'
        ? CONNECTION_STATUS_LABELS.awaitingApproval
        : CONNECTION_STATUS_LABELS.connected;
    if (c.type === 'custom_mcp_server') {
      // The sole exception: a custom server's row name IS the user-chosen
      // identity, and the form's "MCP endpoint URL" rides with it.
      const custom = customByConnectorId.get(c.id);
      entries.push({
        [CONNECTION_KEYS.app]: custom?.name ?? c.name ?? displayName,
        [CONNECTION_KEYS.status]: status,
        ...(custom ? { [CONNECTION_KEYS.mcpEndpointUrl]: custom.endpoint_url } : {}),
      });
      continue;
    }
    entries.push({ [CONNECTION_KEYS.app]: displayName, [CONNECTION_KEYS.status]: status });
  }
  return entries;
}

// ── members.json ────────────────────────────────────────────────────────

export interface MemberEntry {
  [MEMBER_KEYS.name]?: string;
  [MEMBER_KEYS.email]: string;
  [MEMBER_KEYS.role]: string;
  [MEMBER_KEYS.joined]?: string;
  [MEMBER_KEYS.worksWith]?: string[];
}

export interface InvitationEntry {
  [MEMBER_KEYS.email]: string;
  [MEMBER_KEYS.role]: string;
  [MEMBER_KEYS.invited]?: string;
}

/** SettingsPage.tsx:281's own expression for a role not in the pinned map. */
function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role.charAt(0).toUpperCase() + role.slice(1);
}

export function projectMembers(members: MemberRow[], assignments: AssignmentRow[]): MemberEntry[] {
  const worksWith = new Map<string, string[]>();
  for (const a of assignments) {
    if (!a.agent_name) continue;
    const list = worksWith.get(a.account_id) ?? [];
    if (!list.includes(a.agent_name)) list.push(a.agent_name);
    worksWith.set(a.account_id, list);
  }
  return members.map((m) => {
    const name = `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim();
    const teams = worksWith.get(m.account_id);
    return {
      ...(name ? { [MEMBER_KEYS.name]: name } : {}),
      [MEMBER_KEYS.email]: m.email,
      [MEMBER_KEYS.role]: roleLabel(m.role),
      ...(m.joined_at ? { [MEMBER_KEYS.joined]: m.joined_at.toISOString() } : {}),
      ...(teams && teams.length > 0 ? { [MEMBER_KEYS.worksWith]: teams } : {}),
    };
  });
}

export function projectInvitations(rows: InvitationRow[]): InvitationEntry[] {
  return rows.map((row) => ({
    [MEMBER_KEYS.email]: row.email,
    [MEMBER_KEYS.role]: roleLabel(row.role),
    ...(row.created_at ? { [MEMBER_KEYS.invited]: row.created_at.toISOString() } : {}),
  }));
}
