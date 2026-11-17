import { useEffect, useRef, useState } from 'react'
import { BackButton, Button } from '../../../components'
import { track } from '../../../lib/analytics'
import { useToast } from '../../../contexts/ToastContext'
import { useAuth } from '../../../contexts/AuthContext'
import { useCreateCodexProxyKey } from '../../../hooks/useClaudeCodeProxy'
import { cliSetupCommand } from '../../../lib/cliEnv'
import CopyIcon from '../../../assets/icons/copy.svg?react'
import PeopleIcon from '../../../assets/icons/people.svg?react'
import OpenAIIcon from '../../../assets/icons/openai.svg?react'
// Base layout (icon sizing, connect lines) — import here so the page styles
// correctly on a cold/direct load, not only when navigated to in-app.
import '../AgentConnector/AgentConnector.css'
import './CodexConnector.css'
import { useAutoFocus } from '../../../hooks/useAutoFocus'

interface CodexConnectorProps {
  onCancel?: () => void
}

const SETUP_COMMAND = cliSetupCommand('codex setup')

export default function CodexConnector({ onCancel }: CodexConnectorProps) {
  const keyRef = useAutoFocus<HTMLInputElement>()
  const { showToast } = useToast()
  const { currentTenant, account } = useAuth()
  const createKeyMutation = useCreateCodexProxyKey()

  const [openaiApiKey, setOpenaiApiKey] = useState('')
  const [setupReady, setSetupReady] = useState(false)
  const viewedRef = useRef(false)
  useEffect(() => {
    if (viewedRef.current) return
    viewedRef.current = true
    track('codex_connector_viewed', {})
  }, [])

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text)
    if (text.includes('npx')) track('codex_npx_command_copied', {})
    showToast('Copied to clipboard', 'success')
  }

  const handleConnect = async () => {
    if (!openaiApiKey.trim() || !currentTenant?.id) return

    try {
      const displayName = account
        ? (account.firstName || account.lastName)
          ? `${account.firstName} ${account.lastName}`.trim()
          : account.email
        : undefined
      const result = await createKeyMutation.mutateAsync({
        tenantId: currentTenant.id,
        openaiApiKey: openaiApiKey.trim(),
        label: displayName ? `${displayName} (Codex)` : undefined,
      })

      track('codex_api_key_submitted', { success: true })
      track('codex_key_created', { key_id: result.id })

      // The submitted OpenAI key is never shown again after this point.
      setOpenaiApiKey('')

      // Store setupToken in localStorage so /cli-auth page can pass it to the CLI
      localStorage.setItem('liftoff_setup_token', result.setupToken)
      setSetupReady(true)
      showToast('Key created', 'success')
    } catch {
      track('codex_api_key_submitted', { success: false })
      showToast('Failed to connect. Check your API key.', 'error')
    }
  }

  return (
    <div className="agent-connector codex-connector">
      <BackButton onClick={() => onCancel?.()} />
      <div className="agent-connector__content">
        <div className="agent-connector-step">
          <div className="agent-connector__visual">
            <div className="agent-connector__team agent-connector__team--left">
              <OpenAIIcon />
            </div>
            <div className="agent-connector__line" />
            <div className="agent-connector__line agent-connector__line--delayed" />
            <div className="agent-connector__line agent-connector__line--delayed-2" />
            <div className="agent-connector__team agent-connector__team--right">
              <PeopleIcon />
            </div>
          </div>

          <div className="agent-connector-step__text">
            <h1 className="agent-connector-step__header">Connect OpenAI Codex</h1>
            <p className="agent-connector-step__subtext">
              {setupReady
                ? <>Open a terminal and run the command below to finish setup. Then start Codex with <code className="codex-connector__inline-code">codex --profile liftoff</code>.</>
                : <>Paste your OpenAI API key from <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="codex-connector__link-inline">platform.openai.com</a> to connect. OpenAI API key usage is billed based on tokens and separate from ChatGPT subscription plans.</>
              }
            </p>
          </div>

          <div className="agent-connector-step__actions">
            {setupReady ? (
              <div className="codex-connector__command">
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
                  placeholder="sk-..."
                  value={openaiApiKey}
                  onChange={(e) => setOpenaiApiKey(e.target.value)}
                  ref={keyRef}
                />
                <Button
                  variant="primary"
                  onClick={handleConnect}
                  disabled={!openaiApiKey.trim() || createKeyMutation.isPending}
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
