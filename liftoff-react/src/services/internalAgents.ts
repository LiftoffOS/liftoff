// Internal Agents Service
// Manages internal agent (Agent) configurations with the backend

import type { MediaRef } from '../types/media'
import { api, ApiError } from './api'
import { auth } from '../config/firebase'
import type { AutonomyLevel } from './oversight'
import type { CollaborationMode } from './externalAgents'
import type { WorkspaceAiVendor } from './tenants'

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080'

// Internal Agent status types
export type InternalAgentStatus = 'draft' | 'active' | 'paused'

// Get the appropriate action label for an internal agent based on its status
// Note: User-facing labels use "Team" for consistency with UI terminology
export function getInternalAgentActionLabel(status: InternalAgentStatus): string {
  switch (status) {
    case 'draft':
      return 'Start Team'
    case 'paused':
      return 'Resume Team'
    default:
      return 'Pause Team'
  }
}

// Integration permission - stored with internal agent, used for runtime enforcement
// Empty selectedObjects array means full access to all objects
export interface IntegrationPermission {
  id: string
  integrationId?: string
  selectedObjects: string[]
  collaborationMode?: CollaborationMode
  /**
   * Per-connector-type binding config. For Gmail today:
   *   { gmailQuery?: string, sendAs?: string }
   */
  config?: Record<string, unknown>
}

// Internal Agent data model (matches backend)
export interface InternalAgent {
  id: string
  role: string
  responsibilities: string
  integrations: IntegrationPermission[]
  additionalContext?: string
  summary: string | null
  // systemPrompt / userInstructions / instructionsMd are not on this model.
  // The server stopped serializing them: they are the compiled agent, no screen
  // has ever displayed them, and returning them meant the list route handed
  // over every agent's prompt in a single call. The inputs they were compiled
  // from (role, responsibilities, additionalContext) are still here, which is
  // what the update page edits.
  temperature: number
  status: InternalAgentStatus
  currentVersion: number
  tasksCompleted: number
  tasks30d: number
  monthlyCost: number
  createdAt: string
  updatedAt: string
  lastActive: string | null
  messagingNickname: string | null
  lastActivity: string | null
  lastActivityAction: string | null
  workflowVisualizationSteps: WorkflowVisualizationStep[] | null
  autonomyOverride: AutonomyLevel | null
  /** Per-AI-team AI provider. Three distinct states, and 'default' is NOT a
   *  synonym for inherit:
   *    null        inherit — follow the workspace, including future changes
   *    'default'   pinned to Liftoff Managed for this team, whatever the
   *                workspace is set to
   *    <vendor>    pinned to that vendor */
  aiVendorOverride: WorkspaceAiVendor | null
  attachments?: TeamAttachment[]
}

export interface WorkflowVisualizationForkPath { condition: string; steps: WorkflowVisualizationStep[] }
export interface WorkflowVisualizationStep { id: string; label: string; fork?: { paths: WorkflowVisualizationForkPath[] } }

// Version source indicates how the version was created
export type VersionSource = 'create' | 'distill' | 'manual'

// Internal Agent version - snapshot of configuration at a point in time
export interface InternalAgentVersion {
  id: string
  internalAgentId: string
  version: number
  role: string
  responsibilities: string | null
  integrations: IntegrationPermission[]
  additionalContext: string | null
  // Same omission as InternalAgent, and it mattered more here: this endpoint
  // returns every version at once, so it handed over an agent's entire
  // prompt-evolution history in one response. RollbackModal only ever read
  // `version` and `createdAt`.
  source: VersionSource
  createdBy: string | null
  createdAt: string
}

// Team attachments — build-time inputs imported on the team-build/update pages.
// Explicitly NOT knowledge items: they live on the agent, feed the distill step,
// and are resolved server-side (connector refs) via the existing extraction
// machinery. `source` records which input's popover added the file so cards
// rehydrate under the right input on the update page.
export interface UploadAttachment {
  kind: 'upload'
  name: string
  content: string
  addedAt: string
  source: 'responsibilities' | 'guidance'
}

