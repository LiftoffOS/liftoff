// External Agent Chip Component
// Displays an external agent as a selectable chip in the AgentBuilder's IntegrationsStep
// Follows the same pattern as integration chips

import type { ExternalAgent } from '../services/externalAgents'
import CubeIcon from '../assets/icons/cube.svg?react'
import CheckIcon from '../assets/icons/check.svg?react'
import './ExternalAgentChip.css'

interface ExternalAgentChipProps {
  agent: ExternalAgent
  selected: boolean
  onToggle: () => void
}

export default function ExternalAgentChip({ agent, selected, onToggle }: ExternalAgentChipProps) {
  return (
    <button
      type="button"
      className={`external-agent-chip ${selected ? 'external-agent-chip--selected' : ''}`}
      onClick={onToggle}
    >
      <div className="external-agent-chip__icon">
        <CubeIcon />
      </div>
      <div className="external-agent-chip__content">
        <span className="external-agent-chip__name">{agent.name}</span>
        {agent.status !== 'connected' && (
          <span className={`external-agent-chip__status external-agent-chip__status--${agent.status}`}>
            {agent.status.replace('_', ' ')}
          </span>
        )}
      </div>
      <div className="external-agent-chip__check">
        {selected && (
          <CheckIcon />
        )}
      </div>
    </button>
  )
}
