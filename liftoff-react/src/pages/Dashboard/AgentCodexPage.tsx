import { useNavigate } from 'react-router'
import CodexConnector from './CodexConnector/CodexConnector'

export default function AgentCodexPage() {
  const navigate = useNavigate()

  return (
    <CodexConnector
      onCancel={() => navigate('/dashboard/agents/connect')}
    />
  )
}
