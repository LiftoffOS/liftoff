import { Button, SelectableAgentCard } from '../../../../components'
import type { InternalAgent } from '../../../../services/internalAgents'

interface Props {
  teams: InternalAgent[]
  selectedIds: Set<string>
  onSelectionChange: (ids: Set<string>) => void
  onContinue: () => void
}

export default function SelectTeamsStep({ teams, selectedIds, onSelectionChange, onContinue }: Props) {
  const handleToggle = (teamId: string) => {
    const newSet = new Set(selectedIds)
    if (newSet.has(teamId)) {
      newSet.delete(teamId)
    } else {
      newSet.add(teamId)
    }
    onSelectionChange(newSet)
  }

  const handleSelectAll = () => {
    if (selectedIds.size === teams.length) {
      onSelectionChange(new Set())
    } else {
      onSelectionChange(new Set(teams.map(t => t.id)))
    }
  }

  return (
    <div className="agent-connector-step">
      <h1 className="agent-connector-step__header">Who can this external agent work with?</h1>

      {teams.length > 1 && (
        <button
          type="button"
          className="agent-connector-nav__text-btn"
          onClick={handleSelectAll}
          style={{ alignSelf: 'flex-end' }}
        >
          {selectedIds.size === teams.length ? 'Deselect All' : 'Select All'}
        </button>
      )}

      <div className="agent-connector__team-list">
        {teams.map(team => (
          <SelectableAgentCard
            key={team.id}
            team={team}
            selected={selectedIds.has(team.id)}
            onToggle={handleToggle}
          />
        ))}
      </div>

      {teams.length === 0 && (
        <p style={{ color: 'var(--color-gray-400)', fontSize: 'var(--text-sm)' }}>
          No teams found. Create a team first to enable collaboration.
        </p>
      )}

      <div className="agent-connector-nav">
        <Button variant="primary" onClick={onContinue} disabled={selectedIds.size === 0}>
          Continue
        </Button>
      </div>
    </div>
  )
}
