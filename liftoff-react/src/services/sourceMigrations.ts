// Liftoff Switch — migration API client.
//
// The wizard reads its position from the migration record and nowhere else. It
// never touches onboarding state: the two flows are composable precisely
// because each has exactly one resume authority.

import { api } from './api'

export type MigrationSource = 'openclaw' | 'hermes' | 'claude-code' | 'codex'

export type MigrationState =
  | 'importing'
  | 'setup_required'
  | 'payment_required'
  | 'conversion_queued'
  | 'converting'
  | 'conversion_ready'
  | 'ready_to_cutover'
  | 'active'
  | 'failed'

export type MigrationItemState = 'pending' | 'distilling' | 'creating' | 'converted' | 'failed'

export interface MigrationRequirement {
  kind: 'credential' | 'collaboration' | 'consent' | 'payment' | 'hosting' | 'selection'
  detail: string
  resolvePath?: string
}

export interface MigrationItemView {
  sourceRef: string
  role: string
  state: MigrationItemState
  /** How this team member runs. A schedule is the member's trigger, not a
   *  separate object beside it — Liftoff models exactly one per member. */
  cronExpr?: string
  destinationAgentId?: string
  lastError?: string
}

export interface MigrationUnsupportedItem {
  sourceRef: string
  reason: string
  detail: string
  sourcePath?: string
}

export interface MigrationHostingRequirement {
  sourceRef: string
  name: string
  command?: string
  args?: string[]
  url?: string
  reason: 'stdio_mcp_requires_hosting' | 'unreachable_mcp_endpoint'
}

export interface MigrationRoutineView {
  sourceRef: string
  name: string
  cronExpr: string
  accepted: boolean
  enabledInSource: boolean
  firstRunStatus: 'awaiting' | 'succeeded' | 'failed'
  firstRunErrorCategory?: string
}

export interface MigrationConnectionView {
  sourceRef: string
  kind: 'catalog' | 'mcp_http'
  connectorType: string
  displayName?: string
  endpointUrl?: string
  authScheme?: string
  connectorId?: string
  status: 'placeholder_pending' | 'needs_reconnect' | 'active' | 'dismissed'
}

export interface MigrationView {
  id: string
  source: MigrationSource
  state: MigrationState
  itemCount: number
  convertedCount: number
  unsupportedCount: number
  items: MigrationItemView[]
  requirements: MigrationRequirement[]
  webPath: string
  onboardingComplete: boolean
  // Always present: the backend builds the whole view in one read, so the
  // wizard never has to guard against a half-populated migration.
  unsupportedItems: MigrationUnsupportedItem[]
  hostingRequirements: MigrationHostingRequirement[]
  routines: MigrationRoutineView[]
  connections: MigrationConnectionView[]
  /** Workspace-scoped material offered for the shared knowledge library, and
   *  what the user has approved so far. Consent follows scope. */
  consentCandidates: string[]
  libraryApprovals: string[]
  /** Source-specific pause reference text. Shown as a reminder, never as a step
   *  Liftoff verifies or gates on. */
  pauseGuidance: { command?: string; steps: string[]; supervisedNote?: string }
}

/** The migration currently open for this workspace and source, if any. */
export async function getLatestMigration(
  tenantId: string,
  source: MigrationSource,
): Promise<MigrationView | null> {
  const res = await api.get<{ migration: MigrationView | null }>(
    `/api/source-migrations/latest?tenantId=${encodeURIComponent(tenantId)}&source=${source}`,
  )
  return res.migration
}

export async function getMigration(id: string, tenantId: string): Promise<MigrationView> {
  return await api.get<MigrationView>(
    `/api/source-migrations/${id}?tenantId=${encodeURIComponent(tenantId)}`,
  )
}

/** Start conversion. The backend re-reads the billing authority itself; the
 *  browser never asserts that the workspace has paid. */
export async function convertMigration(
  id: string,
  tenantId: string,
  /** Retry just these team members. Omitted, everything outstanding runs. */
  sourceRefs?: string[],
): Promise<MigrationView> {
  return await api.post<MigrationView>(`/api/source-migrations/${id}/convert`, {
    tenantId,
    ...(sourceRefs?.length ? { sourceRefs } : {}),
  })
}

/** Activate the imported team. Requires the explicit confirmation flag: the
 *  wizard only sends it from the cutover screen. */
export async function activateMigration(id: string, tenantId: string): Promise<MigrationView> {
  return await api.post<MigrationView>(`/api/source-migrations/${id}/activate`, {
    tenantId,
    confirmed: true,
  })
}

export async function setRoutineAccepted(
  id: string,
  tenantId: string,
  sourceRef: string,
  accepted: boolean,
): Promise<void> {
  await api.post(`/api/source-migrations/${id}/routines/accept`, { tenantId, sourceRef, accepted })
}

/** Consent for workspace-scoped material. Agent-scoped context lands without
 *  this; the knowledge library and workspace memories do not. */
export async function setConsent(
  id: string,
  tenantId: string,
  approvedArtifactNames: string[],
): Promise<void> {
  await api.post(`/api/source-migrations/${id}/consent`, { tenantId, approvedArtifactNames })
}

export interface CompleteMcpImportInput {
  authType: 'none' | 'api_key' | 'bearer' | 'custom_headers'
  apiKey?: string
  bearerToken?: string
  customHeaders?: Array<{ name: string; value: string }>
  endpointUrl?: string
  tunnelRouteId?: string
  confirmedUnauthenticated?: boolean
}

export async function completeMcpImport(
  id: string,
  connectorId: string,
  tenantId: string,
  input: CompleteMcpImportInput,
): Promise<{ connectorId: string; toolCount: number }> {
  return await api.post<{ connectorId: string; toolCount: number }>(
    `/api/source-migrations/${id}/connections/${connectorId}/complete-import`,
    { tenantId, ...input },
  )
}

/** Which wizard stage a migration state belongs to. Mirrors the backend's
 *  webPath so a deep link and a fresh load agree. */
export function stageForState(state: MigrationState): string {
  switch (state) {
    // Everything before the build is one screen: what we found, what needs
    // reconnecting, and the choices about scheduled work and sharing.
    case 'importing':
    case 'setup_required':
    case 'payment_required':
    case 'failed':
      return 'review'
    case 'conversion_queued':
    case 'converting':
      return 'building'
    // Built and waiting. The wizard stops here: starting a team member is the
    // user's decision, and a draft already shows "Start Team" in Teams.
    case 'conversion_ready':
    case 'ready_to_cutover':
    case 'active':
      return 'done'
    default:
      return 'review'
  }
}

export const SOURCE_LABELS: Record<MigrationSource, string> = {
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
  'claude-code': 'Claude Code',
  codex: 'Codex',
}
