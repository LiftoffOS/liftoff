import { Button } from '../../../../components'
import type { ConnectionType } from '../../../../services/externalAgents'
import PeopleIcon from '../../../../assets/icons/people.svg?react'

interface Props {
  onSelect: (type: ConnectionType) => void
}

export default function ConnectionTypeStep({ onSelect }: Props) {
  return (
    <div className="agent-connector-step">
      <div className="agent-connector__visual">
        {/* Left team */}
        <div className="agent-connector__team agent-connector__team--left">
          <PeopleIcon />
        </div>
        {/* Connection packets */}
        <div className="agent-connector__line" />
        <div className="agent-connector__line agent-connector__line--delayed" />
        <div className="agent-connector__line agent-connector__line--delayed-2" />
        {/* Right team (external) */}
        <div className="agent-connector__team agent-connector__team--right">
          <PeopleIcon />
        </div>
      </div>

      <div className="agent-connector-step__text">
        <h1 className="agent-connector-step__header">Connect External Agent</h1>
        <p className="agent-connector-step__subtext">
          Bring it into your workspace so it can work alongside your agents and support ongoing work.
        </p>
      </div>

      <div className="agent-connector-step__actions">
        <Button variant="primary" onClick={() => onSelect('automatic')}>
          Connect Automatically
        </Button>
        <Button variant="outline" onClick={() => onSelect('custom')}>
          Custom Connection
        </Button>
      </div>

    </div>
  )
}
