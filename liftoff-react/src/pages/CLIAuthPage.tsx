import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { track } from '../lib/analytics'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../contexts/ToastContext'
import { auth } from '../config/firebase'
import LiftoffLogo from '../assets/logo.svg?react'
import ArrowLeftIcon from '../assets/icons/arrow-left.svg?react'
import './CLIAuthPage.css'

export default function CLIAuthPage() {
  const [searchParams] = useSearchParams()
  const { tenants, tenantLoading, account } = useAuth()
  const { showToast } = useToast()
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)
  const viewedRef = useRef(false)
  useEffect(() => {
    if (viewedRef.current || tenantLoading) return
    viewedRef.current = true
    track('cli_auth_viewed', { workspace_count: tenants.length })
  }, [tenantLoading, tenants.length])

  const port = searchParams.get('port')
  const state = searchParams.get('state')
  const codeChallenge = searchParams.get('code_challenge')
  const mode = searchParams.get('mode')
  // Which CLI client initiated auth — drives the product name shown below.
  const productName = searchParams.get('client') === 'codex' ? 'Codex' : 'Claude Code'
  // setupToken can come from query param OR localStorage (set by dashboard after key creation)
  const setupToken = searchParams.get('setupToken') || localStorage.getItem('liftoff_setup_token')

  // Auto-skip if user has exactly one workspace
  useEffect(() => {
    if (!tenantLoading && tenants.length === 1 && port) {
      handleSelectWorkspace(tenants[0].id)
    }
  }, [tenantLoading, tenants.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // A declaration, not a const: the auto-skip effect above calls it.
  async function handleSelectWorkspace(tenantId: string) {
    if (processing || !port) return
    track('cli_auth_workspace_selected', { tenant_id: tenantId })
    setSelectedTenantId(tenantId)
    setProcessing(true)

    try {
      // Use Firebase ID token directly — no custom session token (BE-003/SE-001 fix)
      const firebaseToken = await auth.currentUser?.getIdToken()
      if (!firebaseToken) throw new Error('Not authenticated')

      const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://api.example.com'

      if (mode === 'collab') {
        // Collab flow: auto-create a new MCP token via platform-backend
        const displayName = account
          ? (account.firstName || account.lastName)
            ? `${account.firstName} ${account.lastName}`.trim()
            : account.email
          : undefined
        const tokenName = displayName ? `${displayName} (Claude Code)` : undefined
        const mcpRes = await fetch(`${API_BASE_URL}/api/claude-code-proxy/mcp-tokens`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${firebaseToken}`,
          },
          body: JSON.stringify({ tenantId, name: tokenName }),
        })
        if (!mcpRes.ok) throw new Error('Failed to create MCP token')
        const mcpData = await mcpRes.json() as { id: string; setupToken: string; proxyBaseUrl: string }

        // PKCE: bind the code_challenge to the new setup token via platform-backend
        if (codeChallenge) {
          await fetch(`${API_BASE_URL}/api/claude-code-proxy/setup-bind-challenge`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${firebaseToken}`,
            },
            body: JSON.stringify({ setupToken: mcpData.setupToken, codeChallenge }),
          })
        }

        // Redirect to the CLI's localhost callback with Firebase token + MCP token info
        const callbackUrl = new URL(`http://localhost:${port}/callback`)
        callbackUrl.searchParams.set('token', firebaseToken)
        callbackUrl.searchParams.set('tenantId', tenantId)
        if (state) {
          callbackUrl.searchParams.set('state', state)
        }
        callbackUrl.searchParams.set('setupToken', mcpData.setupToken)
        callbackUrl.searchParams.set('tokenId', mcpData.id)

        window.location.href = callbackUrl.toString()
      } else {
        // The token can arrive by localStorage (same browser as the dashboard)
        // OR — the robust path — be fetched from the server for the now-
        // authenticated user, so `setup` works from any browser or machine.
        let effectiveSetupToken = setupToken
        if (!effectiveSetupToken) {
          const pendingRes = await fetch(
            `${API_BASE_URL}/api/claude-code-proxy/pending-setup-token?tenantId=${encodeURIComponent(tenantId)}`,
            { headers: { Authorization: `Bearer ${firebaseToken}` } },
          )
          if (pendingRes.ok) {
            effectiveSetupToken = (await pendingRes.json() as { setupToken?: string }).setupToken ?? null
          }
        }

        // PKCE-bind the code_challenge through platform-backend (the
        // developer-proxy is IAM-gated and unreachable from the browser). MUST
        // throw on failure so a bad bind never silently proceeds.
        if (effectiveSetupToken && codeChallenge) {
          const bindRes = await fetch(`${API_BASE_URL}/api/claude-code-proxy/setup-bind-challenge`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${firebaseToken}`,
            },
            body: JSON.stringify({ setupToken: effectiveSetupToken, codeChallenge }),
          })
          if (!bindRes.ok) throw new Error('Failed to bind setup token')
        }

        // Redirect to the CLI's localhost callback with Firebase token
        const callbackUrl = new URL(`http://localhost:${port}/callback`)
        callbackUrl.searchParams.set('token', firebaseToken)
        callbackUrl.searchParams.set('tenantId', tenantId)
        if (state) {
          callbackUrl.searchParams.set('state', state)
        }
        if (effectiveSetupToken) {
          callbackUrl.searchParams.set('setupToken', effectiveSetupToken)
          localStorage.removeItem('liftoff_setup_token')
        }

        window.location.href = callbackUrl.toString()
      }
    } catch {
      showToast('Failed to authenticate. Try again.', 'error')
      setSelectedTenantId(null)
      setProcessing(false)
    }
  }

  const renderContent = () => {
    if (tenantLoading || (!tenantLoading && tenants.length === 1 && port)) {
      return <div className="loading-spinner" />
    }

    if (!port) {
      return (
        <>
          <h1 className="login-title">Invalid Request</h1>
          <p className="login-subtitle">
            This page should be opened by the Liftoff CLI.
          </p>
        </>
      )
    }

    if (tenants.length === 0) {
      return (
        <>
          <h1 className="login-title">No Workspaces</h1>
          <p className="login-subtitle">
            You don't belong to any workspaces yet. Ask a workspace admin to invite you.
          </p>
        </>
      )
    }

    return (
      <>
        <h1 className="login-title">Select Workspace</h1>
        <p className="login-subtitle">
          {mode === 'collab'
            ? 'Connect Claude Code collaboration tools to a workspace'
            : `Connect your ${productName} to a workspace`}
        </p>

        <div className="cli-auth__workspaces">
          {tenants.map((tenant) => (
            <button
              key={tenant.id}
              className={`cli-auth__workspace ${selectedTenantId === tenant.id ? 'cli-auth__workspace--active' : ''}`}
              onClick={() => handleSelectWorkspace(tenant.id)}
              disabled={processing}
            >
              <span className="cli-auth__workspace-name">{tenant.name}</span>
              <span className="cli-auth__workspace-role">{tenant.role}</span>
            </button>
          ))}
        </div>
      </>
    )
  }

  return (
    <div className="login-page">
      <Link to="/" className="login-back" aria-label="Back to home">
        <ArrowLeftIcon width={24} height={24} />
      </Link>
      <div className="login-container">
        <Link to="/" className="login-logo">
          <LiftoffLogo />
        </Link>
        {renderContent()}
      </div>
    </div>
  )
}
