// Choose which local setup to move across.
//
// Built from the AgentConnector shell that /dashboard/agents/connect uses, so the
// two read as the same kind of decision: same visual, same header and subtext
// scale, same stacked actions. The wizard for each source lives one level down
// at /dashboard/switch/<source>.

import { useNavigate } from 'react-router'
import { BackButton, Button } from '../../../components'
import { track } from '../../../lib/analytics'
import type { MigrationSource } from '../../../services/sourceMigrations'
import PeopleIcon from '../../../assets/icons/people.svg?react'
import '../AgentConnector/AgentConnector.css'
import './SwitchWizard.css'

export default function SwitchLanding() {
  const navigate = useNavigate()

  const open = (source: MigrationSource) => {
    track('switch_source_selected', { source })
    navigate(`/dashboard/switch/${source}`)
  }

  return (
    <div className="agent-connector switch-wizard">
      {/* Explore is where the entry point to this page lives, so back returns
          there rather than to the teams list. */}
      <BackButton onClick={() => navigate('/dashboard/agents/explore')} />

      <div className="agent-connector__content">
        <div className="agent-connector-step">
          <div className="agent-connector__visual">
            <div className="agent-connector__team agent-connector__team--left">
              <PeopleIcon />
            </div>
            <div className="agent-connector__line" />
            <div className="agent-connector__line agent-connector__line--delayed" />
            <div className="agent-connector__line agent-connector__line--delayed-2" />
            <div className="agent-connector__team agent-connector__team--right">
              <PeopleIcon />
            </div>
          </div>

          <div className="agent-connector-step__text">
            <h1 className="agent-connector-step__header">Move Your Local AI Setup to Liftoff</h1>
            <p className="agent-connector-step__subtext">
              Liftoff can import your current local setup, so all your existing workflows can run
              better with an always-on cloud.
            </p>
          </div>

          <div className="agent-connector-step__actions">
            <Button variant="outline" onClick={() => open('openclaw')}>
              OpenClaw
            </Button>
            <Button variant="outline" onClick={() => open('hermes')}>
              Hermes
            </Button>
            <Button variant="outline" onClick={() => open('claude-code')}>
              Claude Code
            </Button>
            <Button variant="outline" onClick={() => open('codex')}>
              Codex
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