export interface ConnectorAttachment {
  kind: 'connector'
  name: string
  connectorId: string
  connectorType: string
  externalId: string
  sourceUrl?: string
  addedAt: string
  source: 'responsibilities' | 'guidance'
}

/**
 * A picture, clip or recording attached to a chat message.
 *
 * A THIRD kind rather than a widening of `UploadAttachment`, because `content`
 * is read unconditionally everywhere an upload is handled — making it
 * conditionally absent would turn a compile-time certainty into a runtime one
 * in code that has no reason to check for it.
 *
 * The bytes are not here and never travel on a chat request. They were uploaded
 * out of band (see services/chatMedia.ts) and this carries the same `MediaRef`
 * the outbound path already puts on a message row, so one renderer draws media
 * whichever direction it came from.
 *
 * Chat only. It has no `source`, because the agent-builder inputs that stamp one
 * take documents to distill from, not pictures.
 */
export interface MediaAttachment {
  kind: 'media'
  /** The person's own file name, as the chip shows it. `media.filename` is the
   *  STORED name and carries a version suffix, so the two differ. */
  name: string
  media: MediaRef
  addedAt: string
}

export type TeamAttachment = UploadAttachment | ConnectorAttachment

/** A team attachment before the parent input stamps its `source`. Used for both
 *  agent-builder attachments and chat-message attachments (the latter omits
 *  `source` permanently since chat has no such concept). */
export type PendingAttachment =
  | Omit<UploadAttachment, 'source'>
  | Omit<ConnectorAttachment, 'source'>
  | MediaAttachment

/** A pending attachment with a synthetic client-side id for removal via pill UI.
 *  The id is never sent over the wire. */
export type DisplayAttachment = PendingAttachment & { id: string }

// Input types for mutations
export interface CreateInternalAgentInput {
  role: string
  responsibilities: string
  integrations: IntegrationPermission[]
  additionalContext?: string
  summary?: string
  /** The template this was hired from. Stored with a hash of the authored text,
   *  so a later redistill seeds from the template again only while the agent
   *  still says what the template said. */
  templateId?: string
  /** This hire's prose was already rewritten before it was created, so the
   *  text above is the person's rather than the template's.
   *
   *  The server fingerprints the text IT RECEIVES and stores that as the
   *  provenance baseline (`templateSourceHash`, migration 378). That is correct
   *  while the only way to reach create is with the catalog's text verbatim,
   *  which was true until the explore detail step became editable: now the
   *  baseline would be taken over the EDIT, hash equal to itself forever, and
   *  `templateIdForRedistill` would keep handing back the template id — so the
   *  first redistill would re-seed from our catalog and drag their wording
   *  toward ours, silently. Setting this tells the server to record no
   *  baseline, which is what "this text is theirs" already means everywhere
   *  else. `templateIdForObligations` is deliberately not affected: the
   *  template's structural guarantees survive an edit.
   *
   *  REQUIRES the matching platform-backend change; until that ships the field
   *  is accepted and ignored, and an edited hire behaves as it does today. */
  templateTextEdited?: boolean
  /** Handle for the distillation this agent is built from. The server redeems
   *  it and takes the compiled prompt, skills, capability tier and result rules
   *  from the stored artifact, so none of those travel in this payload. */
  distillId?: string
  status?: InternalAgentStatus
  agentType?: 'agent' | 'workflow'
  workflowSteps?: WorkflowStepInput[]
  triggerConfig?: TriggerConfig
  attachments?: TeamAttachment[]
  /** Absorption routing from the distill response, plus the artifact names the
   *  person approved for the shared knowledge library (P1.1). Anything not
   *  named in `libraryApprovals` is never added to the library. */
  absorption?: ArtifactClassification[]
  libraryApprovals?: string[]
}

