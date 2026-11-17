import { useNavigate } from 'react-router'
import ClaudeCodeConnector from './ClaudeCodeConnector/ClaudeCodeConnector'

export default function AgentClaudeCodePage() {
  const navigate = useNavigate()

  return (
    <ClaudeCodeConnector
      onCancel={() => navigate('/dashboard/agents/connect')}
    />
  )
}
