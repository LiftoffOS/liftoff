// <TunnelSetup /> — rendered inside a ModalOverlay when the customer toggles
// "Use a tunnel" in either the Custom MCP Server modal or the Connect
// External Agent wizard.
//
// 1:1 model: one customer Docker container = one tunnel = one private
// service exposed. Every time a customer opens this modal, they get a
// FRESH tunnel for this particular service. If they have another private
// service in another network, they run another `docker run` and that
// produces another tunnel. We never ask them to pick between existing
// tunnels — the tunnel is just the named identity of "the Docker process
// running over there for this particular thing," not a sharing primitive.
//
// Flow on mount:
//   1. Create a fresh deployment → render its `docker run` snippet + a copy
//      button. Status pulses orange ("Pending") while we wait for the
//      customer to run the command and chisel-connect home.
//   2. When the customer's tunnel client connects, terminator heartbeats
//      flip the deployment to 'active' → status shows green "Connected"
//      and [Use This URL] enables once they've filled in the internal URL.
//   3. Click → server creates the route + opaque subdomain → onCommit
//      returns { tunnelRouteId, publicUrl } to the parent.
//
// Mid-wizard abandonment cleanup runs on unmount; the server-side sweep
// (Cloud Scheduler, every 5 min, 10-min orphan threshold) is the
// durability fallback.

import { useEffect, useRef, useState } from 'react'
import Button from './Button'
import StatusDot from './StatusDot'
import TextInput from './TextInput/TextInput'
import './TunnelSetup.css'
import {
  useCreateTunnelDeployment,
  useCreateTunnelRoute,
  useDeleteTunnelDeployment,
  useTunnelDeployment,
} from '../hooks/useTunnels'
import type {
  CreateTunnelDeploymentResult,
  TunnelDeployment,
} from '../services/tunnels'

export interface TunnelSetupProps {
  entityName: string
  entityKind: 'agent' | 'mcp_server'
  onCommit: (result: { tunnelRouteId: string; publicUrl: string }) => void
  /** Renders a Cancel button beside the primary CTA in the actions row. */
  onCancel?: () => void
}

const PENDING_TIMEOUT_MS = 5 * 60 * 1000

function tunnelStatusVariant(s: TunnelDeployment['status']) {
  switch (s) {
    case 'active':
      return 'connected' as const
    case 'pending':
      // Brand accent (orange) with the pulse halo, not a generic info-blue.
      return 'accent' as const
    case 'disconnected':
      return 'warning' as const
    default:
      return 'neutral' as const
  }
}

function tunnelStatusLabel(s: TunnelDeployment['status']): string {
  switch (s) {
    case 'active':
      return 'Connected'
    case 'pending':
      return 'Waiting for tunnel…'
    case 'disconnected':
      return 'Disconnected — check your tunnel container is running'
    default:
      return s
  }
}

