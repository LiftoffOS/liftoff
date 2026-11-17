// Liftoff Switch — the import wizard.
//
// Built on the AgentConnector layout, the same one the Claude Code and Codex
// connectors use: visual → text → actions. An import IS a connect flow, so it
// should not look like a different product.
//
// Scope, deliberately small: read what is in the source installation, build
// those team members inside Liftoff, and leave them waiting. Starting a team
// member is the user's decision and already has a home — a draft shows
// "Start Team" in Teams like any other. The wizard does not activate anything
// and does not ask anyone to arbitrate our own limits.

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useNavigate, useParams } from 'react-router'
import {
  BackButton,
  Button,
  ConnectIntegrationModal,
  StatusDot,
} from '../../../components'
import { useIntegrations, type Integration } from '../../../hooks/useIntegrations'
import { connectedAccountLabel } from '../../../utils/connectedAccountLabel'
import { useAuth } from '../../../contexts/AuthContext'
import { useToast } from '../../../contexts/ToastContext'
import { track } from '../../../lib/analytics'
import { cliSetupCommand } from '../../../lib/cliEnv'
import CopyIcon from '../../../assets/icons/copy.svg?react'
import PeopleIcon from '../../../assets/icons/people.svg?react'
import OpenClawIcon from '../../../assets/icons/openclaw.svg?react'
import HermesIcon from '../../../assets/icons/hermes.svg?react'
import ClaudeIcon from '../../../assets/icons/claude.svg?react'
import {
  activateMigration,
  convertMigration,
  getLatestMigration,
  stageForState,
  SOURCE_LABELS,
  type MigrationSource,
  type MigrationView,
  type MigrationItemState,
  type MigrationItemView,
} from '../../../services/sourceMigrations'

/** States where a team member is still being built. A row in any of these
 *  shows the working spinner, and their presence anywhere is what keeps the
 *  page polling. */
const IN_FLIGHT_ITEM_STATES: MigrationItemState[] = ['pending', 'distilling', 'creating']
// Base layout (centering, icon sizing, connect lines) — imported here so the
// page styles correctly on a cold or direct load.
import '../AgentConnector/AgentConnector.css'
// The same cards and the same connect modal the Connections page renders, so a
// reconnect happens here rather than sending someone away mid-import. Both
// stylesheets travel with the components that need them — css-closure.mjs fails
// the build if a route renders these classes without loading their definition.
import '../connectionCard.css'
import '../../../components/connectionModals.css'
import './SwitchWizard.css'

/** Matches onboarding's provisioning step so the two feel the same. */
/** The mark shown for each source.
 *
 *  Codex has no mark in this repo, so it falls back to the neutral people icon
 *  rather than borrowing another product's logo — a wrong logo says something
 *  false about who made the thing being imported. */
const SOURCE_ICONS: Record<MigrationSource, ReactElement> = {
  openclaw: <OpenClawIcon />,
  hermes: <HermesIcon />,
  'claude-code': <ClaudeIcon />,
  codex: <PeopleIcon />,
}

const POLL_MS = 1500

const STAGES = ['review', 'building', 'done'] as const
type Stage = (typeof STAGES)[number]

interface Props {
  source: MigrationSource
}

const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']

/** Cron in words. A person reading their own imported schedule should not have
 *  to parse "0 9 * * 1" to check we got it right. Anything outside the common
 *  shapes falls back to the expression rather than being described wrongly. */
