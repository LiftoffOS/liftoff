import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import AgentUpdatePage from './AgentUpdatePage'
import { useToast } from '../../contexts/ToastContext'
import { useTenant } from '../../hooks/useTenant'
import { WORKFORCE_QUERY_KEY } from '../../hooks/useWorkforce'

interface LocationState {
  teamId?: string
  agentId?: string
  codingToolId?: string
}

export default function AgentUpdateRoutePage() {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { showToast } = useToast()
  const { currentTenant } = useTenant()

  const state = location.state as LocationState | null
  const teamId = state?.teamId
  const agentId = state?.agentId
  const codingToolId = state?.codingToolId

  // Redirect if no ID in state (direct URL access or bookmark)
  useEffect(() => {
    if (!teamId && !agentId && !codingToolId) {
      navigate('/dashboard/agents', { replace: true })
    }
  }, [teamId, agentId, codingToolId, navigate])

  const handleSave = () => {
    // Tenant-scoped invalidation — invalidating the broad keys would also
    // mark every other workspace's cached lists stale.
    if (codingToolId) {
      queryClient.invalidateQueries({ queryKey: [...WORKFORCE_QUERY_KEY, currentTenant?.id ?? ''] })
    } else if (agentId) {
      queryClient.invalidateQueries({ queryKey: ['external-agents', currentTenant?.id] })
    } else {
      queryClient.invalidateQueries({ queryKey: ['teams', currentTenant?.id] })
    }
    showToast('Team updated successfully', 'success')
    navigate('/dashboard/agents')
  }

  const handleCancel = () => {
    navigate('/dashboard/agents')
  }

  if (!teamId && !agentId && !codingToolId) {
    return null
  }

  return <AgentUpdatePage teamId={teamId} agentId={agentId} codingToolId={codingToolId} onSave={handleSave} onCancel={handleCancel} />
}
