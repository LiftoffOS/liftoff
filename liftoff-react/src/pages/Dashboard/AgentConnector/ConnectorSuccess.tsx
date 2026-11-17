import { useNavigate } from 'react-router'
import { Button } from '../../../components'
import { track } from '../../../lib/analytics'
import type { AnalyticsEventName } from '../../../lib/analytics-events'
import PeopleIcon from '../../../assets/icons/people.svg?react'
import ClaudeIcon from '../../../assets/icons/claude.svg?react'
import OpenAIIcon from '../../../assets/icons/openai.svg?react'
// Base layout (icon sizing, lines) MUST be imported here: this page is loaded
// directly by the CLI's post-auth redirect, so it can't rely on the connector
// page's chunk having pulled AgentConnector.css in first.
import './AgentConnector.css'
import '../ClaudeCodeConnector/ClaudeCodeConnector.css'
import '../CodexConnector/CodexConnector.css'

type Client = 'claude' | 'codex'

const CLIENTS: Record<Client, {
  wrapperClass: string
  Icon: typeof PeopleIcon
  title: string
  event: Extract<AnalyticsEventName, 'claude_code_success_continue_clicked' | 'codex_success_continue_clicked'>
}> = {
  claude: {
    wrapperClass: 'claude-code-connector',
    Icon: ClaudeIcon,
    title: 'Claude Code Connected',
    event: 'claude_code_success_continue_clicked',
  },
  codex: {
    wrapperClass: 'codex-connector',
    Icon: OpenAIIcon,
    title: 'Codex Connected',
    event: 'codex_success_continue_clicked',
  },
}

export default function ConnectorSuccess({ client }: { client: Client }) {
  const navigate = useNavigate()
  const c = CLIENTS[client]
  const Icon = c.Icon

  return (
    <div className={`agent-connector ${c.wrapperClass}`}>
      <div className="agent-connector__content">
        <div className="agent-connector-step">
          <div className="agent-connector__visual">
            <div className="agent-connector__team agent-connector__team--left">
              <Icon />
            </div>
            <div className="agent-connector__line" />
            <div className="agent-connector__line agent-connector__line--delayed" />
            <div className="agent-connector__line agent-connector__line--delayed-2" />
            <div className="agent-connector__team agent-connector__team--right">
              <PeopleIcon />
            </div>
          </div>

          <div className="agent-connector-step__text">
            <h1 className="agent-connector-step__header">{c.title}</h1>
            <p className="agent-connector-step__subtext">
              You can close this tab and return to your terminal.
            </p>
          </div>

          <div className="agent-connector-step__actions">
            <Button variant="primary" onClick={() => {
              track(c.event, {})
              navigate('/dashboard')
            }}>
              Go Home
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
