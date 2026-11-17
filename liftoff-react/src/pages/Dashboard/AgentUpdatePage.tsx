import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router'
import {
  AutonomyControl,
  BackButton,
  Button,
  IntegrationsSelector,
  RoleInput,
  RollbackModal,
  SelectableAgentCard,
  Tooltip,
  stripGuidanceTemplateIfUntouched,
  stripTemplateIfUntouched,
} from '../../components'
import AdditionalGuidanceInput from '../../components/AdditionalGuidanceInput'
import ResponsibilitiesInput from '../../components/ResponsibilitiesInput'
import { type SelectedIntegration } from '../../components/IntegrationsSelector'
import { mergeDistillIntegrationConfigs } from '../../utils/mergeDistillIntegrationConfigs'
import { formatMemoryContent, truncateOnWord } from '../../utils/formatMemoryContent'
import { permissionsToSelected as permissionsToSelectedUtil } from '../../utils/permissionsToSelected'
import CurrencyInput from '../../components/CurrencyInput/CurrencyInput'
import { Dropdown } from '../../components'
import ErrorState from '../../components/ErrorState'
import { PermissionGate } from '../../components/PermissionGate'
import { useInternalAgent, useInternalAgents, useUpdateInternalAgent, useRecordInternalAgentView, useInternalAgentVersions, useAgentMemories, useAgentSkills, useAgentWebhook } from '../../hooks/useInternalAgents'
import { useKnowledgeItems } from '../../hooks/useKnowledge'
import {
  useExternalAgent,
  useUpdateExternalAgent,
  useRediscoverCapabilities,
  useExternalAgentVersions,
} from '../../hooks/useExternalAgents'
import { useWorkforce } from '../../hooks/useWorkforce'
import { useUpdateCodingToolConnection } from '../../hooks/useClaudeCodeProxy'
import type { WorkforceClaudeCodeKey } from '../../hooks/useWorkforce'
import { useIntegrations } from '../../hooks/useIntegrations'
import { useToast } from '../../contexts/ToastContext'
import { TOAST_MESSAGES } from '../../constants/toastMessages'
import { TEAM_LIMITS } from '../../constants/limits'
import {
  COLLABORATION_MODE_LABELS,
  REQUEST_TYPES,
  type AuthType,
  type CollaborationMode,
  type DiscoverStage,
  type ExternalAgent,
  type TeamRequestRule,
  type RequestType,
  type RequestPermission,
} from '../../services/externalAgents'
import type { AgentSkill, InternalAgent, WorkflowVisualizationStep, TeamAttachment, DistillStage, DistillInput, DistillOutput } from '../../services/internalAgents'
import { distillInternalAgentStream } from '../../services/internalAgents'
import ModalOverlay from '../../components/ModalOverlay'
import LoadingStep from './AgentBuilder/steps/LoadingStep'
import SkillsManager from '../../components/SkillsManager/SkillsManager'
import type { AutonomyLevel } from '../../services/oversight'
import { useOversightSettings } from '../../hooks/useOversight'
import type { WorkspaceAiVendor } from '../../services/tenants'
import { buildTeamAiProviderOptions } from '../../constants/workspaceAi'
import { checkNicknameAvailability, deleteAgentMemory } from '../../services/internalAgents'
import { apiErrorCode } from '../../services/api'
import { useDeptSlug } from '../../hooks/useDeptSlug'
import { AgentWorkflowViz } from '../../components/AgentWorkflowViz/AgentWorkflowViz'
import type { AgentMemory } from '../../services/internalAgents'
import { useTenant, useWorkspaceAiVendor, useWorkspaceAiVendorCatalog } from '../../hooks/useTenant'
import WorkspaceAiModelGroups from '../../components/WorkspaceAiModelGroups'
import UndoIcon from '../../assets/icons/undo.svg?react'
import ChevronDownIcon from '../../assets/icons/chevron-down.svg?react'
import XIcon from '../../assets/icons/x.svg?react'
import { track } from '../../lib/analytics'
import './AgentUpdatePage.css'
import './AgentsPage.css'
import './AgentConnector/AgentConnector.css'
// Route-scoped CSS for the shared IntegrationsSelector + ConnectIntegrationModal
// this page renders. Imported here (not in the components) to avoid the
// components-barrel side-effect leaking these into the entry chunk.
import '../../components/integrationsSelector.css'
import '../../components/connectionModals.css'
// The import popover's file-picker modal renders on this route.

interface TeamUpdatePageProps {
  teamId?: string
  agentId?: string
  /** A coding-tool connection: a Switch-flow credential or an MCP anchor, by
   *  the id its teams row carries. */
  codingToolId?: string
  onSave: () => void
  onCancel: () => void
}

interface CodingToolFormProps {
  connection: WorkforceClaudeCodeKey
  onSave: () => void
  onCancel: () => void
}

// A coding-tool connection on the same shell as the two forms beside it: the
// name and what it does, which the platform-backend keeps beside the
// connection and applies over the derived values. The row is read from the
// teams payload (which is how an MCP anchor, which is not a proxy credential,
// gets a page at all). The key itself and the status have no place here: the
// key is the developer proxy's and revoking is the row's Archive action.
export function CodingToolForm({ connection, onSave, onCancel }: CodingToolFormProps) {
  const { showToast } = useToast()
  const [name, setName] = useState(connection.name)
  const [description, setDescription] = useState(connection.description ?? '')
  const { mutateAsync: updateConnection, isPending: isSaving } = useUpdateCodingToolConnection()

  const hasChanges = name !== connection.name || description !== (connection.description ?? '')
  const isValid = name.trim().length > 0

  const handleSave = async () => {
    if (!hasChanges || !isValid) return
    try {
      await updateConnection({
        connectionId: connection.id,
        name: name.trim(),
        description: description.trim(),
      })
      track('team_update_coding_tool_saved', { connection_id: connection.id })
      onSave()
    } catch {
      showToast('Failed to save changes', 'error')
    }
  }

  return (
    <div className="agent-update">
      <BackButton onClick={onCancel} />

      <div className="agent-update__header">
        <div className="agent-update__header-actions">
          <PermissionGate permission="edit_teams" fallback={null}>
            <Button variant="primary" onClick={handleSave} disabled={!hasChanges || !isValid} loading={isSaving}>
              Save
            </Button>
          </PermissionGate>
        </div>
      </div>

      <div className="agent-update__content">
        <section className="agent-update__section">
          <h2 className="agent-update__section-title">Collaborator name *</h2>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="agent-update__input"
            required
          />
        </section>

        <section className="agent-update__section">
          <h2 className="agent-update__section-title">What does this collaborator do?</h2>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="agent-update__textarea"
          />
        </section>
      </div>
    </div>
  )
}

const PERMISSIONS: RequestPermission[] = ['allowed', 'approval_required', 'blocked']

// Generate human-readable label for permission + request type
function getPermissionLabel(permission: RequestPermission, requestType: RequestType): string {
  const typeLabels: Record<RequestType, string> = {
    read_summaries: 'read summaries',
    run_analysis: 'run analysis',
    draft_outputs: 'draft outputs',
    propose_updates: 'propose updates',
  }

  const action = typeLabels[requestType]

  switch (permission) {
    case 'allowed':
      return `Can ${action}`
    case 'approval_required':
      return `Needs approval to ${action}`
    case 'blocked':
      return `Cannot ${action}`
  }
}

interface PermissionPillProps {
  permission: RequestPermission
  requestType: RequestType
  onChange: (permission: RequestPermission) => void
}

