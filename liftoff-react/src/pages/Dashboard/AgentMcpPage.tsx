// AgentMcpPage — connect a coding agent (Claude Code, OpenAI Codex, any MCP
// client) to this workspace. Route: /dashboard/agents/mcp
//
// Same layout as the ClaudeCodeConnector setup state (visual → header →
// subtext → command block). The copyable text is a single tool-agnostic
// setup prompt: the user pastes it into their coding agent, which fetches
// the Liftoff skill (platform-backend /SKILL.md), registers the MCP server,
// installs the skill into its own skill directories, and triggers the
// browser sign-in (ADR-032).

import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { track } from '../../lib/analytics'
import { agentSetupCommand } from '../../lib/cliEnv'
import { useToast } from '../../contexts/ToastContext'
import { BackButton } from '../../components'
import CopyIcon from '../../assets/icons/copy.svg?react'
import PeopleIcon from '../../assets/icons/people.svg?react'
import ClaudeIcon from '../../assets/icons/claude.svg?react'
import OpenAIIcon from '../../assets/icons/openai.svg?react'
import './AgentConnector/AgentConnector.css'
import './ClaudeCodeConnector/ClaudeCodeConnector.css'
import './AgentMcpPage.css'


export default function AgentMcpPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { showToast } = useToast()

  const state = (location.state ?? {}) as { agentId?: string; agentName?: string }
  // The one copyable line a coding tool needs.
  const SETUP_PROMPT = agentSetupCommand()

  const viewedRef = useRef(false)
  useEffect(() => {
    if (viewedRef.current) return
    viewedRef.current = true
    track('mcp_setup_viewed', { agent_id: state.agentId ?? null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleCopy = () => {
    navigator.clipboard.writeText(SETUP_PROMPT)
    track('mcp_command_copied', { command: 'setup_prompt' })
    showToast('Copied to clipboard', 'success')
  }

  return (
    <div className="agent-connector claude-code-connector team-mcp-page">
      <BackButton onClick={() => navigate(-1)} />
      <div className="agent-connector__content">
        <div className="agent-connector-step">
          <div className="agent-connector__visual">
            <div className="agent-connector__team agent-connector__team--left team-mcp-page__tools">
              <ClaudeIcon />
              <OpenAIIcon className="team-mcp-page__openai-mark" />
            </div>
            <div className="agent-connector__line" />
            <div className="agent-connector__line agent-connector__line--delayed" />
            <div className="agent-connector__line agent-connector__line--delayed-2" />
            <div className="agent-connector__team agent-connector__team--right">
              <PeopleIcon />
            </div>
          </div>

          <div className="agent-connector-step__text">
            <h1 className="agent-connector-step__header">Add to AI Coding Tool</h1>
            <p className="agent-connector-step__subtext">
              Copy this setup prompt below for your AI coding tool.
            </p>
          </div>

          <div className="agent-connector-step__actions">
            <div className="claude-code-connector__command">
              <code className="settings-section__code">{SETUP_PROMPT}</code>
              <button
                className="settings-section__copy"
                onClick={handleCopy}
                aria-label="Copy setup prompt"
              >
                <CopyIcon width="16" height="16" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
