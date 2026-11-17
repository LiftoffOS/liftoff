import { useState } from 'react'
import { useNavigate } from 'react-router'
import ModalOverlay from './ModalOverlay'
import ModalActions from './ModalActions/ModalActions'
import Button from './Button'
import { Dropdown } from './Dropdown'
import { useRollbackInternalAgent, useInternalAgentVersions } from '../hooks/useInternalAgents'
import { useRollbackExternalAgent, useExternalAgentVersions } from '../hooks/useExternalAgents'
import { useToast } from '../contexts/ToastContext'
import './RollbackModal.css'

type EntityType = 'team' | 'external-agent'

interface RollbackModalProps {
  entityType: EntityType
  entityId: string
  currentVersion: number
  onClose: () => void
  onRollback?: () => void
}

// Legacy props for backwards compatibility
interface LegacyRollbackModalProps {
  teamId: string
  currentVersion: number
  onClose: () => void
}

function formatVersionDate(dateString: string): string {
  const date = new Date(dateString)
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export default function RollbackModal(props: RollbackModalProps | LegacyRollbackModalProps) {
  // Handle legacy props
  const entityType: EntityType = 'entityType' in props ? props.entityType : 'team'
  const entityId = 'entityId' in props ? props.entityId : (props as LegacyRollbackModalProps).teamId
  const { currentVersion, onClose } = props
  const onRollback = 'onRollback' in props ? props.onRollback : undefined

  const navigate = useNavigate()
  const { showToast } = useToast()

  // Use appropriate hooks based on entity type
  const internalAgentVersionsQuery = useInternalAgentVersions(entityType === 'team' ? entityId : '')
  const externalAgentVersionsQuery = useExternalAgentVersions(entityType === 'external-agent' ? entityId : '')
  const internalAgentRollbackMutation = useRollbackInternalAgent()
  const externalAgentRollbackMutation = useRollbackExternalAgent()

  const versionsData = entityType === 'team' ? internalAgentVersionsQuery.data : externalAgentVersionsQuery.data
  const versionsLoading = entityType === 'team' ? internalAgentVersionsQuery.isLoading : externalAgentVersionsQuery.isLoading
  const rollbackMutation = entityType === 'team' ? internalAgentRollbackMutation : externalAgentRollbackMutation

  // Filter out current version and sort by version number descending
  const availableVersions = (versionsData?.versions ?? [])
    .filter(v => v.version !== currentVersion)
    .sort((a, b) => b.version - a.version)

  const [selectedVersion, setSelectedVersion] = useState<number | null>(null)

  const handleConfirm = () => {
    if (selectedVersion === null) return

    const onSuccessCallback = () => {
      showToast('Successfully rolled back to version ' + selectedVersion, 'success')
      if (onRollback) {
        onRollback()
      } else {
        navigate('/dashboard/agents')
      }
    }

    const onErrorCallback = (error: Error) => {
      showToast(
        error instanceof Error ? error.message : 'Failed to rollback',
        'error'
      )
    }

    if (entityType === 'team') {
      internalAgentRollbackMutation.mutate(
        { internalAgentId: entityId, version: selectedVersion },
        { onSuccess: onSuccessCallback, onError: onErrorCallback }
      )
    } else {
      externalAgentRollbackMutation.mutate(
        { agentId: entityId, version: selectedVersion },
        { onSuccess: onSuccessCallback, onError: onErrorCallback }
      )
    }
  }

  const isConfirmDisabled = selectedVersion === null || rollbackMutation.isPending

  const entityLabel = entityType === 'team' ? 'team' : 'collaborator'

  return (
    <ModalOverlay onClose={onClose} disableClose={rollbackMutation.isPending}>
      <div className="rollback-modal">
        <h2 className="rollback-modal__title">Restore previous version</h2>
        <p className="rollback-modal__description">
          Select a previous version to restore. This will create a new version of this {entityLabel} with the selected settings.
        </p>

        {versionsLoading ? (
          <div className="rollback-modal__loading">
            <div className="loading-spinner" role="status" aria-label="Loading versions" />
          </div>
        ) : availableVersions.length === 0 ? (
          <div className="rollback-modal__empty">No previous versions available.</div>
        ) : (
          <div className="rollback-modal__field">
            <Dropdown
              value={selectedVersion?.toString() ?? ''}
              onChange={(value) => setSelectedVersion(value ? parseInt(value, 10) : null)}
              disabled={rollbackMutation.isPending}
              options={[
                { value: '', label: 'Select a version...' },
                ...availableVersions.map((version) => ({
                  value: version.version.toString(),
                  label: `v${version.version} — ${formatVersionDate(version.createdAt)}`,
                })),
              ]}
            />
          </div>
        )}

        <ModalActions>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={rollbackMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            disabled={isConfirmDisabled}
          >
            {rollbackMutation.isPending ? 'Rolling back...' : 'Confirm'}
          </Button>
        </ModalActions>
      </div>
    </ModalOverlay>
  )
}