function PermissionPill({ permission, requestType, onChange }: PermissionPillProps) {
  const [isOpen, setIsOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  return (
    <div className="agent-connector__rules-pill-wrapper" ref={ref}>
      <button
        type="button"
        className={`agent-connector__rules-pill agent-connector__rules-pill--${permission}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        {getPermissionLabel(permission, requestType)}
        <ChevronDownIcon className="agent-connector__rules-pill-chevron" />
      </button>
      {isOpen && (
        <div className="agent-connector__rules-dropdown">
          {PERMISSIONS.map(p => (
            <button
              key={p}
              type="button"
              className={`agent-connector__rules-dropdown-item agent-connector__rules-dropdown-item--${p} ${p === permission ? 'agent-connector__rules-dropdown-item--selected' : ''}`}
              onClick={() => {
                onChange(p)
                setIsOpen(false)
              }}
            >
              {getPermissionLabel(p, requestType)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Auth credential hint display component
const AUTH_TYPE_LABELS: Record<AuthType, string> = {
  none: 'No authentication',
  api_key: 'API Key',
  bearer_token: 'Bearer Token',
  custom_headers: 'Custom Headers',
}

function AuthHintDisplay({ agent }: { agent: ExternalAgent }) {
  const { authType, apiKeyHint, bearerTokenHint, customHeaderKeys } = agent

  return (
    <div className="agent-update__auth-fields">
      {/* Auth type - disabled pill input */}
      <div className="agent-builder-input">
        <input
          type="text"
          value={AUTH_TYPE_LABELS[authType]}
          disabled
          className="agent-builder-input__field agent-builder-input__field--disabled"
        />
      </div>

      {/* Credential hint - disabled pill input */}
      {authType === 'api_key' && apiKeyHint && (
        <div className="agent-builder-input">
          <input
            type="text"
            value={apiKeyHint}
            disabled
            className="agent-builder-input__field agent-builder-input__field--disabled"
          />
        </div>
      )}

      {authType === 'bearer_token' && bearerTokenHint && (
        <div className="agent-builder-input">
          <input
            type="text"
            value={bearerTokenHint}
            disabled
            className="agent-builder-input__field agent-builder-input__field--disabled"
          />
        </div>
      )}

      {authType === 'custom_headers' && customHeaderKeys && customHeaderKeys.length > 0 && (
        <div className="agent-builder-input">
          <input
            type="text"
            value={customHeaderKeys.join(', ')}
            disabled
            className="agent-builder-input__field agent-builder-input__field--disabled"
          />
        </div>
      )}
    </div>
  )
}

// Skeleton for loading state
function TeamUpdateSkeleton() {
  return (
    <div className="agent-update">
      <div className="agent-update__header">
        <div className="skeleton-text skeleton-pulse" style={{ width: '100px', height: '32px' }} />
        <div className="skeleton-text skeleton-pulse" style={{ width: '120px', height: '40px' }} />
      </div>
      <div className="agent-update__content">
        <div className="agent-update__section">
          <div className="skeleton-text skeleton-pulse" style={{ width: '150px', height: '24px', marginBottom: '12px' }} />
          <div className="skeleton-text skeleton-pulse" style={{ width: '100%', height: '48px' }} />
        </div>
        <div className="agent-update__section">
          <div className="skeleton-text skeleton-pulse" style={{ width: '200px', height: '24px', marginBottom: '12px' }} />
          <div className="skeleton-text skeleton-pulse" style={{ width: '100%', height: '120px' }} />
        </div>
        <div className="agent-update__section">
          <div className="skeleton-text skeleton-pulse" style={{ width: '180px', height: '24px', marginBottom: '12px' }} />
          <div className="skeleton-text skeleton-pulse" style={{ width: '100%', height: '80px' }} />
        </div>
      </div>
    </div>
  )
}

// Internal team form — mounts only after team data is loaded so state
// initializes directly from props, eliminating the useEffect race condition
// that caused MarkdownTextarea editors to briefly render with empty content.
interface InternalTeamFormProps {
  team: InternalAgent
  onSave: () => void
  onCancel: () => void
}

// Exported for tests: the page wrapper only exists to fetch `team`, and mounting
// the form directly is what lets the save path be exercised without standing up
// that fetch. Not imported anywhere else in the app.
export function InternalTeamForm({ team, onSave, onCancel }: InternalTeamFormProps) {
  const navigate = useNavigate()
  const { connected, available } = useIntegrations()
  const { showToast } = useToast()
  const { currentTenant: tenant } = useTenant()
  const { data: knowledgeItems = [] } = useKnowledgeItems()
  const { data: agentsQueryData } = useInternalAgents({ status: 'active' })
  const agentItems = agentsQueryData?.pages.flatMap(p => p.internalAgents.map(a => ({ id: a.id, label: a.role }))) ?? []

  // Convert integration permissions to SelectedIntegration objects (for UI display)
  const permissionsToSelected = (
    permissions: {
      id: string
      integrationId?: string
      selectedObjects: string[]
      config?: Record<string, unknown>
    }[],
  ): SelectedIntegration[] => permissionsToSelectedUtil(permissions, [...connected, ...available])

  // State initializes directly from team data
  const [role, setRole] = useState(team.role)
  const [responsibilities, setResponsibilities] = useState(team.responsibilities || '')
  const [integrations, setIntegrations] = useState<SelectedIntegration[]>(() =>
    permissionsToSelected(team.integrations)
  )
  // Knowledge mention autocomplete filters to items whose connectorId is in
  // this set (plus manual-URL items where connectorId === null). Recomputed
  // when integrations change.
  const effectiveBoundConnectorIds = useMemo(
    () => integrations.map(i => i.id),
    [integrations],
  )
  const [additionalContext, setAdditionalContext] = useState(team.additionalContext || '')
  const [attachments, setAttachments] = useState<TeamAttachment[]>(team.attachments ?? [])
  // Handle for a distillation that has run but is not yet saved. It replaces
  // the `systemPrompt`/`userInstructions` state this page used to hold: those
  // existed only to carry the distiller's output from Optimize to Save, were
  // never rendered, and no longer reach the client at all. Non-null is exactly
  // the condition "there is a fresh distillation to persist", which is what the
  // two dirty-checks below used to infer by comparing prompt text.
  const [pendingDistillId, setPendingDistillId] = useState<string | null>(null)
  const [temperature] = useState(team.temperature ?? 0.3)
  const [messagingNickname, setMessagingNickname] = useState(team.messagingNickname || '')
  const [nicknameError, setNicknameError] = useState<string | null>(null)
  const nicknameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const deptSlug = useDeptSlug(role, responsibilities, additionalContext)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [autonomyOverrideOpen, setAutonomyOverrideOpen] = useState(false)
  const [autonomyOverride, setAutonomyOverride] = useState<AutonomyLevel | null>(team.autonomyOverride ?? null)
  const [aiProviderOpen, setAiProviderOpen] = useState(false)
  const [aiVendorOverride, setAiVendorOverride] = useState<WorkspaceAiVendor | null>(team.aiVendorOverride ?? null)
  const [pendingDeletions, setPendingDeletions] = useState<Set<string>>(new Set())

  // The workspace-level values the two override cards fall back to. Resolved so
  // each card can name what "Workspace default" actually means right now.
  const { data: workspaceAiVendor } = useWorkspaceAiVendor(tenant?.id)
  const { data: oversightSettings } = useOversightSettings()
  const aiProviderOptions = useMemo(
    () => buildTeamAiProviderOptions(workspaceAiVendor),
    [workspaceAiVendor],
  )
  // The chosen provider's models and coding tool, read once the card opens,
  // as on the Workspace AI card in Settings.
  const { data: aiVendorCatalog } = useWorkspaceAiVendorCatalog(tenant?.id, aiProviderOpen)
  // A nickname that has just been edited carries no verdict yet, so the
  // previous one's error clears as it is typed rather than a frame later.
  const [checkedNickname, setCheckedNickname] = useState(messagingNickname)
  if (messagingNickname !== checkedNickname) {
    setCheckedNickname(messagingNickname)
    setNicknameError(null)
  }

  // Debounced nickname uniqueness check (400ms after last keystroke)
  useEffect(() => {
    if (nicknameTimerRef.current) clearTimeout(nicknameTimerRef.current)

    if (!messagingNickname.trim() || messagingNickname === (team.messagingNickname || '')) return

    nicknameTimerRef.current = setTimeout(async () => {
      try {
        const result = await checkNicknameAvailability(tenant?.id || '', messagingNickname, team.id)
        if (!result.available) {
          track('team_update_nickname_check_failed', { team_id: team.id, reason: 'conflict' })
          setNicknameError(`Already used by ${result.conflictWith || 'another team member'}`)
        }
      } catch {
        // Fail open — don't block the user on a validation endpoint failure
      }
    }, 400)

    return () => { if (nicknameTimerRef.current) clearTimeout(nicknameTimerRef.current) }
  }, [messagingNickname, team.messagingNickname, tenant?.id, team.id])

  // What the fields looked like at the last distill. State, not a ref: the
  // Optimize button is derived from comparing it against the fields now, and
  // render may not read a ref.
  const [lastDistilled, setLastDistilled] = useState<{
    role: string
    responsibilities: string
    integrations: string
    additionalContext: string
    attachments: string
  }>({
    role: team.role,
    responsibilities: stripTemplateIfUntouched(team.responsibilities || ''),
    integrations: JSON.stringify(
      permissionsToSelected(team.integrations).map((i) => ({
        id: i.id,
        integrationId: i.integrationId,
        selectedObjects: i.selectedObjects,
      }))
    ),
    additionalContext: stripGuidanceTemplateIfUntouched(team.additionalContext || ''),
    attachments: JSON.stringify(team.attachments ?? []),
  })
  const [showRollbackModal, setShowRollbackModal] = useState(false)

  // Track if we're in a save flow (includes distill-then-save)
  const [isSaving, setIsSaving] = useState(false)
  const [distilledSummary, setDistilledSummary] = useState<string | undefined>(undefined)
  const [distilledSkills, setDistilledSkills] = useState<AgentSkill[] | undefined>(undefined)
  const [optimizedVizSteps, setOptimizedVizSteps] = useState<WorkflowVisualizationStep[] | null>(null)

  // Mutations
  // ── The distillation modal ──────────────────────────────────────
  //
  // Optimize and Save both run the same ~50s distillation. Until now the only
  // sign of it was a disabled button reading "Optimizing...", and on the Save
  // path not even that: the button said "Saving" while a minute of generation
  // happened behind it. Both now raise the builder's progress checklist over
  // the page, in its `update` wording.
  const [distilling, setDistilling] = useState(false)
  const [distillStage, setDistillStage] = useState<DistillStage | null>(null)
  const [distillError, setDistillError] = useState<string | null>(null)
  const distillAbortRef = useRef<AbortController | null>(null)
  /** Settles the in-flight runDistill with null when the person calls it off. */
  const distillCancelRef = useRef<(() => void) | null>(null)
  /** Starts the same distillation over, without resolving the caller. */
  const distillRetryRef = useRef<(() => void) | null>(null)

  // Leaving the page abandons the run rather than leaving it talking to a
  // screen nobody is on. Mirrors AgentBuilder.
  useEffect(() => () => distillAbortRef.current?.abort(), [])

  /**
   * Run a distillation behind the modal.
   *
   * Resolves with the artifact, or with null if it was called off. A null
   * result means the caller must not proceed: on Save in particular,
   * persisting after an abandoned distillation would write a team whose
   * instructions and prose no longer agree.
   *
   * A failure does NOT resolve. It holds the modal open on the error, with a
   * retry, and the promise stays pending until that retry succeeds or the
   * person cancels. Closing on failure meant a distillation that failed fast
   * (a 502 from the API, say) showed as the modal appearing and vanishing in a
   * flash, with the reason in a toast that is easy to miss. A wait that fails
   * should look like a failure, and retry should not cost the caller's place.
   */
  const runDistill = useCallback((input: DistillInput): Promise<DistillOutput | null> => {
    setDistilling(true)

    return new Promise<DistillOutput | null>((resolve) => {
      const settle = (value: DistillOutput | null) => {
        distillCancelRef.current = null
        distillRetryRef.current = null
        setDistilling(false)
        resolve(value)
      }

      const attempt = () => {
        distillAbortRef.current?.abort()
        const run = new AbortController()
        distillAbortRef.current = run
        setDistillStage(null)
        setDistillError(null)

        distillInternalAgentStream(
          tenant!.id,
          input,
          {
            onProgress: (stage) => {
              if (run.signal.aborted) return
              setDistillStage(stage)
            },
            onComplete: (result) => {
              if (run.signal.aborted) return
              settle(result)
            },
            onError: (err) => {
              if (run.signal.aborted) return
              track('team_update_optimize_failed', {
                team_id: team.id,
                reason: err.message || 'unknown',
              })
              setDistillError(err.message || 'Failed to optimize agent advanced settings')
            },
          },
          run.signal,
        )
      }

      distillCancelRef.current = () => settle(null)
      distillRetryRef.current = attempt
      attempt()
    })
  }, [tenant, team.id])

  const cancelDistill = useCallback(() => {
    track('team_update_optimize_canceled', { team_id: team.id, stage: distillStage ?? 'none' })
    distillAbortRef.current?.abort()
    distillAbortRef.current = null
    distillCancelRef.current?.()
  }, [team.id, distillStage])
  const updateTeamMutation = useUpdateInternalAgent()
  // Ref so stale closures (e.g. handleSave after an async distill await) always
  // call the latest mutation observer rather than a replaced/stale one.
  const updateTeamMutationRef = useRef(updateTeamMutation)
  useEffect(() => {
    updateTeamMutationRef.current = updateTeamMutation
  }, [updateTeamMutation])

  // Version data
  const { data: versionsData } = useInternalAgentVersions(team.id)

  // Memory data (lazy — only fetches when section is expanded)
  const { data: memoriesData, isLoading: memoriesLoading } = useAgentMemories(team.id, { enabled: memoryOpen })
  // Skills data (fetches when advanced section is opened)
  const { data: skillsData } = useAgentSkills(team.id, { enabled: advancedOpen })
  // Webhook status — drives the status string on the Webhooks navigation card.
  const { data: webhook } = useAgentWebhook(team.id)
  // Show distilled skills immediately after Optimize (before async Pub/Sub storage),
  // falling back to the persisted skills from the query.
  const displaySkills = distilledSkills ?? skillsData?.skills
  // P1.4: steering edits (instruction / protect / archive) held locally until
  // Save, so they land as one manual version alongside any other change.
  const [steeredSkills, setSteeredSkills] = useState<AgentSkill[] | null>(null)
  const skillsForDisplay = steeredSkills ?? displaySkills ?? []

  // Helper to get primary fields fingerprint
  const getPrimaryFieldsKey = useCallback((r: string, resp: string, integ: SelectedIntegration[], ctx: string, atts: TeamAttachment[]) => {
    return JSON.stringify({
      role: r,
      responsibilities: stripTemplateIfUntouched(resp),
      integrations: integ.map(i => ({ id: i.id, integrationId: i.integrationId, selectedObjects: i.selectedObjects })),
      additionalContext: stripGuidanceTemplateIfUntouched(ctx),
      attachments: atts,
    })
  }, [])

  // Check if primary fields have changed since last distill
  const hasPrimaryFieldsChanged = useCallback(() => {
    const currentKey = getPrimaryFieldsKey(role, responsibilities, integrations, additionalContext, attachments)
    const lastKey = JSON.stringify({
      role: lastDistilled.role,
      responsibilities: lastDistilled.responsibilities,
      integrations: JSON.parse(lastDistilled.integrations),
      additionalContext: lastDistilled.additionalContext,
      attachments: JSON.parse(lastDistilled.attachments),
    })

    return currentKey !== lastKey
  }, [role, responsibilities, integrations, additionalContext, attachments, getPrimaryFieldsKey, lastDistilled])

  // Helper to perform the actual save
  // `integrationsOverride` lets the distill-then-save flow pass the freshly
  // merged integrations (with LLM-derived config) without waiting for React
  // to flush the setIntegrations state update.
  const performSave = useCallback(async (
    /** Handle for a distillation to persist with this save, or null for a save
     *  that carries none. Replaces the two prompt strings this used to take:
     *  the server reads the compiled prompt from the artifact, so passing the
     *  text was both redundant and the reason it had to reach the client. A
     *  non-null handle also records the version as a distill on its own, which
     *  is why the separate `distilled` flag is gone. */
    distillId: string | null,
    summary?: string,
    skills?: AgentSkill[],
    integrationsOverride?: SelectedIntegration[],
  ) => {
    const strippedResponsibilities = stripTemplateIfUntouched(responsibilities)
    const strippedAdditionalContext = stripGuidanceTemplateIfUntouched(additionalContext)
    const effectiveIntegrations = integrationsOverride ?? integrations

    // Fire staged memory deletions in parallel (best-effort)
    if (pendingDeletions.size > 0 && tenant?.id) {
      await Promise.allSettled(
        Array.from(pendingDeletions).map(memoryId => {
          track('team_update_memory_deleted', { team_id: team.id, memory_id: memoryId })
          return deleteAgentMemory(team.id, tenant.id, memoryId)
        }),
      )
    }

    const agentFieldsChanged =
      steeredSkills !== null ||
      role !== team.role ||
      strippedResponsibilities !== (team.responsibilities || '') ||
      JSON.stringify(effectiveIntegrations.map(i => ({ id: i.id, integrationId: i.integrationId, selectedObjects: i.selectedObjects, ...(i.config ? { config: i.config } : {}) }))) !==
        JSON.stringify(team.integrations) ||
      strippedAdditionalContext !== (team.additionalContext || '') ||
      // Stands in for the old "did the compiled prompt change" comparison. A
      // distillation can regenerate the prompt from prose that has since been
      // reverted, leaving every input field equal to the saved agent; without
      // this term that save would be skipped and the fresh summary and skills
      // silently discarded.
      distillId !== null ||
      temperature !== (team.temperature ?? 0.3) ||
      messagingNickname !== (team.messagingNickname || '') ||
      autonomyOverride !== (team.autonomyOverride ?? null) ||
      aiVendorOverride !== (team.aiVendorOverride ?? null) ||
      JSON.stringify(attachments) !== JSON.stringify(team.attachments ?? [])

    if (!agentFieldsChanged) {
      setIsSaving(false)
      onSave()
      return
    }

    updateTeamMutationRef.current.mutate(
      {
        internalAgentId: team.id,
        data: {
          role,
          responsibilities: strippedResponsibilities,
          integrations: effectiveIntegrations.map(i => ({
            id: i.id,
            integrationId: i.integrationId,
            selectedObjects: i.selectedObjects,
            ...(i.config ? { config: i.config } : {}),
          })),
          additionalContext: strippedAdditionalContext || undefined,
          ...(distillId ? { distillId } : {}),
          temperature,
          messagingNickname: messagingNickname || undefined,
          summary: summary || undefined,
          // P1.4 steering edits win: they are the person's explicit change to
          // this exact list. Otherwise a fresh distill result, otherwise
          // nothing (leaving the stored set untouched).
          skills: steeredSkills ?? skills ?? distilledSkills,
          autonomyOverride,
          aiVendorOverride,
          attachments,
        },
      },
      {
        onSuccess: () => {
          setIsSaving(false)
          onSave()
        },
        onError: (err: unknown) => {
          setIsSaving(false)
          // apiFetch throws ApiError, which carries the body's `code` directly.
          // The old `err.response.data.code` shape was axios-style and never
          // matched, so every failure fell through to the generic toast.
          const code = apiErrorCode(err)
          if (code === 'NICKNAME_CONFLICT') {
            showToast('This nickname is already used by another team member', 'error')
          } else {
            showToast('Failed to save changes', 'error')
          }
        },
      }
    )
  }, [team, role, responsibilities, integrations, additionalContext, attachments, temperature, messagingNickname, autonomyOverride, aiVendorOverride, distilledSkills, steeredSkills, pendingDeletions, tenant, onSave, showToast])

  // Trigger distillation (manual button click from Advanced Settings)
  const handleOptimize = useCallback(() => {
    track('team_update_optimize_clicked', { team_id: team.id })
    const strippedResponsibilities = stripTemplateIfUntouched(responsibilities)
    const strippedAdditionalContext = stripGuidanceTemplateIfUntouched(additionalContext)

    void (async () => {
      // Null means called off or failed. runDistill has already said so.
      const result = await runDistill({
        role,
        responsibilities: strippedResponsibilities,
        integrations: integrations.map(i => ({
          id: i.id,
          name: i.name,
          type: i.type,
          selectedObjects: i.selectedObjects,
        })),
        additionalContext: strippedAdditionalContext || null,
        ...(attachments.length > 0 ? { attachments } : {}),
      })
      if (!result) return

      track('agent_optimized', { agent_id: team.id, kind: 'internal' })
      track('team_update_optimize_completed', { team_id: team.id })
      setPendingDistillId(result.distillId)
      setDistilledSummary(result.summary ?? undefined)
      setDistilledSkills(result.skills ?? undefined)
      if (result.workflowVisualizationSteps) setOptimizedVizSteps(result.workflowVisualizationSteps)
      // Merge per-binding config emitted by the LLM (e.g. Gmail gmailQuery
      // and sendAs) onto the current SelectedIntegration[] before save.
      const mergedIntegrations = mergeDistillIntegrationConfigs(integrations, result.integrationConfigs)
      if (mergedIntegrations !== integrations) {
        setIntegrations(mergedIntegrations)
      }
      // Update last distilled ref using the merged integrations so the
      // primary-fields fingerprint doesn't immediately re-trigger.
      setLastDistilled({
        role,
        responsibilities: strippedResponsibilities,
        integrations: JSON.stringify(mergedIntegrations.map(i => ({ id: i.id, integrationId: i.integrationId, selectedObjects: i.selectedObjects, ...(i.config ? { config: i.config } : {}) }))),
        additionalContext: strippedAdditionalContext,
        attachments: JSON.stringify(attachments),
      })
    })()
  }, [role, responsibilities, integrations, additionalContext, attachments, runDistill, team.id])

  // Whether the Optimize button shows is a question about the fields as they
  // stand, not something to record after the fact. It reads false until a
  // distill has happened, which is what lastDistilledRef has to say.
  const needsOptimize = advancedOpen && hasPrimaryFieldsChanged()

  const handleSave = async () => {
    track('team_update_save_clicked', { team_id: team.id })
    if (isSaving) return

    // Validate field lengths
    const strippedResponsibilities = stripTemplateIfUntouched(responsibilities)
    const strippedAdditionalContext = stripGuidanceTemplateIfUntouched(additionalContext)

    // The two prompt-length clauses that used to sit here are gone with the
    // state they read. Nobody could type into those fields — the distiller was
    // their only writer — and the server enforces the same 50k caps on what it
    // generates, so the check could not fire. The remaining three guard fields
    // a person actually types into.
    if (
      role.length > TEAM_LIMITS.ROLE_MAX ||
      strippedResponsibilities.length > TEAM_LIMITS.RESPONSIBILITIES_MAX ||
      (strippedAdditionalContext && strippedAdditionalContext.length > TEAM_LIMITS.ADDITIONAL_CONTEXT_MAX)
    ) {
      showToast(TOAST_MESSAGES.VALIDATION_TOO_LONG, 'error')
      return
    }

    // Start the save flow
    setIsSaving(true)

    // Changed prose is always redistilled before saving. A team is defined by
    // distillation, so the compiled prompt, instructions and skills must all be
    // regenerated together from the same source text — otherwise the saved team
    // is a mix of new instructions and skills distilled from prose that no
    // longer exists, and the stale half still steers every run.
    //
    // This used to be gated on the Advanced Settings panel being closed, so the
    // same button either distilled or did not depending on whether a disclosure
    // was expanded, with nothing said either way. Hand-edits made in that panel
    // are overwritten when the prose changes, which is the intended order of
    // authority. Saving with the prose untouched still keeps them.
    if (hasPrimaryFieldsChanged()) {
      // Behind the same modal as Optimize. This path used to spend the whole
      // minute under a button reading "Saving", with nothing to say a
      // generation was even happening.
      const result = await runDistill({
        role,
        responsibilities: strippedResponsibilities,
        integrations: integrations.map(i => ({
          id: i.id,
          name: i.name,
          type: i.type,
          selectedObjects: i.selectedObjects,
        })),
        additionalContext: strippedAdditionalContext || null,
        ...(attachments.length > 0 ? { attachments } : {}),
      })
      // Called off or failed. Saving now would persist a team whose stored
      // instructions were distilled from prose that has since changed.
      if (!result) {
        setIsSaving(false)
        return
      }

      setPendingDistillId(result.distillId)
      setDistilledSummary(result.summary ?? undefined)
      setDistilledSkills(result.skills ?? undefined)
      // Merge per-binding config from the distillation result into integrations
      // BEFORE the save call so the persisted IntegrationPermission[] picks up
      // any gmailQuery / sendAs the LLM derived from the user's responsibilities.
      const mergedIntegrations = mergeDistillIntegrationConfigs(integrations, result.integrationConfigs)
      if (mergedIntegrations !== integrations) {
        setIntegrations(mergedIntegrations)
      }
      setLastDistilled({
        role,
        responsibilities: strippedResponsibilities,
        integrations: JSON.stringify(
          mergedIntegrations.map((i) => ({
            id: i.id,
            integrationId: i.integrationId,
            selectedObjects: i.selectedObjects,
            ...(i.config ? { config: i.config } : {}),
          }))
        ),
        additionalContext: strippedAdditionalContext,
        attachments: JSON.stringify(attachments),
      })
      // Pass mergedIntegrations explicitly so the save doesn't race with the
      // setIntegrations state update.
      performSave(
        result.distillId,
        result.summary ?? undefined,
        result.skills ?? undefined,
        mergedIntegrations,
      )
      return
    } else {
      // Save directly with current values. Any handle from an earlier Optimize
      // still rides along, so its prompt and skills are persisted rather than
      // stranded by a save that changed nothing else.
      performSave(pendingDistillId, distilledSummary)
    }
  }

  const isValid = role.trim().length > 0 && (stripTemplateIfUntouched(responsibilities).trim().length > 0 || attachments.length > 0)

  const hasAgentFieldChanges =
    role !== team.role ||
    stripTemplateIfUntouched(responsibilities) !== (team.responsibilities || '') ||
    JSON.stringify(integrations.map(i => ({ id: i.id, integrationId: i.integrationId, selectedObjects: i.selectedObjects, ...(i.config ? { config: i.config } : {}) }))) !==
      JSON.stringify(team.integrations) ||
    stripGuidanceTemplateIfUntouched(additionalContext) !== (team.additionalContext || '') ||
    // Keeps Save enabled after an Optimize whose prose was then reverted. The
    // prompt comparisons this replaces were the only thing holding the button
    // open in that sequence, since every input field is back to its saved value
    // while an unsaved distillation is still pending.
    pendingDistillId !== null ||
    temperature !== (team.temperature ?? 0.3) ||
    messagingNickname !== (team.messagingNickname || '') ||
    autonomyOverride !== (team.autonomyOverride ?? null) ||
    aiVendorOverride !== (team.aiVendorOverride ?? null) ||
    JSON.stringify(attachments) !== JSON.stringify(team.attachments ?? [])

  const hasChanges = hasAgentFieldChanges || pendingDeletions.size > 0

  return (
    <div className="agent-update">
      <BackButton onClick={onCancel} />

      <div className="agent-update__header">
        <div className="agent-update__header-actions">
          {/* Only show rollback button if there are previous versions */}
          {versionsData && versionsData.versions.length > 1 && (
            <Tooltip text="Restore Previous Version">
              <button
                className="agent-update__rollback-btn"
                onClick={() => {
                  track('team_update_rollback_opened', { team_id: team.id })
                  setShowRollbackModal(true)
                }}
                aria-label="Restore Previous Version"
              >
                <UndoIcon width="20" height="20" />
              </button>
            </Tooltip>
          )}
          <PermissionGate permission="edit_teams" fallback={null}>
            <Button variant="primary" onClick={handleSave} disabled={!hasChanges || !isValid || !!nicknameError} loading={isSaving}>
              Save
            </Button>
          </PermissionGate>
        </div>
      </div>

      {/* Rollback Modal */}
      {showRollbackModal && (
        <RollbackModal
          teamId={team.id}
          currentVersion={team.currentVersion}
          onClose={() => setShowRollbackModal(false)}
        />
      )}

      <div className="agent-update__content">
        <section className="agent-update__section">
          <RoleInput
            value={role}
            onChange={setRole}
            titleClassName="agent-update__section-title"
            animated={false}
          />
        </section>

        <section className="agent-update__section">
          <ResponsibilitiesInput
            value={responsibilities}
            onChange={setResponsibilities}
            titleClassName="agent-update__section-title"
            knowledgeItems={knowledgeItems}
            agentItems={agentItems}
            boundConnectorIds={effectiveBoundConnectorIds}
            attachments={attachments}
            onAttachmentsChange={setAttachments}
          />
        </section>

        <section className="agent-update__section">
          <IntegrationsSelector
            selected={integrations}
            onChange={setIntegrations}
            titleClassName="agent-update__section-title"
          />
        </section>

        <section className="agent-update__section">
          <AdditionalGuidanceInput
            value={additionalContext}
            onChange={setAdditionalContext}
            titleClassName="agent-update__section-title"
            knowledgeItems={knowledgeItems}
            agentItems={agentItems}
            boundConnectorIds={effectiveBoundConnectorIds}
            attachments={attachments}
            onAttachmentsChange={setAttachments}
          />
        </section>

        <section className="agent-update__section">
          <h2 className="agent-update__section-title">Do you want to augment them with experts?</h2>
          <p className="agent-update__section-description">
            Liftoff can help you bring on human experts to improve this team's performance by guiding, refining, and overseeing its work.
          </p>
          <a
            href={`mailto:support@liftoff.com?subject=${encodeURIComponent(`Expert Augmentation Request: ${role} from Account-123`)}`}
            className="agent-card__upsell-btn"
            onClick={() => track('team_update_augment_with_experts_clicked', { team_id: team.id })}
          >
            Augment with Experts
          </a>
        </section>

        <section className="agent-update__section">
          <h2 className="ai-team-update__section-title">What nickname should they have on Slack and Microsoft Teams?</h2>
          {(() => {
            const suffix = deptSlug || role.toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9-]/g, '')
            const baseValue = messagingNickname.replace(new RegExp(`-${suffix}$`), '')
            return (
              <div className="agent-update__nickname-row">
                <div className="agent-builder-input agent-builder-input--narrow">
                  <input
                    type="text"
                    className={`agent-builder-input__field${nicknameError ? ' agent-builder-input__field--error' : ''}`}
                    value={baseValue}
                    onChange={e => {
                      const base = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')
                      setMessagingNickname(base ? `${base}-${suffix}` : '')
                    }}
                    placeholder={`@mention-${suffix}`}
                    maxLength={35}
                    disabled={isSaving}
                  />
                </div>
                {baseValue && (
                  <span className="agent-update__nickname-preview">@{baseValue}-{suffix}</span>
                )}
              </div>
            )
          })()}
          {nicknameError && (
            <p className="agent-update__nickname-error">{nicknameError}</p>
          )}
        </section>

        <section className="agent-update__section agent-update__collapsible">
          <button
            type="button"
            className="agent-update__collapsible-header"
            onClick={() => {
              const next = !autonomyOverrideOpen
              track('team_update_autonomy_override_toggled', { team_id: team.id, open: next })
              setAutonomyOverrideOpen(next)
            }}
          >
            <h2 className="agent-update__section-title">Autonomy Override</h2>
            <ChevronDownIcon
              className={`agent-update__collapsible-icon ${autonomyOverrideOpen ? 'agent-update__collapsible-icon--open' : ''}`}
            />
          </button>

          {autonomyOverrideOpen && (
            <div className="agent-update__collapsible-content">
              <p className="agent-update__autonomy-hint">
                Override the workspace-level autonomy setting for this agent only.
              </p>
              <AutonomyControl
                value={autonomyOverride}
                workspaceDefault={oversightSettings?.autonomy}
                onChange={(level) => {
                  track('team_update_autonomy_override_changed', { team_id: team.id, level })
                  setAutonomyOverride(level)
                }}
              />
            </div>
          )}
        </section>

        <button
          type="button"
          className="agent-update__section agent-update__nav-card"
          onClick={() => {
            track('team_update_webhook_nav_clicked', { team_id: team.id })
            navigate('/dashboard/agents/update/webhook', { state: { teamId: team.id } })
          }}
        >
          <div className="agent-update__nav-card-main">
            <h2 className="agent-update__section-title">Webhooks</h2>
          </div>
          <div className="agent-update__nav-card-meta">
            <span className="agent-update__nav-card-status">
              {webhook?.enabled ? 'Enabled' : 'Disabled'}
            </span>
            <ChevronDownIcon
              className="agent-update__nav-card-chevron"
              width="16"
              height="16"
            />
          </div>
        </button>

        <section className="agent-update__section agent-update__collapsible">
          <button
            type="button"
            className="agent-update__collapsible-header"
            onClick={() => {
              const next = !aiProviderOpen
              track('team_update_ai_provider_toggled', { team_id: team.id, open: next })
              setAiProviderOpen(next)
            }}
          >
            <h2 className="agent-update__section-title">AI Provider Override</h2>
            <ChevronDownIcon
              className={`agent-update__collapsible-icon ${aiProviderOpen ? 'agent-update__collapsible-icon--open' : ''}`}
            />
          </button>

          {aiProviderOpen && (
            <div className="agent-update__collapsible-content">
              <p className="agent-update__provider-hint">
                Override the workspace AI provider for this agent only.
              </p>
              <div className="agent-update__provider-row">
                <Dropdown
                  options={aiProviderOptions}
                  // No override shows the inherited vendor as the selection, the
                  // same way the autonomy list highlights the workspace level.
                  value={aiVendorOverride ?? workspaceAiVendor ?? ''}
                  placeholder="Loading..."
                  onChange={(v) => {
                    // Choosing the workspace's own vendor means "follow the
                    // workspace", so it clears the override instead of pinning it.
                    const next = v === workspaceAiVendor ? null : (v as WorkspaceAiVendor)
                    track('team_update_ai_provider_changed', { team_id: team.id, provider: next })
                    setAiVendorOverride(next)
                  }}
                />
                <button
                  type="button"
                  className="agent-update__provider-link"
                  onClick={() => navigate('/dashboard/support/settings/ai-providers')}
                >
                  Learn More
                </button>
              </div>
              <WorkspaceAiModelGroups vendor={aiVendorOverride ?? workspaceAiVendor} catalog={aiVendorCatalog} />
            </div>
          )}
        </section>

        <section className="agent-update__section agent-update__collapsible">
          <button
            type="button"
            className="agent-update__collapsible-header"
            onClick={() => {
              const next = !advancedOpen
              track('team_update_advanced_section_toggled', { team_id: team.id, open: next })
              setAdvancedOpen(next)
            }}
          >
            <h2 className="agent-update__section-title">Advanced Settings</h2>
            <ChevronDownIcon
              className={`agent-update__collapsible-icon ${advancedOpen ? 'agent-update__collapsible-icon--open' : ''}`}
            />
          </button>

          {advancedOpen && (
            <div className="agent-update__collapsible-content">
              {needsOptimize && (
                <div className="agent-update__optimize-row">
                  <Button
                    variant="outline"
                    onClick={handleOptimize}
                    disabled={distilling}
                  >
                    {distilling ? 'Optimizing...' : 'Optimize Agent Advanced Settings'}
                  </Button>
                </div>
              )}

              <AgentWorkflowViz
                steps={optimizedVizSteps ?? team.workflowVisualizationSteps ?? []}
              />

              {/* Owns the "Uses" row: one pill per skill, each with its own actions. */}
              <SkillsManager
                skills={skillsForDisplay}
                onChange={setSteeredSkills}
                disabled={isSaving}
              />
            </div>
          )}
        </section>

        <section className="agent-update__section agent-update__collapsible">
          <button
            type="button"
            className="agent-update__collapsible-header"
            onClick={() => {
              const next = !memoryOpen
              track('team_update_memory_section_toggled', { team_id: team.id, open: next })
              setMemoryOpen(next)
            }}
          >
            <h2 className="agent-update__section-title">Learned Context</h2>
            <ChevronDownIcon
              className={`agent-update__collapsible-icon ${memoryOpen ? 'agent-update__collapsible-icon--open' : ''}`}
            />
          </button>

          {memoryOpen && (
            <div className="agent-update__collapsible-content">
              {memoriesLoading ? (
                <div className="agent-update__memory-skeleton">
                  {[0, 1, 2].map(i => (
                    <div key={i} className="agent-update__memory-skeleton-row" />
                  ))}
                </div>
              ) : !memoriesData || memoriesData.memories.filter(m => !pendingDeletions.has(m.id)).length === 0 ? (
                <p className="agent-update__memory-empty">No learned context yet.</p>
              ) : (
                <ul className="agent-update__memory-list">
                  {memoriesData.memories
                    .filter(m => !pendingDeletions.has(m.id))
                    .map((memory: AgentMemory) => {
                      // Normalise the raw memory body (strip markdown labels,
                      // prettify MCP tool ids, collapse line breaks) then
                      // truncate on a word boundary — full text stays in the
                      // hover tooltip. See utils/formatMemoryContent.
                      const formatted = formatMemoryContent(memory.content)
                      const truncated = truncateOnWord(formatted, 140)
                      const isTruncated = truncated !== formatted
                      const formattedDate = new Intl.DateTimeFormat('en-US', {
                        month: 'short', day: 'numeric', year: 'numeric',
                      }).format(new Date(memory.createdAt))
                      return (
                        <li key={memory.id} className="agent-update__memory-item">
                          <div className="agent-update__memory-item-body">
                            {isTruncated ? (
                              <Tooltip text={formatted}>
                                <span className="agent-update__memory-content">{truncated}</span>
                              </Tooltip>
                            ) : (
                              <span className="agent-update__memory-content">{truncated}</span>
                            )}
                            <span className="agent-update__memory-meta">
                              {memory.source && <span className="agent-update__memory-source">{memory.source}</span>}
                              <span className="agent-update__memory-date">{formattedDate}</span>
                            </span>
                          </div>
                          <button
                            type="button"
                            className="agent-update__memory-delete"
                            aria-label="Remove memory"
                            onClick={() => {
                              track('team_update_memory_queued_for_delete', { team_id: team.id, memory_id: memory.id })
                              setPendingDeletions(prev => new Set([...prev, memory.id]))
                            }}
                          >
                            <XIcon width={14} height={14} />
                          </button>
                        </li>
                      )
                    })}
                </ul>
              )}
            </div>
          )}
        </section>

      </div>

      {/* The distillation, raised over the settings. Escape and the backdrop
          call it off, as they do for every other modal here, and the button
          below says so rather than leaving that to be guessed at. */}
      {distilling && (
        <ModalOverlay onClose={cancelDistill} contentClassName="modal-overlay__content--rows">
          <div className="agent-update__distill-modal">
            <LoadingStep
              role={role}
              stage={distillStage}
              error={distillError}
              onRetry={() => distillRetryRef.current?.()}
              variant="update"
            />
            {/* The error state brings its own Try Again, so a second button
                beside it would be two ways to do the same thing. Cancel is
                still the way out of both. */}
            <Button variant="outline" onClick={cancelDistill}>
              Cancel
            </Button>
          </div>
        </ModalOverlay>
      )}
    </div>
  )
}

export default function AgentUpdatePage({ teamId, agentId, codingToolId, onSave, onCancel }: TeamUpdatePageProps) {
  const isExternalAgent = !!agentId
  const isClaudeCode = !!codingToolId

  // Fetch agent data using TanStack Query (only if teamId provided)
  const { data: team, isLoading: teamLoading, refetch: refetchTeam } = useInternalAgent(teamId)

  // Fetch external agent data (only if agentId provided)
  const { data: agent, isLoading: agentLoading, refetch: refetchAgent } = useExternalAgent(agentId)

  // A coding-tool connection is read off the teams payload it was opened
  // from: one list carries proxy credentials and MCP anchors alike.
  const { data: workforce, isLoading: workforceLoading, refetch: refetchWorkforce } = useWorkforce()
  const proxyKey = codingToolId ? workforce?.claudeCodeKeys.find((k) => k.id === codingToolId) : undefined
  const proxyKeyLoading = isClaudeCode && workforceLoading
  const refetchProxyKey = refetchWorkforce

  const { showToast } = useToast()
  const { mutate: recordView } = useRecordInternalAgentView()
  const hasRecordedViewRef = useRef<string | null>(null)

  const isLoading = isClaudeCode ? proxyKeyLoading : isExternalAgent ? agentLoading : teamLoading
  const refetch = isClaudeCode ? refetchProxyKey : isExternalAgent ? refetchAgent : refetchTeam

  useEffect(() => {
    if (team?.id && hasRecordedViewRef.current !== team.id) {
      hasRecordedViewRef.current = team.id
      recordView({ internalAgentId: team.id, source: 'teams_list' })
    }
  }, [team?.id, recordView])

  const viewedKindRef = useRef<string | null>(null)
  useEffect(() => {
    if (isClaudeCode && proxyKey && viewedKindRef.current !== `claudecode:${proxyKey.id}`) {
      viewedKindRef.current = `claudecode:${proxyKey.id}`
      track('team_update_claude_code_viewed', { proxy_key_id: proxyKey.id })
    } else if (isExternalAgent && agent && viewedKindRef.current !== `external:${agent.id}`) {
      viewedKindRef.current = `external:${agent.id}`
      track('team_update_opened', { team_id: agent.id, agent_kind: 'external' })
      track('team_update_external_viewed', { agent_id: agent.id })
    } else if (!isClaudeCode && !isExternalAgent && team && viewedKindRef.current !== `internal:${team.id}`) {
      viewedKindRef.current = `internal:${team.id}`
      track('team_update_opened', { team_id: team.id, agent_kind: 'internal' })
      track('team_update_internal_viewed', { team_id: team.id })
    }
  }, [isClaudeCode, isExternalAgent, proxyKey, agent, team])

  // External agent state
  const [agentName, setAgentName] = useState('')
  const [agentDescription, setAgentDescription] = useState('')
  const [agentCollaborationMode, setAgentCollaborationMode] = useState<CollaborationMode>('two_way')
  const [agentAllowedTeamIds, setAgentAllowedTeamIds] = useState<Set<string>>(new Set())
  const [agentRequestRules, setAgentRequestRules] = useState<TeamRequestRule[]>([])
  const [agentCostAmount, setAgentCostAmount] = useState('')
  const [agentCostType, setAgentCostType] = useState<'per_task' | 'per_month'>('per_month')
  const [rediscoverStage, setRediscoverStage] = useState<DiscoverStage | null>(null)
  const [showRollbackModal, setShowRollbackModal] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  // Fetch all teams for the allowed teams selector (only needed for external agents)
  const { data: teamsData } = useInternalAgents()
  const allTeams = teamsData?.pages.flatMap(page => page.internalAgents) ?? []

  // External agent mutations
  const updateAgentMutation = useUpdateExternalAgent()
  const rediscoverMutation = useRediscoverCapabilities()

  // Version data for external agents
  const { data: versionsData } = useExternalAgentVersions(agentId)

  // Track if external agent init has happened
  const hasInitializedRef = useRef(false)

  // Sync local state when external agent data loads
  useEffect(() => {
    if (agent && isExternalAgent && !hasInitializedRef.current) {
      hasInitializedRef.current = true
      setAgentName(agent.name)
      setAgentDescription(agent.description || '')
      setAgentCollaborationMode(agent.collaborationMode)
      setAgentAllowedTeamIds(new Set(agent.allowedInternalAgentIds || []))
      setAgentRequestRules(agent.requestRules || [])
      setAgentCostAmount(agent.costAmount != null ? String(agent.costAmount) : '')
      setAgentCostType(agent.costType || 'per_month')
    }
  }, [agent, isExternalAgent])

  // External agent handlers
  const handleAgentSave = async () => {
    if (!agent) return
    setIsSaving(true)
    try {
      // Only send fields that actually changed
      const data: Record<string, unknown> = {}
      if (agentName !== agent.name) data.name = agentName
      if (agentDescription !== (agent.description || '')) data.description = agentDescription
      if (agentCollaborationMode !== agent.collaborationMode) data.collaborationMode = agentCollaborationMode
      const originalAllowedIds = [...(agent.allowedInternalAgentIds || [])].sort().join(',')
      const currentAllowedIds = [...agentAllowedTeamIds].sort().join(',')
      if (originalAllowedIds !== currentAllowedIds) data.allowedInternalAgentIds = Array.from(agentAllowedTeamIds)
      if (JSON.stringify(agent.requestRules || []) !== JSON.stringify(agentRequestRules)) data.requestRules = agentRequestRules
      const newCostAmount = agentCostAmount ? parseFloat(agentCostAmount.replace(/,/g, '')) : null
      if (newCostAmount !== (agent.costAmount ?? null)) data.costAmount = newCostAmount
      const newCostType = agentCostAmount ? agentCostType : null
      if (newCostType !== (agent.costType ?? null)) data.costType = newCostType

      await updateAgentMutation.mutateAsync({
        agentId: agent.id,
        data: data as import('../../services/externalAgents').UpdateExternalAgentInput,
      })
      onSave()
    } catch {
      showToast('Failed to save changes', 'error')
    } finally {
      setIsSaving(false)
    }
  }

  const handleRediscover = async () => {
    if (!agent) return
    track('team_update_external_rediscover_clicked', { agent_id: agent.id })
    setRediscoverStage('validating')

    try {
      await rediscoverMutation.mutateAsync({
        agentId: agent.id,
        callbacks: {
          onProgress: setRediscoverStage,
          onComplete: () => {
            setRediscoverStage(null)
            showToast('Capabilities rediscovered successfully', 'success')
            refetch()
          },
          onError: (err) => {
            setRediscoverStage(null)
            showToast(err.message, 'error')
          },
        },
      })
    } catch {
      // Error already surfaced via callbacks.onError; rethrow suppressed so
      // the mutation rejects (triggers onError, not onSuccess) without
      // bubbling an unhandled rejection.
    }
  }

  // Claude Code render — mounts only after proxy key data is loaded
  if (isClaudeCode) {
    if (isLoading) return <TeamUpdateSkeleton />
    if (!proxyKey) return <ErrorState onRetry={() => refetch()} />
    return <CodingToolForm connection={proxyKey} onSave={onSave} onCancel={onCancel} />
  }

  // Loading state
  if (isLoading) {
    return <TeamUpdateSkeleton />
  }

  // Show error state only when data is absent — if a background refetch fails
  // but we still have data, keep the form visible rather than replacing it.
  if (isExternalAgent ? !agent : !team) {
    return (
      <ErrorState
        onRetry={() => refetch()}
      />
    )
  }

  // External agent render
  if (isExternalAgent && agent) {
    // Check if allowed team IDs have changed (compare as sorted arrays)
    const originalAllowedIds = [...(agent.allowedInternalAgentIds || [])].sort().join(',')
    const currentAllowedIds = [...agentAllowedTeamIds].sort().join(',')

    // Check if request rules have changed
    const originalRulesJson = JSON.stringify(agent.requestRules || [])
    const currentRulesJson = JSON.stringify(agentRequestRules)

    const agentHasChanges =
      agentName !== agent.name ||
      agentDescription !== (agent.description || '') ||
      agentCollaborationMode !== agent.collaborationMode ||
      originalAllowedIds !== currentAllowedIds ||
      originalRulesJson !== currentRulesJson ||
      agentCostAmount !== (agent.costAmount != null ? String(agent.costAmount) : '') ||
      agentCostType !== (agent.costType || 'per_month')

    const COLLABORATION_MODES: CollaborationMode[] = ['two_way', 'request_help', 'receive_delegated', 'observe_only']

    const handleToggleTeam = (teamId: string) => {
      const newSet = new Set(agentAllowedTeamIds)
      const isCurrentlySelected = newSet.has(teamId)
      if (isCurrentlySelected) {
        newSet.delete(teamId)
      } else {
        newSet.add(teamId)
      }
      track('team_update_external_team_toggled', {
        agent_id: agent.id,
        team_id: teamId,
        selected: !isCurrentlySelected,
      })
      setAgentAllowedTeamIds(newSet)
    }

    const handleSelectAllTeams = () => {
      const deselecting = agentAllowedTeamIds.size === allTeams.length
      track('team_update_external_select_all_teams', { agent_id: agent.id, deselected: deselecting })
      if (deselecting) {
        setAgentAllowedTeamIds(new Set())
      } else {
        setAgentAllowedTeamIds(new Set(allTeams.map(t => t.id)))
      }
    }

    const handlePermissionChange = (teamId: string, requestType: RequestType, permission: RequestPermission) => {
      track('team_update_external_permission_changed', {
        agent_id: agent.id,
        team_id: teamId,
        request_type: requestType,
        permission,
      })
      const newRules = agentRequestRules.map(rule => {
        if (rule.teamId === teamId) {
          return {
            ...rule,
            permissions: {
              ...rule.permissions,
              [requestType]: permission,
            },
          }
        }
        return rule
      })
      setAgentRequestRules(newRules)
    }

    // Filter rules to only show teams that are currently allowed
    const visibleRules = agentRequestRules.filter(rule => agentAllowedTeamIds.has(rule.teamId))

    return (
      <div className="agent-update">
        <BackButton onClick={onCancel} />

        <div className="agent-update__header">
          <div className="agent-update__header-actions">
            {versionsData && versionsData.versions.length > 1 && (
              <Tooltip text="Restore Previous Version">
                <button
                  className="agent-update__rollback-btn"
                  onClick={() => setShowRollbackModal(true)}
                  aria-label="Restore Previous Version"
                >
                  <UndoIcon width="20" height="20" />
                </button>
              </Tooltip>
            )}
            <Button variant="primary" onClick={handleAgentSave} disabled={!agentHasChanges || !agentName.trim()} loading={isSaving}>
              Save
            </Button>
          </div>
        </div>

        {showRollbackModal && (
          <RollbackModal
            entityType="external-agent"
            entityId={agent.id}
            currentVersion={agent.currentVersion}
            onClose={() => setShowRollbackModal(false)}
            onRollback={() => {
              setShowRollbackModal(false)
              refetch()
            }}
          />
        )}

        <div className="agent-update__content">
          <section className="agent-update__section">
            <h2 className="agent-update__section-title">Collaborator name *</h2>
            <input
              type="text"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              className="agent-update__input"
              required
            />
          </section>

          <section className="agent-update__section">
            <h2 className="agent-update__section-title">What does this collaborator do?</h2>
            <textarea
              value={agentDescription}
              onChange={(e) => setAgentDescription(e.target.value)}
              className="agent-update__textarea"
              rows={4}
              placeholder="Describe what this collaborator does..."
            />
          </section>

          <section className="agent-update__section">
            <h2 className="agent-update__section-title">Capabilities</h2>
            <Button
              variant="outline"
              onClick={handleRediscover}
              disabled={rediscoverMutation.isPending}
            >
              {rediscoverStage
                ? <>Discovering capabilities<span className="animated-ellipsis" /></>
                : 'Rediscover'}
            </Button>
            <div className="agent-update__capabilities">
              {agent.detectedCapabilities.map(cap => (
                <div key={cap.id} className="agent-update__capability">
                  <span className="agent-update__capability-label">{cap.name}</span>
                  <span className="agent-update__capability-description">{cap.description}</span>
                </div>
              ))}
              {agent.detectedCapabilities.length === 0 && (
                <p className="agent-update__empty">No capabilities detected</p>
              )}
            </div>
          </section>

          {agent.capabilityChanges && agent.capabilityChanges.length > 0 && (
            <section className="agent-update__section agent-update__section--warning">
              <h2 className="agent-update__section-title">Pending Capability Changes</h2>
              <p className="agent-update__section-description">
                The following changes were detected during the last rediscovery and require review.
              </p>
              <div className="agent-update__changes">
                {agent.capabilityChanges.map((change, i) => (
                  <div key={i} className={`agent-update__change agent-update__change--${change.type}`}>
                    <span className="agent-update__change-type">{change.type}</span>
                    <span className="agent-update__change-tool">{change.toolName}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="agent-update__section">
            <h2 className="agent-update__section-title">Who can this collaborator work with?</h2>
            {allTeams.length > 1 && (
              <Button
                variant="outline"
                onClick={handleSelectAllTeams}
              >
                {agentAllowedTeamIds.size === allTeams.length ? 'Deselect All' : 'Select All'}
              </Button>
            )}
            <div className="agent-connector__team-list">
              {allTeams.map(t => (
                <SelectableAgentCard
                  key={t.id}
                  team={t}
                  selected={agentAllowedTeamIds.has(t.id)}
                  onToggle={handleToggleTeam}
                />
              ))}
            </div>
            {allTeams.length === 0 && (
              <p className="agent-update__empty">No teams available. Create a team first to enable collaboration.</p>
            )}
          </section>

          <section className="agent-update__section">
            <h2 className="agent-update__section-title">How should they collaborate?</h2>
            <div className="agent-connector__mode-options">
              {COLLABORATION_MODES.map((mode) => {
                const label = COLLABORATION_MODE_LABELS[mode]
                const isSelected = agentCollaborationMode === mode

                return (
                  <button
                    key={mode}
                    type="button"
                    className={`agent-connector__mode-option ${isSelected ? 'agent-connector__mode-option--selected' : ''}`}
                    onClick={() => {
                      track('team_update_external_collaboration_mode_changed', { agent_id: agent.id, mode })
                      setAgentCollaborationMode(mode)
                    }}
                  >
                    <span className="agent-connector__mode-label">{label.title}</span>
                    <span className="agent-connector__mode-description">{label.description}</span>
                  </button>
                )
              })}
            </div>
          </section>

          {visibleRules.length > 0 && (
            <section className="agent-update__section">
              <h2 className="agent-update__section-title">Request Permissions</h2>
              <div className="agent-connector__rules-list">
                {visibleRules.map(rule => (
                  <div key={rule.teamId} className="agent-connector__rules-card">
                    <h3 className="agent-connector__rules-card-name">{rule.teamName}</h3>
                    <div className="agent-connector__rules-pills">
                      {REQUEST_TYPES.map(type => (
                        <PermissionPill
                          key={type}
                          permission={rule.permissions[type]}
                          requestType={type}
                          onChange={(p) => handlePermissionChange(rule.teamId, type, p)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="agent-update__section">
            <h2 className="agent-update__section-title">How much does this collaborator cost?</h2>
            <div className="agent-update__cost-row">
              <CurrencyInput
                value={agentCostAmount}
                onChange={setAgentCostAmount}
                placeholder="0.00"
                disabled={isSaving}
              />
              <Dropdown
                value={agentCostType}
                onChange={val => {
                  const next = val as 'per_task' | 'per_month'
                  track('team_update_external_cost_changed', { agent_id: agent.id, cost_type: next })
                  setAgentCostType(next)
                }}
                options={[
                  { value: 'per_month', label: 'Cost per Month' },
                  { value: 'per_task', label: 'Cost per Task' },
                ]}
                disabled={isSaving}
              />
            </div>
          </section>

          <section className="agent-update__section agent-update__collapsible">
            <button
              type="button"
              className="agent-update__collapsible-header"
              onClick={() => {
                const next = !advancedOpen
                track('team_update_external_advanced_toggled', { agent_id: agent.id, open: next })
                setAdvancedOpen(next)
              }}
            >
              <h2 className="agent-update__section-title">Advanced Settings</h2>
              <ChevronDownIcon
                className={`agent-update__collapsible-icon ${advancedOpen ? 'agent-update__collapsible-icon--open' : ''}`}
              />
            </button>

            {advancedOpen && (
              <div className="agent-update__collapsible-content">
                <div className="agent-update__subsection">
                  <h3 className="agent-update__subsection-title">MCP endpoint URL</h3>
                  <div className="agent-builder-input">
                    <input
                      type="text"
                      value={agent.endpointUrl}
                      disabled
                      className="agent-builder-input__field agent-builder-input__field--disabled"
                    />
                  </div>
                </div>

                <div className="agent-update__subsection">
                  <h3 className="agent-update__subsection-title">Authentication</h3>
                  <AuthHintDisplay agent={agent} />
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    )
  }

  // Internal team render — InternalTeamForm mounts only when team data is loaded,
  // so its state initializes directly from team data (no useEffect race condition)
  return <InternalTeamForm team={team!} onSave={onSave} onCancel={onCancel} />
}
