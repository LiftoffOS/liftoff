import { useNavigate } from 'react-router'
import AgentConnector from './AgentConnector/AgentConnector'
// AgentConnector's IdentifyAgentStep uses the shared .connection-modal__* styles.
import '../../components/connectionModals.css'

export default function AgentConnectPage() {
  const navigate = useNavigate()

  return (
    <AgentConnector
      onComplete={() => navigate('/dashboard/agents')}
      onCancel={() => navigate('/dashboard/agents')}
    />
  )
}
