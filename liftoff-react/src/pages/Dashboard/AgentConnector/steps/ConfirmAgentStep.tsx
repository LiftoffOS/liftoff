import { Button } from '../../../../components'
import type { DiscoverOutput } from '../../../../services/externalAgents'

interface Props {
  state: {
    name: string
    endpointUrl: string
    discoveryResult: DiscoverOutput | null
  }
  onContinue: () => void
  onCancel: () => void
}

export default function ConfirmAgentStep({ state, onContinue, onCancel }: Props) {
  const { discoveryResult } = state

  if (!discoveryResult) {
    return (
      <div className="agent-connector-step">
        <h1 className="agent-connector-step__header">No Discovery Results</h1>
        <p className="agent-connector-step__subtext">
          Could not discover capabilities from this agent.
        </p>
        <div className="agent-connector-nav">
          <Button variant="secondary" onClick={onCancel}>
            Go Back
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="agent-connector-step">
      <h1 className="agent-connector-step__header">We found {state.name}</h1>
      <p className="agent-connector-step__subtext">
        Here's what we discovered about this collaborator's capabilities.
      </p>

      <div className="agent-connector__confirm-section">
        <div className="agent-connector__confirm-label">Summary</div>
        <div className="agent-connector__summary-text">
          {discoveryResult.summary}
        </div>
      </div>

      <div className="agent-connector__confirm-section">
        <div className="agent-connector__confirm-label">
          Capabilities ({discoveryResult.capabilities.length})
        </div>
        <div className="agent-connector__capabilities-list">
          {discoveryResult.capabilities.map((cap) => (
            <div key={cap.id} className="agent-connector__capability">
              <div className="agent-connector__capability-name">{cap.name}</div>
              <div className="agent-connector__capability-description">
                {cap.description}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="agent-connector-nav">
        <Button variant="secondary" onClick={onCancel}>
          Go Back
        </Button>
        <Button variant="primary" onClick={onContinue}>
          Continue
        </Button>
      </div>
    </div>
  )
}
