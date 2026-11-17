// External Agent Selector Component
// Displays a list of available external agents for selection
// Used in AgentBuilder's IntegrationsStep

import ExternalAgentChip from './ExternalAgentChip'
import type { ExternalAgent } from '../services/externalAgents'
import './ExternalAgentSelector.css'

interface ExternalAgentSelectorProps {
  available: ExternalAgent[]
  selected: string[]
  onChange: (selected: string[]) => void
}

export default function ExternalAgentSelector({
  available,
  selected,
  onChange,
}: ExternalAgentSelectorProps) {
  const handleToggle = (agentId: string) => {
    if (selected.includes(agentId)) {
      onChange(selected.filter(id => id !== agentId))
    } else {
      onChange([...selected, agentId])
    }
  }

  // Filter to only show connected agents
  const connectedAgents = available.filter(a => a.status === 'connected')

  if (connectedAgents.length === 0) {
    return (
      <div className="external-agent-selector external-agent-selector--empty">
        <p className="external-agent-selector__empty-text">
          No external agents available.
        </p>
      </div>
    )
  }

  return (
    <div className="external-agent-selector">
      <div className="external-agent-selector__list">
        {connectedAgents.map(agent => (
          <ExternalAgentChip
            key={agent.id}
            agent={agent}
            selected={selected.includes(agent.id)}
            onToggle={() => handleToggle(agent.id)}
          />
        ))}
      </div>
      {selected.length > 0 && (
        <p className="external-agent-selector__count">
          {selected.length} collaborator{selected.length !== 1 ? 's' : ''} selected
        </p>
      )}
    </div>
  )
}
