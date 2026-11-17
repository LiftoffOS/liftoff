// AgentConnector wizard - multi-step flow for connecting external agents
// Follows AgentBuilder.tsx pattern

import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router'
import { track } from '../../../lib/analytics'
import { BackButton } from '../../../components'
import { useToast } from '../../../contexts/ToastContext'
import { useInternalAgents } from '../../../hooks/useInternalAgents'
import { useCreateExternalAgent, useDiscoverExternalAgent } from '../../../hooks/useExternalAgents'
import type {
  ConnectionType,
  AuthType,
  CollaborationMode,
  DiscoverOutput,
  TeamRequestRule,
  DiscoverStage,
  CustomHeader,
} from '../../../services/externalAgents'
import ConnectionTypeStep from './steps/ConnectionTypeStep'
import IdentifyAgentStep from './steps/IdentifyAgentStep'
import ConfirmAgentStep from './steps/ConfirmAgentStep'
import SelectTeamsStep from './steps/SelectTeamsStep'
import CollaborationModeStep from './steps/CollaborationModeStep'
import RequestRulesStep from './steps/RequestRulesStep'
import './AgentConnector.css'

// Wizard state
interface WizardState {
  connectionType: ConnectionType | null
  name: string
  endpointUrl: string
  description: string
  authType: AuthType
  apiKey: string
  bearerToken: string
  customHeaders: CustomHeader[]
  // Discovery results
  discoveryResult: DiscoverOutput | null
  discoveryStage: DiscoverStage | null
  discoveryError: string | null
  // Tunnel (optional). When non-null the endpointUrl above is the routed
  // *.tunnels.example.com URL committed by <TunnelSetup />.
  tunnelRouteId: string | null
  // Team selection
  selectedTeamIds: Set<string>
  collaborationMode: CollaborationMode
  requestRules: TeamRequestRule[]
}

const initialState: WizardState = {
  connectionType: null,
  name: '',
  endpointUrl: '',
  description: '',
  authType: 'none',
  apiKey: '',
  bearerToken: '',
  customHeaders: [],
  discoveryResult: null,
  discoveryStage: null,
  discoveryError: null,
  tunnelRouteId: null,
  selectedTeamIds: new Set(),
  collaborationMode: 'two_way',
  requestRules: [],
}

interface TeamConnectorProps {
  onComplete?: () => void
  onCancel?: () => void
}