function describeSchedule(cron: string): string {
  const [min, hour, dom, month, dow] = cron.trim().split(/\s+/)
  if ([min, hour, dom, month, dow].some((f) => f === undefined)) return cron

  const at = (h: string, m: string) => `${h.padStart(2, '0')}:${m.padStart(2, '0')}`
  const numeric = (v: string) => /^\d+$/.test(v)

  if (min === '0' && hour === '*' && dom === '*' && dow === '*') return 'Every hour'
  if (numeric(min) && hour === '*' && dom === '*' && dow === '*') return `Hourly at :${min.padStart(2, '0')}`
  if (numeric(min) && numeric(hour) && dom === '*' && month === '*' && dow === '*') {
    return `Daily at ${at(hour, min)}`
  }
  if (numeric(min) && numeric(hour) && dom === '*' && month === '*' && numeric(dow)) {
    return `${DAYS[Number(dow) % 7]} at ${at(hour, min)}`
  }
  if (numeric(min) && numeric(hour) && numeric(dom) && month === '*' && dow === '*') {
    return `Monthly on day ${dom} at ${at(hour, min)}`
  }
  return cron
}

export default function SwitchWizard({ source }: Props) {
  const navigate = useNavigate()
  const { stage } = useParams<{ stage?: string }>()
  const { currentTenant } = useAuth()
  const { showToast } = useToast()

  const [migration, setMigration] = useState<MigrationView | null>(null)
  const [connectTarget, setConnectTarget] = useState<Integration | null>(null)
  // Loading only means something once there is a workspace to load for;
  // without one there is nothing in flight and nothing to wait on.
  const [loadingState, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const viewedRef = useRef(false)
  const announcedFailuresRef = useRef<Set<string>>(new Set())
  const [retrying, setRetrying] = useState<string | null>(null)

  const tenantId = currentTenant?.id
  const loading = tenantId ? loadingState : false
  const label = SOURCE_LABELS[source]

  // The workspace's live connectors, mapped exactly as the Connections page
  // maps them (status 'error' becomes 'needs_reconnect').
  const { connected: liveIntegrations } = useIntegrations()

  const load = useCallback(async () => {
    // No workspace to load for. `loading` reads false in that case without
    // being set (see its declaration), so this just declines to fetch.
    if (!tenantId) return null
    try {
      const next = await getLatestMigration(tenantId, source)
      setMigration(next)
      setError(null)
      return next
    } catch {
      setError('Could not load your import. Refresh to try again.')
      return null
    } finally {
      setLoading(false)
    }
  }, [tenantId, source])

  useEffect(() => {
    // A fetch on mount. Everything it sets happens after the await; the rule
    // cannot see through the async boundary to know that.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  useEffect(() => {
    if (viewedRef.current) return
    viewedRef.current = true
    track('switch_wizard_viewed', { source })
  }, [source])

  // Announce a failure the moment it appears, once per team member. A row that
  // quietly turns into a dead label is easy to miss while the rest keep
  // building; the seen-set stops the 1.5s poll repeating the same toast.
  useEffect(() => {
    if (!migration) return
    for (const item of migration.items) {
      if (item.state !== 'failed') continue
      if (announcedFailuresRef.current.has(item.sourceRef)) continue
      announcedFailuresRef.current.add(item.sourceRef)
      showToast(`Failed to build ${item.role}.`, 'error')
    }
  }, [migration, showToast])

  // Building and done are facts about the migration, not preferences, so the
  // URL follows the record — including moving off "building" the moment the
  // last team member is finished.
  useEffect(() => {
    if (!migration) return
    const target = stageForState(migration.state) as Stage
    if (stage !== target) {
      // Preserve the query string: in mock dev the ?mock= scenario lives there,
      // and dropping it on the rewrite would bounce the page straight back to
      // whatever the default scenario is.
      navigate(`/dashboard/switch/${source}/${target}${window.location.search}`, {
        replace: true,
      })
    }
  }, [migration, stage, source, navigate])

  // Poll while any team member is still working — not while the STAGE is
  // "building". A retry on the finished screen puts one row back to work
  // without moving the migration, and gating on the stage would leave that row
  // spinning with nothing coming to update it.
  const anyInFlight = Boolean(
    migration?.items.some((i) => IN_FLIGHT_ITEM_STATES.includes(i.state)),
  )
  const shouldPoll = anyInFlight || (migration ? stageForState(migration.state) === 'building' : false)

  useEffect(() => {
    if (!shouldPoll) return
    const timer = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(timer)
  }, [shouldPoll, load])

  const copy = (text: string) => {
    navigator.clipboard.writeText(text)
    showToast('Copied to clipboard', 'success')
  }

  const handleBuild = async (sourceRefs?: string[]) => {
    if (!tenantId || !migration) return
    if (sourceRefs?.length) setRetrying(sourceRefs[0])
    else setBusy(true)
    try {
      const next = await convertMigration(migration.id, tenantId, sourceRefs)
      setMigration(next)
      if (!sourceRefs?.length) track('switch_conversion_started', { source, items: next.itemCount })
    } catch (err) {
      showToast((err as Error).message || 'Could not start building your team.', 'error')
    } finally {
      setBusy(false)
      setRetrying(null)
    }
  }

  /** Start every member that built, then hand over to Teams. Activation goes
   *  through the migration rather than the agents directly: it is the one path
   *  that publishes the whole team to the runtime as a unit. */
  const handleLaunch = async () => {
    if (!tenantId || !migration) return
    setBusy(true)
    try {
      await activateMigration(migration.id, tenantId)
      navigate('/dashboard/agents')
    } catch (err) {
      showToast((err as Error).message || 'Could not launch your teams.', 'error')
      setBusy(false)
    }
  }

  /** Retry ONE team member. Sweeping the others into someone's retry would
   *  spend model calls they did not ask for; already-built members are skipped
   *  by the ledger regardless. */
  const retryRow = (sourceRef: string) => {
    announcedFailuresRef.current.delete(sourceRef)
    void handleBuild([sourceRef])
  }

  /** One team member's row, shared by the building and finished screens.
   *
   *  A retry replaces the button with the same working state the first build
   *  showed, in place. The row is what is being rebuilt, so the row is what
   *  changes — throwing the whole page back to the progress screen would say
   *  the entire import had restarted, which is not what happened.
   *
   *  `retrying` covers the gap between the click and the first response, after
   *  which the item's own state carries it. */
  const memberRow = (item: MigrationItemView, readyLabel: string) => {
    const working = retrying === item.sourceRef || IN_FLIGHT_ITEM_STATES.includes(item.state)
    const tone = working ? 'working' : item.state === 'failed' ? 'failed' : 'converted'

    return (
      <div key={item.sourceRef} className="switch-wizard__row">
        <span className="switch-wizard__row-name">{item.role}</span>
        <span className={`switch-wizard__row-state switch-wizard__row-state--${tone}`}>
          {working ? (
            <>
              {/* The global inline spinner, the one used for list sentinels and
                  table rows, so a row that is working looks like every other
                  working row in the product. */}
              <span className="loading-spinner loading-spinner--sm" aria-hidden="true" />
              {item.state === 'creating' ? 'Finishing' : 'Building'}
            </>
          ) : item.state === 'failed' ? (
            <button className="switch-wizard__retry" onClick={() => retryRow(item.sourceRef)}>
              Try Again
            </button>
          ) : (
            readyLabel
          )}
        </span>
      </div>
    )
  }



  // ── shell ────────────────────────────────────────────────────────────

  const shell = (children: React.ReactNode, withBack = true) => (
    <div className="agent-connector switch-wizard">
      {/* Back to the source chooser, which is where this page is reached from. */}
      {withBack && <BackButton onClick={() => navigate('/dashboard/switch')} />}
      <div className="agent-connector__content">
        <div className="agent-connector-step">{children}</div>
      </div>

      {/* The Connections page's own modal, handling OAuth and API-key flows
          internally. It carries the live connector, which is what selects the
          backend's adopt branch so the imported placeholder is healed rather
          than duplicated. */}
      {connectTarget && (
        <ConnectIntegrationModal
          integration={connectTarget}
          onClose={() => {
            setConnectTarget(null)
            // A successful reconnect flips the row to active; re-read so the
            // card stops asking.
            void load()
          }}
        />
      )}
    </div>
  )

  const visual = (
    <div className="agent-connector__visual">
      <div className="agent-connector__team agent-connector__team--left">
        {SOURCE_ICONS[source]}
      </div>
      <div className="agent-connector__line" />
      <div className="agent-connector__line agent-connector__line--delayed" />
      <div className="agent-connector__line agent-connector__line--delayed-2" />
      <div className="agent-connector__team agent-connector__team--right">
        <PeopleIcon />
      </div>
    </div>
  )

  if (loading) {
    return shell(
      <div className="agent-connector__loading">
        {/* The global spinner every other dashboard page loads behind, with no
            accompanying sentence. A page that narrates its own loading reads as
            slower than one that just spins. */}
        <div className="loading-spinner" role="status" aria-label="Loading your import" />
      </div>,
      false,
    )
  }

  if (error) {
    return shell(
      <div className="agent-connector-step__text">
        <h1 className="agent-connector-step__header">Something went wrong</h1>
        <p className="agent-connector-step__subtext">{error}</p>
      </div>,
    )
  }

  // No import yet: the command that starts one. Same shape as the Claude Code
  // connector, for the same reason — the work happens on the person's machine.
  if (!migration) {
    const command = cliSetupCommand(`switch --from ${source}`)
    return shell(
      <>
        {visual}
        <div className="agent-connector-step__text">
          <h1 className="agent-connector-step__header">Move Your {label} to Liftoff</h1>
          <p className="agent-connector-step__subtext">
            Run this in your terminal. Liftoff will import your instructions, skills, memories and
            scheduled work in your {label}. Your credentials will not be imported.
          </p>
        </div>
        <div className="agent-connector-step__actions">
          <div className="switch-wizard__command">
            <code className="settings-section__code">{command}</code>
            <button
              className="settings-section__copy"
              onClick={() => copy(command)}
              aria-label="Copy import command"
            >
              <CopyIcon width="16" height="16" />
            </button>
          </div>
        </div>
      </>,
    )
  }

  const currentStage = stageForState(migration.state) as Stage

  // Only the connections this import created, resolved to their live connector
  // so the card renders the real thing and Reconnect heals that exact row.
  const importedConnectorIds = new Set(
    migration.connections
      .filter((c) => c.status === 'needs_reconnect' && c.connectorId)
      .map((c) => c.connectorId as string),
  )
  const needsReconnect = liveIntegrations.filter(
    (i) => i.connector && importedConnectorIds.has(i.connector.id),
  )

  // What actually blocks the build, using the server's own rule.
  //
  // The cards above are the intersection of the migration's connections with
  // the live integrations, so a connection with no live connector renders
  // nothing. Deriving the button's state from the cards therefore enabled
  // Continue while conversion refused: an imported MCP server whose placeholder
  // failed to be created sat in `placeholder_pending`, which blocks the build
  // and has no card, so the only feedback was an error toast with no way to act
  // on it. Blocked is a fact about the migration, not about what happens to be
  // renderable.
  const blockingConnections = migration.connections.filter(
    (c) => c.status === 'needs_reconnect' || c.status === 'placeholder_pending',
  )


  // ── review ───────────────────────────────────────────────────────────

  if (currentStage === 'review') {
    return shell(
      <>
        {visual}
        <div className="agent-connector-step__text">
          <h1 className="agent-connector-step__header">Your {label} Setup</h1>
          <p className="agent-connector-step__subtext">This is what we found.</p>
        </div>

        <div className="agent-connector__capabilities-card">
          {migration.items.map((item) => (
            <div key={item.sourceRef} className="switch-wizard__row">
              <span className="switch-wizard__row-name">{item.role}</span>
              <span className="switch-wizard__row-state">
                {item.cronExpr ? describeSchedule(item.cronExpr) : 'No schedule'}
              </span>
            </div>
          ))}
          <div className="switch-wizard__row">
            <span className="switch-wizard__row-name">Connections</span>
            <span className="switch-wizard__row-state">{migration.connections.length}</span>
          </div>
        </div>

        {needsReconnect.length > 0 && (
          <div className="agent-connector__capabilities-card">
            <h2 className="agent-connector__capabilities-title">
              Reconnect Your Apps and Services to Liftoff
            </h2>
            <div className="connections-grid">
              {needsReconnect.map((integration) => {
                const subtitle = connectedAccountLabel(integration.connector)
                return (
                  <div
                    key={integration.id}
                    className="connection-card connection-card--needs-reconnect"
                  >
                    <div className="connection-card__icon">{integration.icon}</div>
                    <div className="connection-card__content">
                      <h3 className="connection-card__name">{integration.name}</h3>
                      {subtitle && <span className="connection-card__type">{subtitle}</span>}
                    </div>
                    <div className="connection-card__status">
                      <StatusDot variant="warning" />
                      Needs Reconnect
                    </div>
                    <button
                      className="connection-card__action"
                      onClick={() => {
                        track('connection_reconnect_clicked', {
                          connector: integration.connectorType ?? integration.name,
                        })
                        setConnectTarget(integration)
                      }}
                    >
                      Reconnect
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}



        <div className="agent-connector-step__actions">
          {/* Blocked until every imported connection is reconnected. The
              distiller shapes each team member around the integrations it is
              given, so building against a connector still in `error` produces a
              member built for tools it cannot reach — broken on arrival, and
              only fixable by building it again. */}
          <Button
            variant="primary"
            onClick={() => handleBuild()}
            loading={busy}
            disabled={busy || blockingConnections.length > 0}
          >
            Continue
          </Button>
        </div>
      </>,
    )
  }

  // ── building ─────────────────────────────────────────────────────────

  if (currentStage === 'building') {
    return shell(
      <>
        {visual}
        <div className="agent-connector-step__text">
          <h1 className="agent-connector-step__header">Building Your Agents</h1>
          <p className="agent-connector-step__subtext">
            {migration.convertedCount} of {migration.itemCount} ready. Please leave this page open.
          </p>
        </div>
        <div className="agent-connector__capabilities-card">
          {migration.items.map((item) => memberRow(item, 'Ready'))}
        </div>
      </>,
      false,
    )
  }

  // ── done ─────────────────────────────────────────────────────────────
  //
  // Built and waiting, not running. Whether to start them is the user's call,
  // offered the same way AgentBuilder's completion screen offers it: Launch Now,
  // or Maybe Later and start them from Teams whenever they like.

  return shell(
    <>
      {visual}
      <div className="agent-connector-step__text">
        <h1 className="agent-connector-step__header">
          {migration.convertedCount === 1 ? 'Your Agent is Ready' : 'Your Agents Are Ready'}
        </h1>
        <p className="agent-connector-step__subtext">
          {migration.convertedCount}{' '}
          {migration.convertedCount === 1 ? 'agent is' : 'agents are'} awaiting launch.
        </p>
      </div>

      <div className="agent-connector__capabilities-card">
        {migration.items.map((item) => memberRow(item, 'Awaiting Launch'))}
      </div>


      <div className="agent-connector-step__actions">
        {/* Launch Now starts every member that built; Maybe Later leaves them
            as drafts. Same pair, same order and same variants as AgentBuilder's
            completion screen, because it is the same decision. */}
        <Button
          variant="primary"
          onClick={() => void handleLaunch()}
          loading={busy}
          disabled={busy || migration.convertedCount === 0}
        >
          Launch Now
        </Button>
        <Button variant="text" onClick={() => navigate('/dashboard/agents')} disabled={busy}>
          Maybe Later
        </Button>
      </div>
    </>,
    false,
  )
}
