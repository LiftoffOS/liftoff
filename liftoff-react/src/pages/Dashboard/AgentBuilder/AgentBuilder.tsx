import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { track } from '../../../lib/analytics'
import { firstInvalidField } from '../../../services/api'
import { BackButton, stripGuidanceTemplateIfUntouched, stripTemplateIfUntouched } from '../../../components'
import { useCreateInternalAgent, useInternalAgents } from '../../../hooks/useInternalAgents'
import { useTenant } from '../../../hooks/useTenant'
import { usePlanGate } from '../../../components/Dashboard/planGateContext'
import { useKnowledgeItems } from '../../../hooks/useKnowledge'
import { distillInternalAgentStream, type DistillStage, type DistillOutput, type TeamAttachment } from '../../../services/internalAgents'
import { type SelectedIntegration } from '../../../components/IntegrationsSelector'
import { mergeDistillIntegrationConfigs } from '../../../utils/mergeDistillIntegrationConfigs'
import RoleStep from './steps/RoleStep'
import ResponsibilitiesStep from './steps/ResponsibilitiesStep'
import IntegrationsStep from './steps/IntegrationsStep'
import LoadingStep from './steps/LoadingStep'
import CompletionStep from './steps/CompletionStep'
import '../../../components/agentBuilderInput.css'
// The import popover's file-picker modal renders on this route.
import './AgentBuilder.css'

export interface TeamBuilderData {
  role: string
  responsibilities: string
  /** The team's operating rules. A first-class field all the way down, never
   *  folded into `responsibilities` and never smuggled in as an attachment:
   *  the distiller fences it separately as ADDITIONAL_CONTEXT, and the create
   *  call persists it so a later redistill can read it back off the agent row.
   *  Empty for the ordinary custom-hire flow, which never collects it. */
  additionalContext: string
  integrations: SelectedIntegration[]
  attachments: TeamAttachment[]
}

// Legacy Team interface for backwards compatibility
// New code should use Team from services/teams.ts
export interface Team {
  id: string
  role: string
  responsibilities: string
  integrations: string[]
  status: 'active' | 'paused' | 'draft'
  createdAt: Date
  lastActive: Date
  tasksCompleted: number
  monthlyCost: number
  hybridMode?: boolean
  additionalContext?: string
}

interface TeamBuilderProps {
  onComplete?: () => void
  onCancel?: () => void

  /** When provided, seeds `data.role` and skips step 1 — same effect as
   *  today's `?role=` URL param. Used by the onboarding builder-fallback
   *  mount where there's no URL navigation. Wins over URL param. */
  initialRole?: string

  // `onBuildCompletion` used to sit here: an onboarding intercept that replaced
  // the full distill with a callback, because the distill was too expensive to
  // run before the customer had paid. The build now happens after onboarding,
  // after payment, so the distill just runs (ADR-050).
}

