import { useEffect, useRef, useState } from 'react'
import { BackButton, Button } from '../../../components'
import { track } from '../../../lib/analytics'
import { useToast } from '../../../contexts/ToastContext'
import { useAuth } from '../../../contexts/AuthContext'
import { useCreateClaudeCodeProxyKey } from '../../../hooks/useClaudeCodeProxy'
import { cliSetupCommand } from '../../../lib/cliEnv'
import CopyIcon from '../../../assets/icons/copy.svg?react'
import PeopleIcon from '../../../assets/icons/people.svg?react'
import ClaudeIcon from '../../../assets/icons/claude.svg?react'
// Base layout (icon sizing, connect lines) — import here so the page styles
// correctly on a cold/direct load, not only when navigated to in-app.
import '../AgentConnector/AgentConnector.css'
import './ClaudeCodeConnector.css'
import { useAutoFocus } from '../../../hooks/useAutoFocus'

interface ClaudeCodeConnectorProps {
  onCancel?: () => void
}

const SETUP_COMMAND = cliSetupCommand('setup')

export default function ClaudeCodeConnector({ onCancel }: ClaudeCodeConnectorProps) {
  const keyRef = useAutoFocus<HTMLInputElement>()
  const { showToast } = useToast()
  const { currentTenant, account } = useAuth()
  const createKeyMutation = useCreateClaudeCodeProxyKey()

  const [anthropicApiKey, setAnthropicApiKey] = useState('')
  const [setupReady, setSetupReady] = useState(false)
  const viewedRef = useRef(false)
  useEffect(() => {
    if (viewedRef.current) return
    viewedRef.current = true
    track('claude_code_connector_viewed', {})
  }, [])

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text)
    if (text.includes('npx')) track('claude_code_npx_command_copied', {})
    showToast('Copied to clipboard', 'success')
  }

  const handleConnect = async () => {
    if (!anthropicApiKey.trim() || !currentTenant?.id) return

    try {
      const displayName = account
        ? (account.firstName || account.lastName)
          ? `${account.firstName} ${account.lastName}`.trim()
          : account.email
        : undefined
      const result = await createKeyMutation.mutateAsync({
        tenantId: currentTenant.id,
        anthropicApiKey: anthropicApiKey.trim(),
        label: displayName ? `${displayName} (Claude Code)` : undefined,
      })

      track('claude_code_api_key_submitted', { success: true })
      track('claude_code_key_created', { key_id: result.id })

      // Store setupToken in localStorage so /cli-auth page can pass it to the CLI
      localStorage.setItem('liftoff_setup_token', result.setupToken)
      setSetupReady(true)
      showToast('Key created', 'success')
    } catch {
      track('claude_code_api_key_submitted', { success: false })
      showToast('Failed to connect. Check your API key.', 'error')
    }
  }

  return (
    <div className="agent-connector claude-code-connector">
      <BackButton onClick={() => onCancel?.()} />
      <div className="agent-connector__content">
        <div className="agent-connector-step">
          <div className="agent-connector__visual">
            <div className="agent-connector__team agent-connector__team--left">
              <ClaudeIcon />
            </div>
            <div className="agent-connector__line" />
            <div className="agent-connector__line agent-connector__line--delayed" />
            <div className="agent-connector__line agent-connector__line--delayed-2" />
            <div className="agent-connector__team agent-connector__team--right">
              <PeopleIcon />
            </div>
          </div>

          <div className="agent-connector-step__text">
            <h1 className="agent-connector-step__header">Connect Claude Code</h1>
            <p className="agent-connector-step__subtext">
              {setupReady
                ? 'Open Terminal and run this command to finish setup.'
                : <>Paste your Claude API key from <a href="https://platform.claude.com/settings/workspaces/default/keys" target="_blank" rel="noopener noreferrer" className="claude-code-connector__link-inline">platform.claude.com</a> to connect. Claude API key usage is billed based on tokens and separate from Claude monthly subscription plans.</>
              }
            </p>
          </div>

          <div className="agent-connector-step__actions">
            {setupReady ? (
              <div className="claude-code-connector__command">
                <code className="settings-section__code">{SETUP_COMMAND}</code>
                <button
                  className="settings-section__copy"
                  onClick={() => handleCopy(SETUP_COMMAND)}
                  aria-label="Copy setup command"
                >
                  <CopyIcon width="16" height="16" />
                </button>
              </div>
            ) : (
              <>
                <input
                  type="password"
                  className="agent-connector__input"
                  placeholder="sk-ant-..."
                  value={anthropicApiKey}
                  onChange={(e) => setAnthropicApiKey(e.target.value)}
                  ref={keyRef}
                />
                <Button
                  variant="primary"
                  onClick={handleConnect}
                  disabled={!anthropicApiKey.trim() || createKeyMutation.isPending}
                >
                  {createKeyMutation.isPending ? 'Connecting...' : 'Continue'}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
