import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useTenant } from '../hooks/useTenant'
import { resolveChatShare, type ChatShareResolution } from '../services/agentChat'
import { track } from '../lib/analytics'
import { chatThreadRoute } from '../lib/chatThreadRoute'
import ErrorState from '../components/ErrorState'
import FullScreenLoader from '../components/FullScreenLoader'

// /share/:shareId — resolves a workspace share link to its chat thread and
// forwards there, switching the active workspace first when needed. The
// backend returns the same 404 for unknown ids, non-members, and deleted
// threads, so the only failure state is "could not open".
//
// Two-phase flow because switchTenant is a silent no-op when the target
// tenant is missing from the loaded list: phase 1 resolves the share,
// phase 2 activates the workspace (refreshing the tenant list once if the
// membership is newer than this session) and navigates ONLY after
// currentTenant actually equals the target.
export default function SharePage() {
  const { shareId } = useParams<{ shareId: string }>()
  const navigate = useNavigate()
  const { currentTenant, tenants, tenantLoading, switchTenant, refreshTenants } = useTenant()
  const [target, setTarget] = useState<ChatShareResolution | null>(null)
  const [failed, setFailed] = useState(false)
  // Local completion flag for the one-shot tenant refresh: refreshTenants
  // swallows errors and can finish without any context state change, so the
  // effect below must have its own state to re-run on.
  const [refreshDone, setRefreshDone] = useState(false)
  const resolvingRef = useRef(false)
  const refreshTriedRef = useRef(false)
  const switchRequestedRef = useRef(false)

  // Phase 1: resolve the share id. Waits for the tenant list so phase 2
  // can trust it; the ref guards StrictMode double-fire.
  useEffect(() => {
    if (tenantLoading || resolvingRef.current || !shareId) return
    resolvingRef.current = true
    void (async () => {
      try {
        const share = await resolveChatShare(shareId)
        track('agent_chat_share_opened', { share_id: shareId })
        setTarget(share)
      } catch {
        setFailed(true)
      }
    })()
  }, [tenantLoading, shareId])

  // Phase 2: make the share's workspace active, then navigate.
  useEffect(() => {
    if (!target || failed) return
    if (currentTenant?.id === target.tenantId) {
      // Internal agent/thread ids stay out of the address bar and browser
      // history: the share URL is the only public artifact.
      //
      // A team-plan share carries the Chief AI Officer's agent id, which its
      // page does not take. Everything that is not a platform kind is a team's
      // own chat, including links minted before threadKind existed, which carry
      // no kind at all and are all agent chats.
      const { pathname, state } = chatThreadRoute(
        target.threadKind === 'team_plan' || target.threadKind === 'insights' || target.threadKind === 'liftoff'
          ? { kind: target.threadKind, threadId: target.threadId }
          : { kind: 'agent', threadId: target.threadId, agentId: target.agentId },
      )
      navigate(pathname, { state, replace: true })
      return
    }
    if (tenants.some((t) => t.id === target.tenantId)) {
      if (!switchRequestedRef.current) {
        switchRequestedRef.current = true
        switchTenant(target.tenantId)
        // currentTenant updates → this effect re-runs → navigate above.
      }
      return
    }
    // Membership is confirmed by the backend but missing from this session's
    // list (invited after login): refresh once, then re-evaluate. refreshDone
    // is set in finally so this effect re-runs even when refreshTenants
    // failed or completed without changing any context state.
    if (!refreshTriedRef.current) {
      refreshTriedRef.current = true
      void refreshTenants().finally(() => setRefreshDone(true))
      return
    }
    if (!refreshDone) return // refresh still in flight
    // Failure is only knowable once the refresh has come back, so this cannot
    // be decided during a render: every earlier branch either navigates,
    // switches workspace or waits.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFailed(true)
  }, [target, failed, refreshDone, currentTenant, tenants, switchTenant, refreshTenants, navigate])

  if (failed) {
    return (
      <ErrorState
        variant="error"
        title="This link could not be opened"
        subtitle="It may have been removed, or it belongs to a workspace you are not a member of."
        buttonLabel="Go to Dashboard"
        onRetry={() => navigate('/dashboard')}
      />
    )
  }
  return <FullScreenLoader />
}
