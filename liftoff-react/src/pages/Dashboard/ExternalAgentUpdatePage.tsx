// External Agent Update Page
// Shows different UI than AgentUpdatePage - focused on external agent specifics

import { useEffect, useRef, useState } from 'react'
import { BackButton, Button, RollbackModal, Tooltip } from '../../components'
import { track } from '../../lib/analytics'
import {
  useExternalAgent,
  useUpdateExternalAgent,
  useRediscoverCapabilities,
  useExternalAgentVersions,
} from '../../hooks/useExternalAgents'
import { useToast } from '../../contexts/ToastContext'
import type { DiscoverStage } from '../../services/externalAgents'
import UndoIcon from '../../assets/icons/undo.svg?react'
import ChevronDownIcon from '../../assets/icons/chevron-down.svg?react'
import './ExternalAgentUpdatePage.css'

interface Props {
  agentId: string
  onSave: () => void
  onCancel: () => void
}

// Status badge colors
const STATUS_STYLES: Record<string, string> = {
  connected: 'external-agent-update__status--connected',
  pending: 'external-agent-update__status--pending',
  pending_review: 'external-agent-update__status--pending-review',
  disconnected: 'external-agent-update__status--disconnected',
  error: 'external-agent-update__status--error',
}

// Skeleton for loading state
function ExternalAgentUpdateSkeleton() {
  return (
    <div className="external-agent-update">
      <div className="external-agent-update__header">
        <div className="skeleton-text skeleton-pulse" style={{ width: '100px', height: '32px' }} />
        <div className="skeleton-text skeleton-pulse" style={{ width: '120px', height: '40px' }} />
      </div>
      <div className="external-agent-update__content">
        <div className="external-agent-update__section">
          <div className="skeleton-text skeleton-pulse" style={{ width: '150px', height: '24px', marginBottom: '12px' }} />
          <div className="skeleton-text skeleton-pulse" style={{ width: '100%', height: '48px' }} />
        </div>
        <div className="external-agent-update__section">
          <div className="skeleton-text skeleton-pulse" style={{ width: '200px', height: '24px', marginBottom: '12px' }} />
          <div className="skeleton-text skeleton-pulse" style={{ width: '100%', height: '120px' }} />
        </div>
      </div>
    </div>
  )
}

