import { getIntegrationIcon } from './icons/integrationIconRegistry'
import type { InternalAgent } from '../services/internalAgents'
import { useConnectorLookup } from '../hooks/useConnectorLookup'
import CheckIcon from '../assets/icons/check.svg?react'
import './SelectableAgentCard.css'

interface SelectableTeamCardProps {
  team: InternalAgent
  selected: boolean
  onToggle: (teamId: string) => void
  disabled?: boolean
  showCost?: boolean
}

export function SelectableAgentCard({ team, selected, onToggle, disabled, showCost }: SelectableTeamCardProps) {
  const resolveConnector = useConnectorLookup()
  const displayText = team.summary || team.responsibilities

  return (
    <div
      className={`selectable-agent-card ${selected ? 'selectable-agent-card--selected' : ''} ${disabled ? 'selectable-agent-card--disabled' : ''}`}
      role="checkbox"
      aria-checked={selected}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onClick={() => !disabled && onToggle(team.id)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          if (!disabled) onToggle(team.id)
        }
      }}
    >
      <div className="selectable-agent-card__checkbox">
        {selected && (
          <CheckIcon />
        )}
      </div>
      <div className="selectable-agent-card__content">
        <h3 className="selectable-agent-card__name">{team.role}</h3>
        <p className="selectable-agent-card__description">{displayText}</p>
        {team.integrations && team.integrations.length > 0 && (
          <div className="selectable-agent-card__integrations">
            {team.integrations.slice(0, 4).map((integration) => {
              // Use stable integrationId when available, fall back to connector UUID lookup
              const integrationId = integration.integrationId
                ? integration.integrationId
                : resolveConnector(integration.id)?.integrationId
              return (
                <span key={integration.id} className="selectable-agent-card__integration">
                  {getIntegrationIcon(integrationId || '')}
                </span>
              )
            })}
            {team.integrations.length > 4 && (
              <span className="selectable-agent-card__integration-more">+{team.integrations.length - 4}</span>
            )}
          </div>
        )}
      </div>
      {showCost && (
        <div className="selectable-agent-card__meta">
          <span className="selectable-agent-card__cost">${team.monthlyCost}/month</span>
        </div>
      )}
    </div>
  )
}