export default function AgentBuilder({ onComplete, onCancel, initialRole: initialRoleProp }: TeamBuilderProps) {
  const navigate = useNavigate()
  const { openIfPaymentRequired } = usePlanGate()
  const [searchParams] = useSearchParams()
  const initialRole = initialRoleProp ?? searchParams.get('role') ?? ''
  const [step, setStep] = useState(initialRole.trim() ? 2 : 1)
  const [data, setData] = useState<TeamBuilderData>({
    role: initialRole,
    responsibilities: '',
    additionalContext: '',
    integrations: [],
    attachments: []
  })
  const [distillResult, setDistillResult] = useState<DistillOutput | null>(null)
  /** The summary, ahead of the rest of the artifact.
   *
   *  Under the waved strategy it arrives seconds in, long before the prose. It
   *  is the only distilled field this screen shows, so holding the screen back
   *  for the rest would be waiting on work nobody here reads. */
  const [earlySummary, setEarlySummary] = useState<string | null>(null)
  /** The distillation is still running behind the confirmation screen. */
  const [finalizing, setFinalizing] = useState(false)
  /** A decision taken before the artifact was ready.
   *
   *  The create needs the whole artifact — the server redeems `distillId` and
   *  reads the prompts from it — so an early click is honoured by remembering
   *  it and firing when the artifact lands, not by sending an incomplete
   *  create. A ref rather than state: the effect below must read the value
   *  written by the click that happened before this render. */
  const deferredActionRef = useRef<'launch' | 'notNow' | null>(null)
  // Artifact names the person approved for the shared knowledge library (P1.1).
  // Starts empty: the library is curated, so an import adds nothing to it by
  // default.
  const [libraryApprovals, setLibraryApprovals] = useState<string[]>([])
  const [distillError, setDistillError] = useState<string | null>(null)
  const [distillStage, setDistillStage] = useState<DistillStage | null>(null)
  const [pendingAction, setPendingAction] = useState<'launch' | 'notNow' | null>(null)

  const { currentTenant: tenant } = useTenant()
  const createTeamMutation = useCreateInternalAgent()
  const { data: knowledgeItems = [] } = useKnowledgeItems()
  const { data: agentsData } = useInternalAgents({ status: 'active' })
  const agentItems = agentsData?.pages.flatMap(p => p.internalAgents.map(a => ({ id: a.id, label: a.role }))) ?? []

  const startedRef = useRef(false)
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    track('team_builder_started', {
      entry: initialRole.trim() ? 'role_prefilled' : 'fresh',
    })
  }, [initialRole])

  const lastDistillStageRef = useRef<string | null>(null)

  /** The in-flight distillation, so it can be called off. */
  const distillAbortRef = useRef<AbortController | null>(null)

  // Navigating away is a cancel too. Without this the stream outlives the
  // wizard and keeps a backend generation running for a screen nobody is on.
  useEffect(() => () => distillAbortRef.current?.abort(), [])

  const updateData = (updates: Partial<TeamBuilderData>) => {
    setData(prev => ({ ...prev, ...updates }))
  }

  const advanceStep = (completed: 'role' | 'responsibilities' | 'integrations') => {
    const index = completed === 'role' ? 1 : completed === 'responsibilities' ? 2 : 3
    track('team_builder_step_completed', { step: completed, step_index: index })
    setStep(prev => prev + 1)
  }

  const prevStep = () => setStep(prev => prev - 1)

  // Trigger distillation when moving to loading step
  const handleStartDistill = () => {
    if (!tenant?.id) return

    // One controller per attempt. It both closes the HTTP stream and fences
    // this attempt's callbacks, so a retry cannot be overtaken by the run it
    // replaced and a cancelled run cannot drive the wizard from off-screen.
    distillAbortRef.current?.abort()
    const run = new AbortController()
    distillAbortRef.current = run

    setDistillError(null)
    setDistillStage(null)
    // Cleared with the rest. A retry whose summary never lands would otherwise
    // show the previous attempt's summary as though it were this one's.
    setEarlySummary(null)
    setFinalizing(false)
    setPendingAction(null)
    deferredActionRef.current = null
    lastDistillStageRef.current = null
    track('team_builder_step_completed', { step: 'integrations', step_index: 3 })
    track('team_builder_distill_started', {})
    setStep(4)

    const guidance = stripGuidanceTemplateIfUntouched(data.additionalContext)

    distillInternalAgentStream(
      tenant.id,
      {
        role: data.role,
        responsibilities: stripTemplateIfUntouched(data.responsibilities),
        // Its own field, not appended to responsibilities: the distiller
        // fences it as ADDITIONAL_CONTEXT and weaves it in as behavioral
        // constraints. Stripped-to-empty collapses the fence entirely, so a
        // custom hire sends exactly what it always did.
        ...(guidance.trim() ? { additionalContext: guidance } : {}),
        integrations: data.integrations.map(i => ({
          id: i.id,
          name: i.name,
          type: i.type,
          selectedObjects: i.selectedObjects,
        })),
        ...(data.attachments.length > 0 ? { attachments: data.attachments } : {}),
      },
      {
        onProgress: (stage) => {
          if (run.signal.aborted) return
          if (lastDistillStageRef.current !== stage) {
            lastDistillStageRef.current = stage
            track('team_builder_distill_stage_changed', { stage })
          }
          setDistillStage(stage)
        },
        onSummaryReady: (summary) => {
          if (run.signal.aborted) return
          setEarlySummary(summary)
          setFinalizing(true)
          setStep(5)
        },
        onComplete: (result) => {
          if (run.signal.aborted) return
          track('team_builder_distill_completed', {})
          // Merge LLM-emitted per-binding config (e.g. Gmail gmailQuery /
          // sendAs derived from responsibilities) onto the wizard's
          // SelectedIntegration[] so the create payload carries it.
          const merged = mergeDistillIntegrationConfigs(data.integrations, result.integrationConfigs)
          if (merged !== data.integrations) {
            setData(prev => ({ ...prev, integrations: merged }))
          }
          setDistillResult(result)
          setFinalizing(false)
          setStep(5)
        },
        onError: (error) => {
          if (run.signal.aborted) return
          // Clears the deferred click too: a decision waiting on an artifact
          // that failed must not fire later against a stale result.
          deferredActionRef.current = null
          setFinalizing(false)
          setPendingAction(null)
          track('team_builder_distill_failed', { reason: error.message })
          setDistillError(error.message || 'Failed to generate team configuration')
        },
      },
      run.signal
    )
  }

  const handleRetryDistill = () => {
    track('team_builder_distill_retried', {})
    setDistillError(null)
    handleStartDistill()
  }

  const buildPayload = (status: 'active' | 'draft') => {
    const guidance = stripGuidanceTemplateIfUntouched(data.additionalContext)
    return {
      role: data.role,
      responsibilities: stripTemplateIfUntouched(data.responsibilities),
      // Persisted, not merely distilled from. A redistill rebuilds the prompts
      // from the agent row, so an agent created without this would silently
      // lose its operating rules the first time anyone re-optimized it.
      ...(guidance.trim() ? { additionalContext: guidance } : {}),
      integrations: data.integrations.map(i => ({
        id: i.id,
        integrationId: i.integrationId,
        selectedObjects: i.selectedObjects,
        ...(i.collaborationMode ? { collaborationMode: i.collaborationMode } : {}),
        ...(i.config ? { config: i.config } : {}),
      })),
      summary: distillResult?.summary,
      // The compiled prompt, skills and result rules come from the artifact this
      // handle names, not from here. They were never displayed, and echoing them
      // back was how `skills` and `capabilityTier` got dropped: this payload did
      // not declare them, so the server's schema stripped them.
      distillId: distillResult?.distillId,
      status,
      agentType: distillResult?.agentType,
      triggerConfig: distillResult?.triggerConfig,
      ...(distillResult?.workflowSteps && distillResult.workflowSteps.length > 0
        ? { workflowSteps: distillResult.workflowSteps }
        : {}),
      ...(data.attachments.length > 0 ? { attachments: data.attachments } : {}),
      // P1.1: hand back the routing the distiller already worked out, plus the
      // library choices, so the server applies them without re-classifying.
      ...(distillResult?.absorption?.length ? { absorption: distillResult.absorption } : {}),
      ...(libraryApprovals.length > 0 ? { libraryApprovals } : {}),
    }
  }

  const handleLaunch = () => {
    // The artifact is not ready. Remember the decision and show it as pending
    // rather than sending a create the server cannot redeem.
    if (!distillResult) {
      deferredActionRef.current = 'launch'
      setPendingAction('launch')
      return
    }
    setPendingAction('launch')
    createTeamMutation.mutate(buildPayload('active'), {
      onSuccess: (created) => {
        track('agent_created', {
          agent_id: created.id,
          kind: 'internal',
          source: 'team_build',
          status: 'active',
          integrations_count: data.integrations.length,
        })
        onComplete?.()
      },
      onError: (error) => {
        // A 402 means the workspace has no plan. Building is free, launching is
        // not — so this is the payment gate, not a create failure, and it must
        // not land in the error surface below as something the user cannot fix.
        if (openIfPaymentRequired(error)) return
        // Without this a failed create did nothing observable: the spinner
        // stopped, pendingAction reset, and the screen was unchanged. Reuses the
        // error surface this flow already renders rather than adding another.
        setDistillError(error.message || 'Could not create the agent. Please try again.')
        // And nothing recorded it either, so in the data a rejected create was
        // indistinguishable from someone closing the tab at the last screen.
        track('team_builder_create_failed', {
          action: 'launch',
          reason: error.message || 'unknown',
          ...(firstInvalidField(error) ? { field: firstInvalidField(error)! } : {}),
        })
      },
      onSettled: () => setPendingAction(null),
    })
  }

  const handleNotNow = () => {
    if (!distillResult) {
      deferredActionRef.current = 'notNow'
      setPendingAction('notNow')
      return
    }
    setPendingAction('notNow')
    createTeamMutation.mutate(buildPayload('draft'), {
      onSuccess: (created) => {
        track('agent_created', {
          agent_id: created.id,
          kind: 'internal',
          source: 'team_build',
          status: 'draft',
          integrations_count: data.integrations.length,
        })
        onComplete?.()
      },
      onError: (error) => {
        setDistillError(error.message || 'Could not save the agent. Please try again.')
        // Tracked separately from 'launch': a rejected draft is the worse of the
        // two, because the person cannot even keep the work.
        track('team_builder_create_failed', {
          action: 'save_draft',
          reason: error.message || 'unknown',
          ...(firstInvalidField(error) ? { field: firstInvalidField(error)! } : {}),
        })
      },
      onSettled: () => setPendingAction(null),
    })
  }

  // Fires a decision that was taken before the artifact was ready.
  //
  // Keyed on distillResult rather than on `finalizing` because the create needs
  // the artifact itself, not merely the absence of work in flight.
  useEffect(() => {
    if (!distillResult) return
    const deferred = deferredActionRef.current
    if (!deferred) return
    deferredActionRef.current = null
    if (deferred === 'launch') handleLaunch()
    else handleNotNow()
    // handleLaunch/handleNotNow are recreated every render; depending on them
    // would re-fire this on every render instead of when the artifact lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [distillResult])

  const handleBack = () => {
    if (step === 1) {
      track('team_builder_canceled', { from_step: step })
      onCancel?.()
      navigate('/dashboard/agents/explore')
    } else if (step === 4) {
      // Leaving the loading screen abandons the run rather than backgrounding
      // it: the stream is what would otherwise pull the wizard forward to the
      // confirmation screen while someone is editing step 3.
      track('team_builder_distill_canceled', { stage: distillStage ?? 'none' })
      distillAbortRef.current?.abort()
      distillAbortRef.current = null
      setDistillStage(null)
      setDistillError(null)
      setEarlySummary(null)
      setFinalizing(false)
      setStep(3)
    } else if (step === 5) {
      setStep(3) // Skip loading when going back from completion
    } else {
      prevStep()
    }
  }

  return (
    <div className="agent-builder">
      {/* Every step, the loading screen included. A build people cannot back
          out of is a build they close the tab on. */}
      <BackButton onClick={handleBack} />
      <div className="agent-builder__content">
        {step === 1 && (
          <RoleStep
            value={data.role}
            onChange={(role) => updateData({ role })}
            onContinue={() => advanceStep('role')}
          />
        )}
        {step === 2 && (
          <ResponsibilitiesStep
            value={data.responsibilities}
            onChange={(responsibilities) => updateData({ responsibilities })}
            onContinue={() => advanceStep('responsibilities')}
            knowledgeItems={knowledgeItems}
            agentItems={agentItems}
            boundConnectorIds={data.integrations.map(i => i.id)}
            attachments={data.attachments}
            onAttachmentsChange={(attachments) => updateData({ attachments })}
          />
        )}
        {step === 3 && (
          <IntegrationsStep
            selected={data.integrations}
            onChange={(integrations) => updateData({ integrations })}
            onContinue={handleStartDistill}
          />
        )}
        {step === 4 && (
          <LoadingStep
            role={data.role}
            stage={distillStage}
            error={distillError}
            onRetry={handleRetryDistill}
          />
        )}
        {step === 5 && (
          <CompletionStep
            role={data.role}
            scopeSummary={distillResult?.summary || earlySummary || ''}
            integrations={data.integrations}
            onLaunch={handleLaunch}
            onNotNow={handleNotNow}
            isLaunching={pendingAction === 'launch'}
            isSaving={pendingAction === 'notNow'}
            absorption={distillResult?.absorption}
            libraryApprovals={libraryApprovals}
            onLibraryApprovalsChange={setLibraryApprovals}
            error={distillError}
            finalizing={finalizing}
            finalizingStage={distillStage}
            surface="build"
            onRetryDistill={distillResult ? undefined : handleRetryDistill}
          />
        )}
      </div>
    </div>
  )
}
