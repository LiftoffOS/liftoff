import { Button } from '../../../../components'
import { type CollaborationMode } from '../../../../services/externalAgents'

interface Props {
  mode: CollaborationMode
  onChange: (mode: CollaborationMode) => void
  onContinue: () => void
  teamCount: number
}

const MODES: CollaborationMode[] = [
  'two_way',
  'request_help',
  'receive_delegated',
  'observe_only',
]

function getCollaborationModeLabel(mode: CollaborationMode, teamCount: number): { title: string; description: string } {
  const teamWord = teamCount === 1 ? 'team' : 'teams'

  const labels: Record<CollaborationMode, { title: string; description: string }> = {
    request_help: {
      title: 'Request help',
      description: `The external agent can ask your AI ${teamWord} to perform work.`,
    },
    receive_delegated: {
      title: 'Receive delegated work',
      description: `Your AI ${teamWord} can send tasks to the external agent.`,
    },
    two_way: {
      title: 'Two-way collaboration',
      description: 'Both sides can exchange tasks and outputs.',
    },
    observe_only: {
      title: 'Observe only',
      description: 'The external agent can receive status and summaries, but cannot initiate actions.',
    },
  }

  return labels[mode]
}

export default function CollaborationModeStep({ mode, onChange, onContinue, teamCount }: Props) {
  return (
    <div className="agent-connector-step">
      <h1 className="agent-connector-step__header">How should they collaborate?</h1>

      <div className="agent-connector__mode-options">
        {MODES.map((m) => {
          const label = getCollaborationModeLabel(m, teamCount)
          const isSelected = mode === m

          return (
            <button
              key={m}
              type="button"
              className={`agent-connector__mode-option ${isSelected ? 'agent-connector__mode-option--selected' : ''}`}
              onClick={() => onChange(m)}
            >
              <span className="agent-connector__mode-label">{label.title}</span>
              <span className="agent-connector__mode-description">{label.description}</span>
            </button>
          )
        })}
      </div>

      <div className="agent-connector-nav">
        <Button variant="primary" onClick={onContinue}>
          Continue
        </Button>
      </div>
    </div>
  )
}
