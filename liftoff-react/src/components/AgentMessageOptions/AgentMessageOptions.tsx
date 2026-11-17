// AgentMessageOptions — the "ways to talk to this team" cards.
//
// Rendered by MorePane, the chat page's right pane. These used to be a page of
// their own at /dashboard/agents/message, whose fourth card offered to open the
// very chat this now sits inside; the page went away with that card.
//
// The agent is passed in rather than fetched here: the caller already holds
// it, and a second fetch buys nothing.

import { useNavigate } from 'react-router'
import { Button } from '../index'
import { track } from '../../lib/analytics'
import { useTenant } from '../../hooks/useTenant'
import { useIntegrationConnect } from '../../hooks/useIntegrationConnect'
import { getTeamsConnectUrl } from '../../services/agentChat'
import { SlackIcon, MicrosoftTeamsIcon } from '../icons/IntegrationIcons'
import ClaudeIcon from '../../assets/icons/claude.svg?react'
import OpenAIIcon from '../../assets/icons/openai.svg?react'
import './AgentMessageOptions.css'

interface TeamMessageOptionsProps {
  /** The agent, when there is one. The platform assistants have none; the
   *  id only feeds analytics and the MCP page's router state, and both
   *  tolerate its absence. */
  agentId?: string
  /** Display name already resolved by the caller. */
  agentName: string
  /** Nickname used in the "@Liftoff anywhere" copy; falls back to agentName. */
  nickname?: string
}

export default function AgentMessageOptions({
  agentId,
  agentName,
  nickname,
}: TeamMessageOptionsProps) {
  const navigate = useNavigate()
  const { currentTenant: tenant } = useTenant()
  const tenantId = tenant?.id
  // Connecting the Slack connector ALSO installs the Liftoff app's bot (one
  // OAuth, dual grant) — same flow as the Connections page.
  const { connect: connectIntegration, connecting: slackConnecting } = useIntegrationConnect()

  const mentionName = nickname ?? agentName

  return (
    <>
      {/* Slack card */}
      <div className="agent-message-options__card">
        <div className="agent-message-options__card-row">
          <div className="agent-message-options__card-info">
            <span className="agent-message-options__card-icon">
              <SlackIcon />
            </span>
            <span className="agent-message-options__card-label">Add to Slack</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={slackConnecting}
            onClick={() => {
              track('team_message_action_clicked', {})
              void connectIntegration('slack')
            }}
          >
            Set Up
          </Button>
        </div>
        <p className="agent-message-options__card-description">
          Your team can use @Liftoff anywhere to chat with {mentionName} directly, just like your coworkers.
        </p>
      </div>

      {/* Microsoft Teams card */}
      <div className="agent-message-options__card">
        <div className="agent-message-options__card-row">
          <div className="agent-message-options__card-info">
            <span className="agent-message-options__card-icon">
              <MicrosoftTeamsIcon />
            </span>
            <span className="team-message-options__card-label">Add to Microsoft Teams</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              track('team_message_action_clicked', {})
              if (!tenantId) return
              try {
                const { url } = await getTeamsConnectUrl(tenantId)
                if (url) window.open(url, '_blank', 'noopener')
              } catch {
                // Will retry on next click
              }
            }}
          >
            Set Up
          </Button>
        </div>
        <p className="agent-message-options__card-description">
          Your team can use @Liftoff anywhere to chat with {mentionName} directly, just like your coworkers.
        </p>
      </div>

      {/* MCP card — Claude Code / OpenAI Codex (ADR-032) */}
      <div className="agent-message-options__card">
        <div className="agent-message-options__card-row">
          <div className="agent-message-options__card-info">
            <span className="agent-message-options__card-icon">
              <ClaudeIcon width="18" height="18" />
            </span>
            <span className="agent-message-options__card-icon agent-message-options__card-icon--brand">
              <OpenAIIcon width="18" height="18" />
            </span>
            <span className="agent-message-options__card-label">Add to AI Coding Tool</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              track('team_mcp_setup_clicked', { agent_id: agentId ?? null })
              navigate('/dashboard/agents/mcp', { state: { agentId, agentName } })
            }}
          >
            Set Up
          </Button>
        </div>
        <p className="agent-message-options__card-description">
          You can use your AI coding tool to interact with {agentName} through MCP.
        </p>
      </div>
    </>
  )
}