export default function ExternalAgentUpdatePage({ agentId, onSave, onCancel }: Props) {
  const { data: agent, isLoading, error, refetch } = useExternalAgent(agentId)
  const { data: versionsData } = useExternalAgentVersions(agentId)
  const updateMutation = useUpdateExternalAgent()
  const rediscoverMutation = useRediscoverCapabilities()
  const { showToast } = useToast()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [showRollbackModal, setShowRollbackModal] = useState(false)
  const [rediscoverStage, setRediscoverStage] = useState<DiscoverStage | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const viewedRef = useRef(false)

  // Seed the form from the agent, during render. The effect version painted
  // empty fields on the frame the agent arrived and filled them on the next.
  // Undefined to begin with, so an agent already in cache on the first
  // render still seeds the form. See ManageCustomMcpServerModal.
  const [seededAgent, setSeededAgent] = useState<typeof agent | undefined>(undefined)
  if (agent && agent !== seededAgent) {
    setSeededAgent(agent)
    setName(agent.name)
    setDescription(agent.description || '')
  }

  // Reporting the view is a side effect and stays one.
  useEffect(() => {
    if (!agent || viewedRef.current) return
    viewedRef.current = true
    track('external_agent_update_page_viewed', { agent_id: agent.id })
  }, [agent])

  const handleRediscover = async () => {
    track('team_update_external_rediscover_clicked', { agent_id: agentId })
    setRediscoverStage('validating')

    try {
      await rediscoverMutation.mutateAsync({
        agentId,
        callbacks: {
          onProgress: setRediscoverStage,
          onComplete: () => {
            setRediscoverStage(null)
            showToast('Capabilities rediscovered successfully', 'success')
            refetch()
          },
          onError: (error) => {
            setRediscoverStage(null)
            showToast(error.message, 'error')
          },
        },
      })
    } catch {
      // Surfaced via callbacks.onError; suppress so the mutation's onError
      // (not onSuccess) handles analytics for the failed stream.
    }
  }

  const handleSave = async () => {
    try {
      await updateMutation.mutateAsync({
        agentId,
        data: { name, description },
      })
      showToast('Changes saved successfully', 'success')
      onSave()
    } catch {
      showToast('Failed to save changes', 'error')
    }
  }

  if (isLoading) return <ExternalAgentUpdateSkeleton />

  if (error || !agent) {
    return (
      <div className="external-agent-update">
        <BackButton onClick={onCancel} />
        <div className="external-agent-update__error">
          <h2>Error loading collaborator</h2>
          <p>{error?.message || 'External agent not found'}</p>
          <Button variant="secondary" onClick={onCancel}>
            Go Back
          </Button>
        </div>
      </div>
    )
  }

  const statusLabel = agent.status.replace('_', ' ')

  return (
    <div className="external-agent-update">
      <BackButton onClick={onCancel} />

      <div className="external-agent-update__header">
        {/* Status badge */}
        <span className={`external-agent-update__status ${STATUS_STYLES[agent.status] || ''}`}>
          {statusLabel}
        </span>
        <div className="external-agent-update__header-actions">
          {versionsData && versionsData.versions.length > 1 && (
            <Tooltip text="Restore Previous Version">
              <button
                type="button"
                className="external-agent-update__rollback-btn"
                onClick={() => {
                  track('team_update_rollback_opened', { team_id: agent.id })
                  setShowRollbackModal(true)
                }}
              >
                <UndoIcon width="16" height="16" />
              </button>
            </Tooltip>
          )}
          <Button variant="primary" onClick={handleSave} loading={updateMutation.isPending}>
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

      <div className="external-agent-update__content">
        {/* Name */}
        <section className="external-agent-update__section">
          <h2 className="external-agent-update__section-title">Collaborator Name</h2>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="external-agent-update__input"
          />
        </section>

        {/* Description with Rediscover button */}
        <section className="external-agent-update__section">
          <div className="external-agent-update__section-header">
            <h2 className="external-agent-update__section-title">What does this external agent do?</h2>
            <Button
              variant="outline"
              onClick={handleRediscover}
              disabled={rediscoverMutation.isPending}
              size="sm"
            >
              {rediscoverStage ? `${rediscoverStage}...` : 'Rediscover Capabilities'}
            </Button>
          </div>

          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="external-agent-update__textarea"
            rows={4}
            placeholder="Describe what this external agent does..."
          />
        </section>

        {/* Detected Capabilities (read-only) */}
        <section className="external-agent-update__section">
          <h2 className="external-agent-update__section-title">
            Detected Capabilities ({agent.detectedCapabilities.length})
          </h2>
          <div className="external-agent-update__capabilities">
            {agent.detectedCapabilities.map(cap => (
              <div key={cap.id} className="external-agent-update__capability">
                <strong>{cap.name}</strong>
                <p>{cap.description}</p>
              </div>
            ))}
            {agent.detectedCapabilities.length === 0 && (
              <p className="external-agent-update__empty">No capabilities detected</p>
            )}
          </div>
        </section>

        {/* Summary (if available) */}
        {agent.summary && (
          <section className="external-agent-update__section">
            <h2 className="external-agent-update__section-title">Summary</h2>
            <div className="external-agent-update__summary">{agent.summary}</div>
          </section>
        )}

        {/* Collaboration Hints (if available) */}
        {agent.collaborationHints && (
          <section className="external-agent-update__section">
            <h2 className="external-agent-update__section-title">Collaboration Hints</h2>
            <div className="external-agent-update__summary">{agent.collaborationHints}</div>
          </section>
        )}

        {/* Capability Changes (if pending review) */}
        {agent.capabilityChanges && agent.capabilityChanges.length > 0 && (
          <section className="external-agent-update__section external-agent-update__section--warning">
            <h2 className="external-agent-update__section-title">Pending Capability Changes</h2>
            <p className="external-agent-update__warning-text">
              The following changes were detected during the last rediscovery and require review.
            </p>
            <div className="external-agent-update__changes">
              {agent.capabilityChanges.map((change, i) => (
                <div key={i} className={`external-agent-update__change external-agent-update__change--${change.type}`}>
                  <span className="external-agent-update__change-type">{change.type}</span>
                  <span className="external-agent-update__change-tool">{change.toolName}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Advanced Settings: Authentication */}
        <section className="external-agent-update__section external-agent-update__collapsible">
          <button
            type="button"
            className="external-agent-update__collapsible-header"
            onClick={() => {
              const next = !advancedOpen
              track('external_agent_update_advanced_toggled', { agent_id: agent.id, open: next })
              setAdvancedOpen(next)
            }}
          >
            <h2 className="external-agent-update__section-title">Advanced Settings</h2>
            <ChevronDownIcon
              className={`external-agent-update__collapsible-icon ${advancedOpen ? 'open' : ''}`}
              width="16"
              height="16"
            />
          </button>

          {advancedOpen && (
            <div className="external-agent-update__collapsible-content">
              <div className="external-agent-update__subsection">
                <h3>MCP Endpoint URL</h3>
                <p className="external-agent-update__endpoint">{agent.endpointUrl}</p>
              </div>

              <div className="external-agent-update__subsection">
                <h3>Authentication Type</h3>
                <p>{agent.authType === 'none' ? 'No authentication' : agent.authType.replace('_', ' ')}</p>
              </div>

              <div className="external-agent-update__subsection">
                <h3>Collaboration Mode</h3>
                <p>{agent.collaborationMode.replace('_', ' ')}</p>
              </div>

              <div className="external-agent-update__subsection">
                <h3>Allowed Teams</h3>
                <p>{(agent.allowedInternalAgentIds || []).length} team(s)</p>
              </div>

              <div className="external-agent-update__subsection">
                <h3>Version</h3>
                <p>v{agent.currentVersion}</p>
              </div>

              {agent.tunnelRouteId && (
                <div className="external-agent-update__subsection">
                  <h3>Delivery</h3>
                  <p>Behind a tunnel</p>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