export default function AgentConnector({ onComplete, onCancel }: TeamConnectorProps) {
  const navigate = useNavigate()
  const { showToast } = useToast()
  const { data: teamsData } = useInternalAgents()
  const createMutation = useCreateExternalAgent()
  const discoverMutation = useDiscoverExternalAgent()

  const [step, setStep] = useState(0)
  const [state, setState] = useState<WizardState>(initialState)
  const startedRef = useRef(false)
  const lastDiscoveryStageRef = useRef<string | null>(null)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    track('team_connector_started', {})
  }, [])

  // Handle state updates
  const updateState = useCallback((updates: Partial<WizardState>) => {
    setState(prev => ({ ...prev, ...updates }))
  }, [])

  const STEP_KEYS = ['connection_type', 'identify', 'confirm', 'select_teams', 'collaboration_mode', 'request_rules'] as const

  // Handle discovery
  const handleCheckConnection = useCallback(async () => {
    updateState({ discoveryStage: 'validating', discoveryError: null })
    track('team_connector_discovery_started', {
      auth_type: state.authType,
      using_tunnel: state.tunnelRouteId !== null,
    })
    lastDiscoveryStageRef.current = null

    await discoverMutation.mutateAsync({
      input: {
        endpointUrl: state.endpointUrl,
        name: state.name,
        description: state.description,
        authType: state.authType,
        apiKey: state.authType === 'api_key' ? state.apiKey : undefined,
        bearerToken: state.authType === 'bearer_token' ? state.bearerToken : undefined,
        customHeaders: state.authType === 'custom_headers' ? state.customHeaders : undefined,
      },
      callbacks: {
        onProgress: (stage) => {
          if (lastDiscoveryStageRef.current !== stage) {
            lastDiscoveryStageRef.current = stage
            track('team_connector_discovery_stage_changed', { stage })
          }
          updateState({ discoveryStage: stage })
        },
        onComplete: (result) => {
          track('team_connector_discovery_completed', {
            capability_count: result.capabilities?.length ?? 0,
            resource_count: result.resources?.length ?? 0,
          })
          track('team_connector_step_completed', { step: 'identify', step_index: 1 })
          updateState({ discoveryResult: result, discoveryStage: null })
          setStep(2) // Move to confirm step
        },
        onError: (error) => {
          track('team_connector_discovery_failed', { reason: error.message })
          updateState({ discoveryError: error.message, discoveryStage: null })
          showToast(error.message, 'error')
        },
      },
    })
  }, [state, discoverMutation, updateState, showToast])

  // Handle final creation
  const handleCreateAgent = useCallback(async () => {
    if (!state.discoveryResult) {
      showToast('Discovery result not available', 'error')
      return
    }

    try {
      const created = await createMutation.mutateAsync({
        name: state.name,
        endpointUrl: state.endpointUrl,
        transportType: state.discoveryResult.transportType,
        description: state.description,
        connectionType: state.connectionType!,
        authType: state.authType,
        apiKey: state.authType === 'api_key' ? state.apiKey : undefined,
        bearerToken: state.authType === 'bearer_token' ? state.bearerToken : undefined,
        customHeaders: state.authType === 'custom_headers' ? state.customHeaders : undefined,
        collaborationMode: state.collaborationMode,
        allowedInternalAgentIds: Array.from(state.selectedTeamIds),
        requestRules: state.requestRules,
        summary: state.discoveryResult.summary,
        collaborationHints: state.discoveryResult.collaborationHints,
        detectedCapabilities: state.discoveryResult.capabilities,
        detectedResources: state.discoveryResult.resources,
        toolClassifications: state.discoveryResult.toolClassifications,
        toolEffectClasses: state.discoveryResult.toolEffectClasses,
        toolClassificationVersions: state.discoveryResult.toolClassificationVersions,
        rawMcpTools: state.discoveryResult.rawMcpTools,
        rawMcpResources: state.discoveryResult.rawMcpResources,
        discoveryCorrelationId: state.discoveryResult.correlationId,
        tunnelRouteId: state.tunnelRouteId ?? undefined,
      })

      track('team_connector_step_completed', { step: 'request_rules', step_index: 5 })
      track('agent_created', {
        agent_id: created.id,
        kind: 'external',
        transport_type: state.discoveryResult.transportType,
        connection_type: state.connectionType!,
        collaboration_mode: state.collaborationMode,
        allowed_teams_count: state.selectedTeamIds.size,
      })
      showToast('External agent connected successfully', 'success')
      onComplete?.()
      navigate('/dashboard/agents')
    } catch {
      showToast('Unable to connect external agent', 'error')
    }
  }, [state, createMutation, navigate, showToast, onComplete])

  // Navigation handlers
  const handleBack = () => {
    if (step === 0) {
      track('team_connector_canceled', { from_step: step })
      onCancel?.()
      navigate('/dashboard/agents')
    } else {
      setStep(step - 1)
    }
  }

  const handleContinue = () => {
    track('team_connector_step_completed', {
      step: STEP_KEYS[step],
      step_index: step as 0 | 1 | 2 | 3 | 4 | 5,
    })
    setStep(step + 1)
  }

  // Helper to get all teams as flat array
  const allTeams = teamsData?.pages?.flatMap(page => page.internalAgents) || []

  // Render current step
  const renderStep = () => {
    switch (step) {
      case 0:
        return (
          <ConnectionTypeStep
            onSelect={(type) => {
              track('team_connector_connection_type_selected', { connection_type: type })
              track('team_connector_step_completed', { step: 'connection_type', step_index: 0 })
              updateState({ connectionType: type })
              setStep(1)
            }}
          />
        )
      case 1:
        return (
          <IdentifyAgentStep
            state={state}
            updateState={updateState}
            onCheckConnection={handleCheckConnection}
            isLoading={discoverMutation.isPending}
          />
        )
      case 2:
        return (
          <ConfirmAgentStep
            state={state}
            onContinue={handleContinue}
            onCancel={handleBack}
          />
        )
      case 3:
        return (
          <SelectTeamsStep
            teams={allTeams}
            selectedIds={state.selectedTeamIds}
            onSelectionChange={(ids) => updateState({ selectedTeamIds: ids })}
            onContinue={handleContinue}
          />
        )
      case 4:
        return (
          <CollaborationModeStep
            mode={state.collaborationMode}
            onChange={(mode) => updateState({ collaborationMode: mode })}
            onContinue={handleContinue}
            teamCount={state.selectedTeamIds.size}
          />
        )
      case 5:
        return (
          <RequestRulesStep
            teams={allTeams.filter(t => state.selectedTeamIds.has(t.id))}
            rules={state.requestRules}
            onChange={(rules) => updateState({ requestRules: rules })}
            onConnect={handleCreateAgent}
            isLoading={createMutation.isPending}
          />
        )
      default:
        return null
    }
  }

  return (
    <div className="agent-connector">
      <BackButton onClick={handleBack} />
      <div className="agent-connector__content">
        {renderStep()}
      </div>
      {step === 0 && (
        <div className="agent-connector__bottom-links">
          <button
            type="button"
            className="agent-connector__bottom-link"
            onClick={() => navigate('/dashboard/agents/claudecode')}
          >
            Connect Claude Code
          </button>
          <button
            type="button"
            className="agent-connector__bottom-link"
            onClick={() => navigate('/dashboard/agents/codex')}
          >
            Connect OpenAI Codex
          </button>
        </div>
      )}
    </div>
  )
}
