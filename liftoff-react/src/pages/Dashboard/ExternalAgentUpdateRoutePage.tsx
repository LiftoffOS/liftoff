import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import ExternalAgentUpdatePage from './ExternalAgentUpdatePage'
import { useToast } from '../../contexts/ToastContext'

interface LocationState {
  agentId?: string
}

export default function ExternalAgentUpdateRoutePage() {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { showToast } = useToast()

  const state = location.state as LocationState | null
  const agentId = state?.agentId

  // Redirect if no agent ID in state (direct URL access or bookmark)
  useEffect(() => {
    if (!agentId) {
      navigate('/dashboard/agents', { replace: true })
    }
  }, [agentId, navigate])

  const handleSave = () => {
    queryClient.invalidateQueries({ queryKey: ['external-agents'] })
    showToast('External agent updated', 'success')
    navigate('/dashboard/agents')
  }

  const handleCancel = () => {
    navigate('/dashboard/agents')
  }

  // Don't render until we confirm we have an agent ID
  if (!agentId) {
    return null
  }

  return <ExternalAgentUpdatePage agentId={agentId} onSave={handleSave} onCancel={handleCancel} />
}