export default function TunnelSetup({ entityName, entityKind, onCommit, onCancel }: TunnelSetupProps) {
  const createDeployment = useCreateTunnelDeployment()
  const createRoute = useCreateTunnelRoute()
  const deleteDeployment = useDeleteTunnelDeployment()
  const committedRef = useRef(false)

  const [newDeployment, setNewDeployment] = useState<CreateTunnelDeploymentResult | null>(null)
  const [internalUrl, setInternalUrl] = useState<string>('')
  const [copied, setCopied] = useState(false)

  const watchedId = newDeployment?.deployment.id ?? ''
  const { data: watchedDeployment } = useTunnelDeployment(watchedId)
  const activeDeployment: TunnelDeployment | null =
    watchedDeployment ?? newDeployment?.deployment ?? null

  const tunnelStatus = activeDeployment?.status ?? 'pending'
  const dockerRun = newDeployment?.deployArtifact.dockerRunCommand

  const [createdAt] = useState(() => Date.now())
  const [pendingTimedOut, setPendingTimedOut] = useState(false)
  useEffect(() => {
    if (tunnelStatus !== 'pending') return
    const ms = PENDING_TIMEOUT_MS - (Date.now() - createdAt)
    const t = setTimeout(() => setPendingTimedOut(true), Math.max(ms, 0))
    return () => clearTimeout(t)
  }, [tunnelStatus, createdAt])

  const startFreshDeployment = async () => {
    try {
      // Title-case the auto-generated tunnel name. entityName is user-typed
      // so we lightly normalise the first letter; the suffix is a fixed
      // proper-cased "Tunnel". Empty entityName falls back to "New Tunnel".
      const trimmed = entityName.trim()
      const titled = trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : 'New'
      const result = await createDeployment.mutateAsync({ name: `${titled} Tunnel` })
      setNewDeployment(result)
    } catch (err) {
      console.error('createTunnelDeployment failed', err)
    }
  }

  // Auto-create a fresh tunnel exactly once when the modal opens. There's
  // no "pick an existing tunnel" path — the tunnel is the Docker process
  // about to run for this private service.
  useEffect(() => {
    if (!newDeployment && !createDeployment.isPending) {
      // Firing a mutation when the modal opens is what an effect is for. The
      // state it moves is the mutation's own, and there is no earlier moment
      // to ask for a tunnel that does not exist yet.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void startFreshDeployment()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleResetPending = async () => {
    if (newDeployment?.deployment.id) {
      try {
        await deleteDeployment.mutateAsync(newDeployment.deployment.id)
      } catch {
        /* fire-and-forget */
      }
    }
    setNewDeployment(null)
    setPendingTimedOut(false)
    void startFreshDeployment()
  }

  const handleUseThisUrl = async () => {
    if (!activeDeployment) return
    // Subdomain is generated server-side as a short opaque token — clients
    // don't pick it and don't see it as something they shape.
    const route = await createRoute.mutateAsync({
      deploymentId: activeDeployment.id,
      upstreamUrl: internalUrl,
    })
    committedRef.current = true
    onCommit({ tunnelRouteId: route.id, publicUrl: route.publicUrl })
  }

  const handleCopy = async () => {
    if (!dockerRun) return
    try {
      await navigator.clipboard.writeText(dockerRun)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard unavailable */
    }
  }

  // Mid-wizard abandonment: if the customer closes the parent modal /
  // wizard before committing, delete the pending deployment we just
  // created. The server-side sweep is the durability fallback.
  useEffect(() => {
    return () => {
      const created = newDeployment?.deployment
      if (!committedRef.current && created && created.status === 'pending') {
        void deleteDeployment.mutateAsync(created.id).catch(() => {})
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newDeployment?.deployment?.id])

  const inputLabel =
    entityKind === 'agent' ? "Your service's internal URL" : "Your MCP server's internal URL"
  const inputPlaceholder = entityKind === 'agent' ? 'http://localhost:8080' : 'http://localhost:7000'
  const canCommit = tunnelStatus === 'active' && internalUrl.trim().length > 0

  return (
    <section className="tunnel-setup">
      {dockerRun && (
        <>
          <p className="tunnel-setup__heading">Run this on a machine inside your network</p>
          <pre className="tunnel-setup__code">{dockerRun}</pre>
          <div className="tunnel-setup__copy-row">
            <p className="tunnel-setup__hint">
              Please copy this as it will not be shown again
            </p>
            <Button variant="outline" size="sm" onClick={() => void handleCopy()}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </>
      )}

      <div className="tunnel-setup__status-row">
        <StatusDot variant={tunnelStatusVariant(tunnelStatus)} pulse={tunnelStatus === 'pending'} />
        <span>{tunnelStatusLabel(tunnelStatus)}</span>
      </div>

      {pendingTimedOut && (
        <div className="tunnel-setup__banner">
          <p className="tunnel-setup__banner-text">
            Tunnel did not come online. Ensure the Docker command is running
            on a machine inside your network with internet access, then try
            again.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleResetPending()}
          >
            Retry
          </Button>
        </div>
      )}

      <TextInput
        id="tunnel-internal-url"
        label={inputLabel}
        value={internalUrl}
        onChange={(e) => setInternalUrl(e.target.value)}
        placeholder={inputPlaceholder}
        autoComplete="off"
      />

      <div className="connection-modal__actions">
        {onCancel && (
          <Button
            variant="outline"
            onClick={onCancel}
            disabled={createRoute.isPending}
          >
            Cancel
          </Button>
        )}
        <Button
          variant="primary"
          disabled={!canCommit || createRoute.isPending}
          loading={createRoute.isPending}
          onClick={() => void handleUseThisUrl()}
        >
          Use This URL
        </Button>
      </div>
    </section>
  )
}