export interface UpdateInternalAgentInput {
  role?: string
  responsibilities?: string
  integrations?: IntegrationPermission[]
  additionalContext?: string
  summary?: string
  temperature?: number
  messagingNickname?: string
  skills?: AgentSkill[]
  autonomyOverride?: AutonomyLevel | null
  /** null clears the override and returns this agent to the workspace choice,
   *  so it must be sent rather than stripped. */
  aiVendorOverride?: WorkspaceAiVendor | null
  attachments?: TeamAttachment[]
  absorption?: ArtifactClassification[]
  libraryApprovals?: string[]
  /** This update carries a fresh distillation. The server records the version
   *  as a distill instead of a hand edit, so the history shows whether the
   *  compiled prompt and skills were regenerated from the prose. */
  distilled?: boolean
  /** Handle for that distillation. Where `distilled` above is an assertion the
   *  server cannot check, presenting a handle proves one actually ran, and the
   *  server sources the regenerated fields from it. */
  distillId?: string
}

// Distill types - for LLM-generated internal agent configuration
export interface IntegrationInfo {
  id: string
  name: string
  type: string
  selectedObjects: string[]  // Objects the user specifically selected
}

export interface DistillInput {
  role: string
  responsibilities: string
  integrations: IntegrationInfo[]
  additionalContext?: string | null
  templateId?: string
  attachments?: TeamAttachment[]
  /** Answers to the inputs the template declared, keyed by input id. Present
   *  only for templates that declare inputs, and only for ones answered. */
  templateInputs?: Record<string, string>
  /** Destinations named in the pickers, keyed by template object id. The
   *  backend substitutes them into the prose wherever `{{pick:<id>}}` appears,
   *  which is how a destination reaches the team's own instructions. */
  templatePicks?: Record<string, { id: string; title: string; kind?: 'folder' | 'file' }>
  /** Which production strategy the backend should use.
   *
   *  Absent means the default single call. `waved` runs the six-branch split
   *  and is refused outside dev by the server, so a stale value cannot change
   *  behaviour for a paying workspace. Travels as a query parameter rather
   *  than in the body because the server reads it before parsing the input. */
  strategy?: 'single' | 'waved'
}

export interface CompanionCron {
  label: string
  cronExpr: string
  timezone?: string
  objective?: string
}

export type SubscriptionSource =
  | { kind: 'connector_event'; connectorRef: string; entityType?: string }
  | { kind: 'system_event'; topic: string }
  | { kind: 'computed_metric'; connectorRef: string; fn: string; args?: Record<string, unknown>; pollIntervalSeconds: number; extractPath?: string }

export type PredicateExpr =
  | { op: 'and' | 'or'; operands: PredicateExpr[] }
  | { op: 'not'; operand: PredicateExpr }
  | { op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'; path: string; value: string | number | boolean }
  | { op: 'in' | 'nin'; path: string; values: Array<string | number> }
  | { op: 'exists' | 'not_exists'; path: string }
  | { op: 'changed_to'; path: string; value: string | number }
  | { op: 'matches'; path: string; pattern: string }

export interface WindowSpec {
  aggregate: 'count' | 'sum' | 'avg' | 'rate' | 'min' | 'max'
  field?: string
  durationSeconds: number
  threshold: { comparator: 'gt' | 'gte' | 'lt' | 'lte'; value: number }
}

export interface ReactiveSubscription {
  label: string
  source: SubscriptionSource
  filter?: PredicateExpr
  window?: WindowSpec
  cooldownSeconds?: number
  objective: string
}

export interface TriggerConfig {
  type: 'cron' | 'event' | 'manual'
  cronExpr?: string
  eventTopic?: string
  timezone?: string
  /** @deprecated retained for back-compat; use companionCrons instead */
  companionCron?: { cronExpr: string; timezone?: string }
  companionCrons?: CompanionCron[]
  reactiveSubscriptions?: ReactiveSubscription[]
}

export interface WorkflowStepInput {
  stepId: string
  description: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolInputTemplate?: string
  outputField?: string
  condition?: string
  onSuccess?: string
  onFailure?: string
  requiresApproval?: boolean
}

/**
 * Per-integration config emitted by the distillation LLM, keyed by the
 * integration id the user supplied in the catalog.
 *   - Gmail   (type=google_mail):            { gmailQuery?, sendAs? }
 *   - Outlook (type=microsoft_outlook_mail): { outlookFilter?, sendAs? }
 * The caller merges these onto each SelectedIntegration's `config` field
 * before the agent is saved.
 */
export type DistillIntegrationConfigs = Record<
  string,
  { gmailQuery?: string; outlookFilter?: string; sendAs?: string }
>

/** Where absorption routed an imported file (P1.1). Instruction- and
 *  routine-shaped files shape the configuration through distillation; skills,
 *  memories, and reference documents go to their own homes instead. */
export type AbsorptionCategory =
  | 'instructions'
  | 'routine'
  | 'skill'
  | 'memory'
  | 'reference'

export interface ArtifactClassification {
  name: string
  category: AbsorptionCategory
  skills?: Array<{ name: string; description: string; instruction: string; tags?: string[] }>
  memories?: Array<{ content: string; scope: 'individual' | 'workspace' }>
  referenceTitle?: string
}

// Hybrid execution engine: workflowSteps is optional on both members so
// existing rows in the DB that return agentType='workflow' continue to type-
// narrow correctly. A follow-up PR collapses to a single 'agent' member after
// the workspace re-backfill is complete.
// `systemPrompt`, `userInstructions` and `instructionsMd` are deliberately
// absent. The distiller still produces them; the server now keeps them and
// hands back `distillId` instead, which create/update present to redeem. The
// browser used to receive all three, park them in component state, and POST
// them back so the server could persist what it had just generated — a round
// trip that put the compiled agent on the wire twice, made `systemPrompt`
// client-supplied, and dropped `skills`/`capabilityTier`/`resultRules` on the
// way back because no create payload declared them. Nothing ever rendered
// them, so nothing on screen depends on their absence.
export type DistillOutput =
  | {
      agentType: 'agent';
      distillId: string;
      summary: string;
      triggerConfig?: TriggerConfig;
      skills?: AgentSkill[];
      workflowSteps?: WorkflowStepInput[];
      workflowVisualizationSteps?: WorkflowVisualizationStep[] | null;
      integrationConfigs?: DistillIntegrationConfigs;
      absorption?: ArtifactClassification[];
    }
  | {
      agentType: 'workflow';
      distillId: string;
      summary: string;
      triggerConfig?: TriggerConfig;
      workflowSteps?: WorkflowStepInput[];
      skills?: AgentSkill[];
      workflowVisualizationSteps?: WorkflowVisualizationStep[] | null;
      integrationConfigs?: DistillIntegrationConfigs;
      absorption?: ArtifactClassification[];
    }

// Progress stages for streaming SSE updates
export type DistillStage =
  | 'connected'
  | 'validating'
  // Sorting imported files into their homes. Only emitted when the build
  // carries attachments.
  | 'absorbing'
  | 'analyzing'
  // Gathering the connectors and tools the team will be given. Emitted
  // immediately after `analyzing` (platform-backend distill-service.ts). This
  // union was missing it, and the cast below hands whatever arrives straight
  // to consumers, so it reached the UI as an unmapped stage.
  | 'fetching_tools'
  | 'generating'
  | 'finalizing'

export interface DistillStreamCallbacks {
  onProgress: (stage: DistillStage) => void
  onComplete: (result: DistillOutput) => void
  onError: (error: { message: string; errorCode?: string }) => void
  /** The summary landed, ahead of the rest of the artifact.
   *
   *  Only the waved strategy emits this. It is the one field the confirmation
   *  screen renders, so it is what lets that screen appear in seconds instead
   *  of waiting on prose nobody reads there. */
  onSummaryReady?: (summary: string) => void
  /** The workflow graph and trigger landed. Emitted for progress; the create
   *  payload is what actually depends on these. */
  onGraphReady?: (data: { workflowSteps: unknown; triggerConfig: unknown }) => void
  /** Generation finished, before the artifact is persisted.
   *
   *  Distinct from onComplete: between the two the server writes the artifact
   *  and mints the `distillId`, and that write can fail. This is the signal that
   *  nothing is still being generated — it closes the window the summary opened
   *  — while onComplete is the signal the result can actually be used. */
  onArtifactComplete?: (data: { agentType: string; summary: string; hasWorkflowSteps: boolean }) => void
}

// ─── Fused onboarding — REMOVED (ADR-050) ─────────────────────────────
// PreviewLiteRequest/PreviewLiteResponse and the three client functions that
// used them are gone with the in-onboarding hire. Their endpoints no longer
// exist server-side, so keeping the callers would have been a dead client
// pointed at a 404.


// Paginated response (BE-001)
export interface PaginatedInternalAgentsResponse {
  internalAgents: InternalAgent[]
  cursor: string | null
  hasMore: boolean
  total: number
}

// List internal agents with pagination support (BE-001)
export async function listInternalAgents(
  tenantId: string,
  options?: { cursor?: string; limit?: number; status?: InternalAgentStatus }
): Promise<PaginatedInternalAgentsResponse> {
  const params = new URLSearchParams({ tenantId })

  if (options?.cursor) {
    params.append('cursor', options.cursor)
  }
  if (options?.limit) {
    params.append('limit', options.limit.toString())
  }
  if (options?.status) {
    params.append('status', options.status)
  }

  return await api.get<PaginatedInternalAgentsResponse>(`/api/internal-agents?${params.toString()}`)
}

// Create a new internal agent with idempotency key (DE-001)
export async function createInternalAgent(
  tenantId: string,
  data: CreateInternalAgentInput,
  idempotencyKey: string
): Promise<InternalAgent> {
  return await api.post<InternalAgent>(`/api/internal-agents?tenantId=${tenantId}`, data, {
    headers: { 'Idempotency-Key': idempotencyKey },
  })
}

// Get a single internal agent by ID
export async function getInternalAgent(internalAgentId: string, tenantId: string): Promise<InternalAgent> {
  return await api.get<InternalAgent>(`/api/internal-agents/${internalAgentId}?tenantId=${tenantId}`)
}

// Update an internal agent
export async function updateInternalAgent(
  internalAgentId: string,
  tenantId: string,
  data: UpdateInternalAgentInput
): Promise<InternalAgent> {
  return await api.put<InternalAgent>(`/api/internal-agents/${internalAgentId}?tenantId=${tenantId}`, data)
}

// Update internal agent status (activate/pause)
export async function updateInternalAgentStatus(
  internalAgentId: string,
  tenantId: string,
  status: InternalAgentStatus
): Promise<InternalAgent> {
  return await api.patch<InternalAgent>(`/api/internal-agents/${internalAgentId}/status?tenantId=${tenantId}`, { status })
}

// Delete an internal agent (soft delete on backend - DE-003)
export async function deleteInternalAgent(internalAgentId: string, tenantId: string): Promise<void> {
  await api.delete(`/api/internal-agents/${internalAgentId}?tenantId=${tenantId}`)
}

// Generate a short department slug from role + context via LLM
export async function getDepartmentSlug(
  role: string,
  responsibilities?: string,
  additionalContext?: string,
): Promise<string> {
  const result = await api.post<{ slug: string }>(
    '/api/internal-agents/department-slug',
    { role, responsibilities, additionalContext },
  )
  return result.slug
}

// Check if a messaging nickname is available within the tenant
export async function checkNicknameAvailability(
  tenantId: string,
  nickname: string,
  excludeId?: string,
): Promise<{ available: boolean; conflictWith?: string }> {
  const params = new URLSearchParams({ tenantId, nickname })
  if (excludeId) params.set('excludeId', excludeId)
  return await api.get<{ available: boolean; conflictWith?: string }>(
    `/api/internal-agents/check-nickname?${params.toString()}`,
  )
}

// Distill internal agent configuration using LLM
export async function distillInternalAgent(
  tenantId: string,
  input: DistillInput
): Promise<DistillOutput> {
  return await api.post<DistillOutput>(`/api/internal-agents/distill?tenantId=${tenantId}`, input)
}

// Distill internal agent configuration with SSE streaming for progress updates
/** True for the DOMException fetch raises when its signal is aborted. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * @param signal Aborting it closes the stream and silences every callback,
 *   including onError: a distillation the person walked away from has not
 *   failed, and reporting it as a failure would flash "Something went wrong"
 *   onto the screen they just moved to. Leaving this out keeps the old
 *   behaviour, where the stream runs to completion no matter what the UI does.
 */
export async function distillInternalAgentStream(
  tenantId: string,
  input: DistillInput,
  callbacks: DistillStreamCallbacks,
  signal?: AbortSignal
): Promise<void> {
  let response: Response
  try {
    const token = await auth.currentUser?.getIdToken()

    response = await fetch(
      `${API_BASE_URL}/api/internal-agents/distill-stream?tenantId=${tenantId}${input.strategy ? `&strategy=${input.strategy}` : ''}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token && { Authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(input),
        signal,
      }
    )
  } catch (error) {
    // Previously uncaught. Callers do not await this function, so a failure
    // opening the stream (offline, DNS, a rejected token) surfaced as an
    // unhandled rejection and left the loading screen spinning forever
    // instead of showing its retry.
    if (!isAbort(error)) {
      callbacks.onError({
        message: error instanceof Error ? error.message : 'Stream request failed',
      })
    }
    return
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Stream request failed' }))
    callbacks.onError({ message: error.message || `HTTP ${response.status}`, errorCode: error.errorCode })
    return
  }

  const reader = response.body?.getReader()
  const decoder = new TextDecoder()

  if (!reader) {
    callbacks.onError({ message: 'No response body' })
    return
  }

  let buffer = ''
  let currentEvent = '' // Persists across chunks for large payloads

  // Whether a terminal event (complete or error) has reached the caller.
  //
  // Tracked because the loop below can end without one. A dropped connection,
  // a proxy idle timeout, or a backend that dies mid-generation all surface
  // here as `done: true` on a stream that never said how it finished, and the
  // original code simply returned. Every caller is a screen that shows
  // progress until it is told otherwise, so that silence was an unbounded
  // wait: the distillation looked like it was still running, forever.
  let delivered = false

  const handleLine = (line: string) => {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7)
      return
    }
    if (!line.startsWith('data: ') || !currentEvent) return

    try {
      const data = JSON.parse(line.slice(6))

      if (currentEvent === 'progress') {
        // Skip malformed progress events silently
        if (data.stage) callbacks.onProgress(data.stage as DistillStage)
      } else if (currentEvent === 'complete') {
        // Guards on distillId, not systemPrompt: the prompt no longer crosses
        // the wire, and the handle is now the field without which the result
        // cannot be used to create anything.
        if (!data.agentType || !data.summary || !data.distillId) {
          delivered = true
          callbacks.onError({ message: 'Invalid distill response: missing required fields' })
          return
        }
        delivered = true
        callbacks.onComplete(data as DistillOutput)
      } else if (currentEvent === 'summary_ready') {
        // Guarded rather than forwarded blind: this event is what promotes the
        // UI off the loading screen, so an empty one would strand the person
        // on a confirmation screen with nothing on it.
        if (typeof data.summary === 'string' && data.summary.trim()) {
          callbacks.onSummaryReady?.(data.summary)
        }
      } else if (currentEvent === 'artifact_complete') {
        callbacks.onArtifactComplete?.({
          agentType: String(data.agentType ?? ''),
          summary: String(data.summary ?? ''),
          hasWorkflowSteps: Boolean(data.hasWorkflowSteps),
        })
      } else if (currentEvent === 'graph_ready') {
        callbacks.onGraphReady?.({
          workflowSteps: data.workflowSteps ?? null,
          triggerConfig: data.triggerConfig ?? null,
        })
      } else if (currentEvent === 'error') {
        delivered = true
        callbacks.onError({ message: data.message, errorCode: data.errorCode })
      }
    } catch {
      // Ignore JSON parse errors for malformed events
    }
    currentEvent = ''
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // Parse SSE events from buffer
      const lines = buffer.split('\n')
      buffer = lines.pop() || '' // Keep incomplete line in buffer

      for (const line of lines) handleLine(line)
      if (delivered) return
    }

    // The stream ended. Anything still in the buffer is a line that never got
    // its trailing newline, which is what a final event looks like when the
    // connection closes immediately after it.
    if (buffer) handleLine(buffer)

    if (!delivered && !signal?.aborted) {
      callbacks.onError({
        message: 'The connection closed before the build finished. Please try again.',
      })
    }
  } catch (error) {
    if (isAbort(error)) return
    callbacks.onError({ message: error instanceof Error ? error.message : 'Stream read failed' })
  }
}

// Get all versions for an internal agent
export async function getInternalAgentVersions(
  internalAgentId: string,
  tenantId: string
): Promise<{ versions: InternalAgentVersion[] }> {
  return await api.get<{ versions: InternalAgentVersion[] }>(`/api/internal-agents/${internalAgentId}/versions?tenantId=${tenantId}`)
}

// Get a specific version
export async function getInternalAgentVersion(
  internalAgentId: string,
  tenantId: string,
  version: number
): Promise<InternalAgentVersion> {
  return await api.get<InternalAgentVersion>(`/api/internal-agents/${internalAgentId}/versions/${version}?tenantId=${tenantId}`)
}

// Rollback to a specific version
export async function rollbackInternalAgentVersion(
  internalAgentId: string,
  tenantId: string,
  version: number
): Promise<InternalAgent> {
  return await api.post<InternalAgent>(`/api/internal-agents/${internalAgentId}/rollback?tenantId=${tenantId}`, { version })
}

export interface RecentlyViewedInternalAgent {
  internalAgent: InternalAgent
  viewedAt: string
}

export interface RecentlyViewedInternalAgentsResponse {
  internalAgents: RecentlyViewedInternalAgent[]
}

// Fire-and-forget view recording
export async function recordInternalAgentView(
  tenantId: string,
  internalAgentId: string,
  source?: 'dashboard' | 'teams_list' | 'direct_link'
): Promise<void> {
  try {
    await api.post(`/api/internal-agents/${internalAgentId}/views?tenantId=${tenantId}`, { source })
  } catch (error) {
    console.warn('Failed to record internal agent view:', error)
  }
}

// Fetch recently viewed
export async function getRecentlyViewedInternalAgents(
  tenantId: string,
  limit: number = 6
): Promise<RecentlyViewedInternalAgentsResponse> {
  return await api.get<RecentlyViewedInternalAgentsResponse>(
    `/api/internal-agents/recently-viewed?tenantId=${tenantId}&limit=${limit}`
  )
}

export interface AgentMemory {
  id: string
  content: string
  source: string
  createdAt: string
  usefulnessScore?: number
  lastUsedAt?: string
}

export interface AgentMemoriesResponse {
  memories: AgentMemory[]
  nextCursor: string | null
  total: number
}

export async function listAgentMemories(
  internalAgentId: string,
  tenantId: string,
  opts: { limit?: number; cursor?: string; search?: string } = {},
): Promise<AgentMemoriesResponse> {
  const params = new URLSearchParams({ tenantId })
  if (opts.limit) params.set('limit', String(opts.limit))
  if (opts.cursor) params.set('cursor', opts.cursor)
  if (opts.search) params.set('search', opts.search)
  return await api.get<AgentMemoriesResponse>(
    `/api/internal-agents/${internalAgentId}/memories?${params.toString()}`,
  )
}

export async function deleteAgentMemory(
  internalAgentId: string,
  tenantId: string,
  memoryId: string,
): Promise<void> {
  await api.delete(
    `/api/internal-agents/${internalAgentId}/memories/${memoryId}?tenantId=${tenantId}`,
  )
}

/** A skill as the platform stores it, and as the skills API returns it.
 *
 *  `id` and `tags` are optional because the same shape is used for WRITES: a
 *  freshly distilled skill has no id yet, and the steering verbs send back only
 *  what they changed. `provenance` and `protected` are round-tripped so an
 *  unrelated save cannot relabel a distilled skill as hand-authored, or strip a
 *  person's protection off one (P1.0). */
export interface AgentSkill {
  id?: string
  name: string
  description: string
  instruction: string
  tags?: string[]
  provenance?: 'distilled' | 'learned' | 'operator'
  protected?: boolean
  archived?: boolean
}

export interface AgentSkillsResponse {
  skills: AgentSkill[]
}

export async function getAgentSkills(
  internalAgentId: string,
  tenantId: string,
): Promise<AgentSkillsResponse> {
  return await api.get<AgentSkillsResponse>(
    `/api/internal-agents/${internalAgentId}/skills?tenantId=${tenantId}`,
  )
}

// ---------------------------------------------------------------------------
// Per-agent inbound webhooks (custom event sources)
// Backend endpoints under /api/internal-agents/:agentId/webhook — see
// migration 099_custom_event_sources.sql.

export interface AgentWebhookMetadata {
  url: string
  enabled: boolean
  hmacRequired: boolean
  secretHint: string                  // last 4 chars of the signing secret
  rateLimitPerMinute: number
  lastEventAt: string | null
}

// Plaintext credentials are returned only at provision and reset.
export interface AgentWebhookCredentials {
  url: string
  secret: string
}

export type AgentWebhookDeliveryStatus =
  | 'accepted'
  | 'duplicate'
  | 'rejected_signature'
  | 'rejected_rate'
  | 'rejected_size'
  | 'rejected_disabled'
  | 'rejected_no_active_rule'
  | 'rejected_unsafe_content'
  | 'rejected_tenant_ceiling'
  | 'rejected_budget_exceeded'

export interface AgentWebhookDelivery {
  deliveryId: string
  eventType: string | null
  status: AgentWebhookDeliveryStatus
  signatureValid: boolean
  byteSize: number
  receivedAt: string
}

export interface AgentWebhookDeliveriesResponse {
  deliveries: AgentWebhookDelivery[]
}

export interface UpdateAgentWebhookInput {
  enabled?: boolean
  hmacRequired?: boolean
  rateLimitPerMinute?: number
  contentFilterEnabled?: boolean
  piiHashMode?: boolean
}

// GET — returns null when no event source has been provisioned for this agent.
// The backend signals "not provisioned" via a 404 on this endpoint.
export async function getAgentWebhook(
  internalAgentId: string,
  tenantId: string,
): Promise<AgentWebhookMetadata | null> {
  try {
    return await api.get<AgentWebhookMetadata>(
      `/api/internal-agents/${internalAgentId}/webhook?tenantId=${tenantId}`,
    )
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null
    throw err
  }
}

// POST — idempotent. First call returns plaintext secret + url. Subsequent
// calls return the existing url with the secret omitted (set to empty string
// by the backend; the UI should not reveal anything in that case).
export async function provisionAgentWebhook(
  internalAgentId: string,
  tenantId: string,
): Promise<AgentWebhookCredentials> {
  return await api.post<AgentWebhookCredentials>(
    `/api/internal-agents/${internalAgentId}/webhook?tenantId=${tenantId}`,
    {},
  )
}

// POST /reset — atomically rotates URL + signing secret. Returns both plaintext.
export async function resetAgentWebhookCredentials(
  internalAgentId: string,
  tenantId: string,
): Promise<AgentWebhookCredentials> {
  return await api.post<AgentWebhookCredentials>(
    `/api/internal-agents/${internalAgentId}/webhook/reset?tenantId=${tenantId}`,
    {},
  )
}

export async function updateAgentWebhook(
  internalAgentId: string,
  tenantId: string,
  data: UpdateAgentWebhookInput,
): Promise<AgentWebhookMetadata> {
  return await api.patch<AgentWebhookMetadata>(
    `/api/internal-agents/${internalAgentId}/webhook?tenantId=${tenantId}`,
    data,
  )
}

export async function listAgentWebhookDeliveries(
  internalAgentId: string,
  tenantId: string,
  limit = 5,
): Promise<AgentWebhookDeliveriesResponse> {
  return await api.get<AgentWebhookDeliveriesResponse>(
    `/api/internal-agents/${internalAgentId}/webhook/deliveries?tenantId=${tenantId}&limit=${limit}`,
  )
}

