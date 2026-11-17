import { useState, useRef, useEffect, useMemo } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { ActionMenu, Button, EmptyState, IntegrationIconsDisplay, PageHeader, PlugIcon, SegmentedControl, StatusBadge, StatusDot, TeamIcon, Tooltip } from '../../components'
import ErrorState from '../../components/ErrorState'
import { PermissionGate } from '../../components/PermissionGate'
import PersonAssignmentModal from './PersonAssignmentModal'
import { useToast } from '../../contexts/ToastContext'
import { usePlanGate } from '../../components/Dashboard/planGateContext'
import { useDeleteInternalAgent, useUpdateInternalAgentStatus } from '../../hooks/useInternalAgents'
import { useDeleteExternalAgent, useUpdateExternalAgentStatus } from '../../hooks/useExternalAgents'
import { useDeleteClaudeCodeProxyKey, useRevokeMcpToken } from '../../hooks/useClaudeCodeProxy'
import { useBindingHealth } from '../../hooks/useBindingHealth'
import { useChatUnreadCounts } from '../../hooks/useChatUnread'
import { useTeamPlanUnreadCount } from '../../hooks/useTeamPlanUnread'
import { useWorkforce } from '../../hooks/useWorkforce'
import type { WorkforceClaudeCodeKey } from '../../hooks/useWorkforce'
import CubeIcon from '../../assets/icons/cube.svg?react'
import { codingToolMark } from '../../components/CodingToolMark'
import ChevronDownIcon from '../../assets/icons/chevron-down.svg?react'
import CheckIcon from '../../assets/icons/check.svg?react'
import FilterIcon from '../../assets/icons/filter.svg?react'
import PersonCenteredIcon from '../../assets/icons/person-centered.svg?react'
import PeopleAltIcon from '../../assets/icons/people-alt.svg?react'
import SquareChartGanttIcon from '../../assets/icons/square-chart-gantt.svg?react'
// The same speech bubble the "Message Directly" card carried on the old
// /dashboard/agents/message page, so the action keeps its mark.
import MessageCircleIcon from '../../assets/icons/message-circle.svg?react'
import { useAgentStats } from '../../hooks/useAgentStats'
import MetricCard from '../../components/Dashboard/MetricCard'
import { getInternalAgentActionLabel, type InternalAgent, type InternalAgentStatus } from '../../services/internalAgents'
import { getExternalAgentActionLabel, type ExternalAgent, type ExternalAgentStatus } from '../../services/externalAgents'
import type { PersonnelMember } from '../../services/personAssignments'
import type { ActivityLocationState } from '../../types/activityScope'
import { formatActionLabel } from '../../utils/formatAction'
import { track } from '../../lib/analytics'
import './AgentsPage.css'

type FilterType = 'all' | InternalAgentStatus | 'onboarding' | 'invited' | 'error'
type TeamTypeFilter = { ai_teams: boolean; external_collaborators: boolean; people: boolean }
type WorkforceCategory = 'all' | 'ai_workforce' | 'human_workforce'
/** The Active Teams / Tasks Completed / Hours Saved summary row on the Teams
 *  page. Hidden until further notice (product decision).
 *
 *  A flag rather than a deletion: the three figures are still computed by
 *  useAgentStats and still render correctly, so nothing here is broken and
 *  bringing the row back should be flipping this, not rebuilding it. */
const SHOW_TEAM_SUMMARY = false

type SortColumn = 'name' | 'status' | 'description' | 'integrations' | 'tasks' | 'activity' | null
type SortDirection = 'asc' | 'desc' | null

// Normalize any entity's status to a common filter status
// This allows unified filtering regardless of team type
function normalizeToFilterStatus(status: InternalAgentStatus | ExternalAgentStatus): InternalAgentStatus {
  // Internal agent statuses pass through directly
  if (status === 'active' || status === 'paused' || status === 'draft') {
    return status
  }
  // Map external agent statuses to equivalent filter statuses
  switch (status) {
    case 'connected': return 'active'
    case 'disconnected': return 'paused'
    case 'pending':
    case 'pending_review': return 'draft'
    case 'error': return 'active' // Errors are interruptions of active connections
    default: return 'draft'
  }
}

// Brand a coding-tool connection from the key the workforce payload carries:
// the credential vendor on a Switch-flow row, the client slug on an
// OAuth-connected tool. The label is the one the backend named the row with
// when it sent one (a client it does not know keeps its registered name), else
// the mark's own. `dark` drives a colour modifier: marks that paint with
// currentColor would otherwise inherit the wrapper's muted grey and read as
// disabled beside a mark with its own brand fill.
function connectionBrand(key: WorkforceClaudeCodeKey): { label: string; Icon: ReturnType<typeof codingToolMark>['Icon']; dark: boolean } {
  const mark = codingToolMark(key.vendor)
  return { label: key.clientLabel ?? mark.label, Icon: mark.Icon, dark: mark.dark }
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatTimeAgo(dateStr: string | null): string {
  if (!dateStr) return 'Never'
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins} ${diffMins === 1 ? 'minute' : 'minutes'} ago`

  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays} days ago`

  return formatDate(dateStr)
}

// Skeleton card component for loading state
function TeamCardSkeleton() {
  return (
    <div className="agent-card agent-card--skeleton">
      <div className="agent-card__header">
        <div className="skeleton-text skeleton-text--title skeleton-pulse" style={{ width: '60%' }} />
        <div className="skeleton-badge skeleton-pulse" />
      </div>
      <div className="skeleton-text skeleton-pulse" style={{ width: '100%', height: '60px' }} />
      <div className="agent-card__integrations-row">
        <div className="skeleton-icons skeleton-pulse" />
      </div>
      <div className="agent-card__meta">
        <div className="skeleton-text skeleton-pulse" style={{ width: '25%' }} />
        <div className="skeleton-text skeleton-pulse" style={{ width: '25%' }} />
        <div className="skeleton-text skeleton-pulse" style={{ width: '25%' }} />
        <div className="skeleton-text skeleton-pulse" style={{ width: '25%' }} />
      </div>
    </div>
  )
}

// --- Internal "x-ray" reveal -------------------------------------------------
// Easter egg for staff: Alt/Option + double-click any status pill swaps every
// workforce name on the page (agents and people) for its backend ID. Hover an
// ID to see the name; click it to copy. Same gesture flips back. Hidden otherwise.
function altDoubleClickToggle(onToggle: () => void) {
  return (e: React.MouseEvent) => {
    if (!e.altKey) return
    // Suppress the browser's default word-selection on double-click.
    e.preventDefault()
    window.getSelection()?.removeAllRanges()
    onToggle()
  }
}

/** What a person is called in the workforce table. Shared by the row and the
 *  sort so the list is ordered by the name actually on screen: someone with no
 *  first name shows their email, and must sort by that too. */
function personDisplayName(p: { firstName?: string | null; lastName?: string | null; email: string }): string {
  return p.firstName?.trim() ? `${p.firstName} ${p.lastName}`.trim() : p.email
}

function IdReveal({ id, name }: { id: string; name: string }) {
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current)
  }, [])

  const handleCopy = (e: React.SyntheticEvent) => {
    e.stopPropagation()
    void navigator.clipboard?.writeText(id).catch(() => {})
    setCopied(true)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), 1200)
  }

  return (
    <Tooltip text={copied ? 'Copied' : name} position="top">
      <span
        className="agent-id-reveal"
        role="button"
        tabIndex={0}
        onClick={handleCopy}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleCopy(e) }
        }}
      >{id}</span>
    </Tooltip>
  )
}

// Table row component for a team
type TeamRowProps = {
  type: 'ai_team'
  team: InternalAgent
  allExternalAgents: ExternalAgent[]
  lastActivity?: string | null
  lastActivityAction?: string | null
  onUpdate: () => void
  /** Straight into the conversation. Internal teams only — an external
   *  collaborator has no chat of its own to open. */
  onChat: () => void
  /** This team has replied in a thread nobody has read. */
  hasUnread?: boolean
  onPause: () => void
  /** Straight to the Activity feed, already scoped to this team. */
  onInspect: () => void
  onDelete: () => void
  toggleLabel: string
  isPausing?: boolean
  isDeleting?: boolean
  showIds: boolean
  onToggleIds: () => void
} | {
  type: 'external_agent'
  agent: ExternalAgent
  allTeams: InternalAgent[]
  lastActivity?: string | null
  lastActivityAction?: string | null
  onUpdate: () => void
  onPause: () => void
  /** Straight to the Activity feed, already scoped to this collaborator. */
  onInspect: () => void
  onDelete: () => void
  toggleLabel: string
  isPausing?: boolean
  isDeleting?: boolean
  showIds: boolean
  onToggleIds: () => void
}

/**
 * The status pill and whatever tooltip belongs on it. Shared by the table row
 * and the card so the two cannot drift, which they had already started to do.
 * A pill that reports a broken binding also links to the page that repairs it.
 */
function StatusPill(props: {
  label: string
  variant: 'active' | 'neutral' | 'draft' | 'error'
  tooltip?: string
  linkToConnections?: boolean
}) {
  const badge = <StatusBadge variant={props.variant}>{props.label}</StatusBadge>
  const body = props.linkToConnections
    ? <Link to="/dashboard/connections" className="agents-table__status-link">{badge}</Link>
    : badge
  if (!props.tooltip) return body
  return <Tooltip text={props.tooltip} position="top"><span>{body}</span></Tooltip>
}

function TeamRow(props: TeamRowProps) {
  const isExternal = props.type === 'external_agent'
  // Only internal teams have a chat to be unread; the prop is absent on the
  // external variant of the union.
  const hasUnread = !isExternal && (props as { hasUnread?: boolean }).hasUnread === true
  const name = isExternal ? props.agent.name : props.team.role
  const id = isExternal ? props.agent.id : props.team.id
  const description = isExternal
    ? (props.agent.description || props.agent.summary || 'No description')
    : (props.team.summary || props.team.responsibilities)
  const tasks30d = (isExternal ? props.agent.tasks30d : props.team.tasks30d) ?? 0

  // Status handling
  let statusLabel: string
  let statusVariant: 'active' | 'neutral' | 'draft' | 'error'
  let statusTooltip: string | undefined

  const evaluateBindingHealth = useBindingHealth()
  const bindingHealth = evaluateBindingHealth(isExternal ? null : props.team.integrations)

  if (isExternal) {
    const status = props.agent.status
    statusLabel = status === 'connected' ? 'Active'
      : status === 'pending' || status === 'pending_review' ? 'Awaiting Launch'
      : status === 'disconnected' ? 'Paused'
      : status === 'error' ? 'Error' : 'Unknown'
    statusVariant = status === 'connected' ? 'active'
      : status === 'pending' || status === 'pending_review' ? 'draft'
      : status === 'error' ? 'error' : 'neutral'
    statusTooltip = status === 'disconnected' ? 'Connection lost. Please check connection.'
      : status === 'error' ? 'Authentication error. Please check connection.' : undefined
  } else {
    const status = props.team.status
    statusLabel = status === 'active' ? 'Active' : status === 'paused' ? 'Paused' : 'Awaiting Launch'
    statusVariant = status === 'active' ? 'active' : status === 'paused' ? 'neutral' : 'draft'
  }

  // A binding the agent cannot use outranks its lifecycle status. A paused
  // team with a dead connection still needs that connection fixed, and Resume
  // stays reachable from the row action, so nothing is hidden by this.
  if (bindingHealth.isBroken) {
    statusLabel = 'Error'
    statusVariant = 'error'
    statusTooltip = bindingHealth.message
  }

  return (
    <tr className={`agents-table__row ${props.isDeleting ? 'agents-table__row--deleting' : ''}`}>
      <td className="agents-table__cell agents-table__cell--name">
        <div className="agents-table__name-wrapper">
          {/* The name is the way into the conversation, for internal teams
              only. X-ray mode wins: there the name is the handle for copying
              the id, so it stays plain text rather than swallowing the click.
              Deliberately still a <span>: swapping in a <button> would change
              how the name renders, and the only thing that should change here
              is that it responds to a click. */}
          {!isExternal && !props.showIds ? (
            <span
              className="agents-table__name agents-table__name--clickable"
              role="button"
              tabIndex={0}
              onClick={(props as { onChat: () => void }).onChat}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  ;(props as { onChat: () => void }).onChat()
                }
              }}
            >
              {name}
            </span>
          ) : (
            <span className="agents-table__name">{props.showIds ? <IdReveal id={id} name={name} /> : name}</span>
          )}
          {isExternal && (
            <Tooltip text="External Agent" position="top">
              <span className="agents-table__external-icon">
                <PlugIcon />
              </span>
            </Tooltip>
          )}
        </div>
      </td>
      <td className="agents-table__cell agents-table__cell--status" onDoubleClick={altDoubleClickToggle(props.onToggleIds)}>
        <StatusPill
          label={statusLabel}
          variant={statusVariant}
          tooltip={statusTooltip}
          linkToConnections={bindingHealth.isBroken}
        />
      </td>
      <td className="agents-table__cell agents-table__cell--description">
        <Tooltip text={description} position="bottom">
          <span className="agents-table__description">{description}</span>
        </Tooltip>
      </td>
      <td className="agents-table__cell agents-table__cell--integrations">
        {isExternal ? (
          <div className="agents-table__integrations">
            {(props.agent.allowedInternalAgentIds?.length ?? 0) > 0 && (
              <>
                <Tooltip text="Agents" position="top">
                  <span className="agent-card__integration agent-card__integration--team">
                    <TeamIcon />
                  </span>
                </Tooltip>
                {(props.agent.allowedInternalAgentIds?.length ?? 0) > 1 && (
                  <span className="agent-card__integration-count">×{props.agent.allowedInternalAgentIds?.length}</span>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="agents-table__integrations">
            {(() => {
              const externalAgentIds = new Set(props.allExternalAgents.map(a => a.id))
              const validIntegrations = (props.team.integrations || []).filter(i => i?.id != null)
              const appIntegrations = validIntegrations
                .filter(i => !externalAgentIds.has(i.id))
              const externalAgentCount = validIntegrations
                .filter(i => externalAgentIds.has(i.id))
                .length

              return (
                <IntegrationIconsDisplay
                  appIntegrations={appIntegrations}
                  externalAgentCount={externalAgentCount}
                  classPrefix="agent-card"
                />
              )
            })()}
          </div>
        )}
      </td>
      <td className="agents-table__cell agents-table__cell--tasks">
        {tasks30d.toLocaleString()}
      </td>
      <td className="agents-table__cell agents-table__cell--activity">
        {!props.lastActivity ? (
          <span className="agents-table__activity-empty">No activity</span>
        ) : (
          <span className="agents-table__activity">
            {props.lastActivityAction && (
              <Tooltip text={formatActionLabel(props.lastActivityAction)} position="top">
                <code>{formatActionLabel(props.lastActivityAction)}</code>
              </Tooltip>
            )}
            <span className="agents-table__activity-time">{formatTimeAgo(props.lastActivity)}</span>
          </span>
        )}
      </td>
      <td className="agents-table__cell agents-table__cell--actions">
        <div className="agents-table__actions">
        {!isExternal && (
          <Tooltip text="Message Team" position="top">
            {/* The unread dot rides this button, which is where the menu item
                that used to carry it went. Colour alone reaches neither a
                screen reader nor a colour-blind reader, so the state is in the
                accessible name too. */}
            <span className="agents-table__chat-btn-wrap">
              <button
                type="button"
                className="agents-table__chat-btn"
                aria-label={hasUnread ? `Message ${name}, unread replies` : `Message ${name}`}
                onClick={(props as { onChat: () => void }).onChat}
              >
                <MessageCircleIcon width="18" height="18" />
              </button>
              {hasUnread && <span className="agents-table__chat-btn-dot" />}
            </span>
          </Tooltip>
        )}
        <PermissionGate permission="edit_teams" fallback={null}>
          <ActionMenu
            disabled={props.isPausing || props.isDeleting}
            items={[
              { label: 'Update Team', onClick: props.onUpdate },
              { label: props.isPausing ? 'Updating...' : props.toggleLabel, onClick: props.onPause, disabled: props.isPausing },
              { label: 'Inspect Team', onClick: props.onInspect },
              { label: props.isDeleting ? 'Archiving...' : 'Archive Team', onClick: props.onDelete, disabled: props.isDeleting },
            ]}
          />
        </PermissionGate>
        </div>
      </td>
    </tr>
  )
}

// Unified card for both agents and external agents
type TeamCardProps = {
  type: 'ai_team'
  team: InternalAgent
  allExternalAgents: ExternalAgent[]  // All external agents (to identify which integrations are external agents)
  lastActivity?: string | null
  lastActivityAction?: string | null
  onUpdate: () => void
  /** Straight into the conversation. Internal teams only. */
  onChat: () => void
  /** This team has replied in a thread nobody has read. */
  hasUnread?: boolean
  onPause: () => void
  /** Straight to the Activity feed, already scoped to this team. */
  onInspect: () => void
  onDelete: () => void
  toggleLabel: string
  isPausing?: boolean
  isDeleting?: boolean
  showIds: boolean
  onToggleIds: () => void
  compact?: boolean  // Mobile-optimized: fewer integration slots, hide started date
} | {
  type: 'external_agent'
  agent: ExternalAgent
  allTeams: InternalAgent[]
  lastActivity?: string | null
  lastActivityAction?: string | null
  onUpdate: () => void
  onPause: () => void
  /** Straight to the Activity feed, already scoped to this collaborator. */
  onInspect: () => void
  onDelete: () => void
  toggleLabel: string
  isPausing?: boolean
  isDeleting?: boolean
  showIds: boolean
  onToggleIds: () => void
  compact?: boolean  // Mobile-optimized: fewer integration slots, hide started date
}

function TeamCard(props: TeamCardProps) {
  const [scopeExpanded, setScopeExpanded] = useState(false)
  const [isTruncated, setIsTruncated] = useState(false)
  const descriptionRef = useRef<HTMLParagraphElement>(null)

  const isExternal = props.type === 'external_agent'
  // Only internal teams have a chat to be unread; the prop is absent on the
  // external variant of the union.
  const hasUnread = !isExternal && (props as { hasUnread?: boolean }).hasUnread === true
  const name = isExternal ? props.agent.name : props.team.role
  const id = isExternal ? props.agent.id : props.team.id
  const description = isExternal
    ? (props.agent.description || props.agent.summary || 'No description')
    : (props.team.summary || props.team.responsibilities)
  const createdAt = isExternal ? props.agent.createdAt : props.team.createdAt
  const tasks30d = (isExternal ? props.agent.tasks30d : props.team.tasks30d) ?? 0

  // Status handling
  let statusLabel: string
  let statusVariant: 'active' | 'neutral' | 'draft' | 'error'
  let cardStatusClass: string
  let statusTooltip: string | undefined

  const evaluateBindingHealth = useBindingHealth()
  const bindingHealth = evaluateBindingHealth(isExternal ? null : props.team.integrations)

  if (isExternal) {
    const status = props.agent.status
    statusLabel = status === 'connected' ? 'Active'
      : status === 'pending' || status === 'pending_review' ? 'Awaiting Launch'
      : status === 'disconnected' ? 'Paused'
      : status === 'error' ? 'Error' : 'Unknown'
    statusVariant = status === 'connected' ? 'active'
      : status === 'pending' || status === 'pending_review' ? 'draft'
      : status === 'error' ? 'error' : 'neutral'
    cardStatusClass = ''
    statusTooltip = status === 'disconnected' ? 'Connection lost. Please check connection.'
      : status === 'error' ? 'Authentication error. Please check connection.' : undefined
  } else {
    const status = props.team.status
    statusLabel = status === 'active' ? 'Active' : status === 'paused' ? 'Paused' : 'Awaiting Launch'
    statusVariant = status === 'active' ? 'active' : status === 'paused' ? 'neutral' : 'draft'
    cardStatusClass = `agent-card--${status}`
  }

  // Same precedence as the table row: a binding the agent cannot use outranks
  // the lifecycle status. The card keeps its paused styling either way.
  if (bindingHealth.isBroken) {
    statusLabel = 'Error'
    statusVariant = 'error'
    statusTooltip = bindingHealth.message
  }

  useEffect(() => {
    const el = descriptionRef.current
    if (el) {
      setIsTruncated(el.scrollHeight > el.clientHeight)
    }
  }, [description])

  return (
    <div className={`agent-card ${cardStatusClass} ${props.isDeleting ? 'agent-card--deleting' : ''}`}>
      <div className="agent-card__header">
        <h3 className="agent-card__name">
          {/* Same rule as the table row, and the same reason for staying a
              <span>: click behaviour only, nothing about how it renders. */}
          {!isExternal && !props.showIds ? (
            <span
              className="agent-card__name--clickable"
              role="button"
              tabIndex={0}
              onClick={(props as { onChat: () => void }).onChat}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  ;(props as { onChat: () => void }).onChat()
                }
              }}
            >
              {name}
            </span>
          ) : (
            props.showIds ? <IdReveal id={id} name={name} /> : name
          )}
          {isExternal && props.compact && (
            <Tooltip text="External Agent" position="top">
              <span className="agent-card__external-icon">
                <PlugIcon />
              </span>
            </Tooltip>
          )}
        </h3>
        <div className="agent-card__header-actions">
          <span className="agent-card__status-hit" onDoubleClick={altDoubleClickToggle(props.onToggleIds)}>
            <StatusPill
              label={statusLabel}
              variant={statusVariant}
              tooltip={statusTooltip}
              linkToConnections={bindingHealth.isBroken}
            />
          </span>
          {!isExternal && (
            <Tooltip text="Message Team" position="top">
              <span className="agents-table__chat-btn-wrap">
                <button
                  type="button"
                  className="agent-card__chat-btn"
                  aria-label={hasUnread ? `Message ${name}, unread replies` : `Message ${name}`}
                  onClick={(props as { onChat: () => void }).onChat}
                >
                  <MessageCircleIcon width="18" height="18" />
                </button>
                {hasUnread && <span className="agents-table__chat-btn-dot" />}
              </span>
            </Tooltip>
          )}
          <PermissionGate permission="edit_teams" fallback={null}>
            <ActionMenu
              disabled={props.isPausing || props.isDeleting}
              items={[
                { label: 'Update Team', onClick: props.onUpdate },
                { label: props.isPausing ? 'Updating...' : props.toggleLabel, onClick: props.onPause, disabled: props.isPausing },
                { label: 'Inspect Team', onClick: props.onInspect },
                { label: props.isDeleting ? 'Archiving...' : 'Archive Team', onClick: props.onDelete, disabled: props.isDeleting },
              ]}
            />
          </PermissionGate>
        </div>
      </div>

      {/* The role, the tabstop and both handlers are gated on the same
          `isTruncated`, so this is either a plain paragraph or a complete
          disclosure control, never a <p> carrying a handler nobody can reach.
          The rule reads each attribute on its own and cannot see that. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <p
        ref={descriptionRef}
        className={`agent-card__description ${scopeExpanded ? 'agent-card__description--expanded' : ''} ${isTruncated && !scopeExpanded ? 'agent-card__description--truncated' : ''}`}
        role={isTruncated ? 'button' : undefined}
        tabIndex={isTruncated ? 0 : undefined}
        aria-expanded={isTruncated ? scopeExpanded : undefined}
        onClick={isTruncated ? (() => setScopeExpanded(!scopeExpanded)) : undefined}
        onKeyDown={isTruncated ? (e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setScopeExpanded(!scopeExpanded) }
        }) : undefined}
      >
        {description}
      </p>

      <div className="agent-card__integrations-row">
        <div className="agent-card__integrations">
          {isExternal ? (
            <>
              {/* External agent: show single team icon with count */}
              {(props.agent.allowedInternalAgentIds?.length ?? 0) > 0 && (
                <>
                  <span className="agent-card__integration agent-card__integration--team" title="Agents">
                    <TeamIcon />
                  </span>
                  {(props.agent.allowedInternalAgentIds?.length ?? 0) > 1 && (
                    <span className="agent-card__integration-count">×{props.agent.allowedInternalAgentIds?.length}</span>
                  )}
                </>
              )}
            </>
          ) : (
            <>
              {/* agent: separate app integrations from external agents */}
              {(() => {
                const externalAgentIds = new Set(props.allExternalAgents.map(a => a.id))
                const validIntegrations = (props.team.integrations || []).filter(i => i?.id != null)
                const appIntegrations = validIntegrations
                  .filter(i => !externalAgentIds.has(i.id))
                const externalAgentCount = validIntegrations
                  .filter(i => externalAgentIds.has(i.id))
                  .length

                return (
                  <IntegrationIconsDisplay
                    appIntegrations={appIntegrations}
                    externalAgentCount={externalAgentCount}
                    classPrefix="agent-card"
                    maxSlots={props.compact ? 5 : 8}
                  />
                )
              })()}
            </>
          )}
        </div>
        {isExternal && !props.compact && (
          <StatusBadge variant="external">External Agent</StatusBadge>
        )}
      </div>

      <div className="agent-card__meta">
        <div className="agent-card__meta-item">
          <span className="agent-card__meta-label">Tasks Last 30 Days</span>
          <span className="agent-card__meta-value">{tasks30d.toLocaleString()}</span>
        </div>
        {!props.compact && (
          <div className="agent-card__meta-item">
            <span className="agent-card__meta-label">Started</span>
            <span className="agent-card__meta-value">{formatDate(createdAt)}</span>
          </div>
        )}
      </div>

      <div className="agent-card__activity">
        {!props.lastActivity ? (
          <span className="agent-card__activity-empty">No activity yet</span>
        ) : (
          <span className="agent-card__activity-line">
            {props.lastActivityAction && (
              <Tooltip text={formatActionLabel(props.lastActivityAction)} position="top">
                <code>{formatActionLabel(props.lastActivityAction)}</code>
              </Tooltip>
            )} · <span className="agent-card__activity-time">{formatTimeAgo(props.lastActivity)}</span>
          </span>
        )}
      </div>
    </div>
  )
}

export default function AgentsPage() {
  const navigate = useNavigate()
  const { showToast } = useToast()
  const { openIfPaymentRequired } = usePlanGate()
  const [workforceCategory, setWorkforceCategory] = useState<WorkforceCategory>('all')
  const [statusFilter, setStatusFilter] = useState<FilterType>('all')
  const [teamTypeFilter, setTeamTypeFilter] = useState<TeamTypeFilter>({ ai_teams: true, external_collaborators: true, people: true })
  // Internal "x-ray" mode: reveals agent backend IDs in place of names (see IdReveal).
  const [showIds, setShowIds] = useState(false)
  const toggleIds = () => setShowIds(v => !v)
  const [filterDropdownOpen, setFilterDropdownOpen] = useState(false)
  const filterDropdownRef = useRef<HTMLDivElement>(null)
  const [sortColumn, setSortColumn] = useState<SortColumn>(null)
  const [sortDirection, setSortDirection] = useState<SortDirection>(null)
  const [editingPerson, setEditingPerson] = useState<PersonnelMember | null>(null)
  const viewedRef = useRef(false)

  // Close filter dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (filterDropdownRef.current && !filterDropdownRef.current.contains(e.target as Node)) {
        setFilterDropdownOpen(false)
      }
    }
    if (filterDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [filterDropdownOpen])

  // Handle column header click for sorting
  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      // Cycle through: asc -> desc -> null
      if (sortDirection === 'asc') {
        if (column) track('teams_sort_changed', { column, direction: 'desc' })
        setSortDirection('desc')
      } else if (sortDirection === 'desc') {
        setSortColumn(null)
        setSortDirection(null)
      }
    } else {
      if (column) track('teams_sort_changed', { column, direction: 'asc' })
      setSortColumn(column)
      setSortDirection('asc')
    }
  }

  // Get sort indicator arrow
  const getSortIndicator = (column: SortColumn) => {
    if (sortColumn !== column) return null
    return sortDirection === 'asc' ? ' ↑' : ' ↓'
  }

  const {
    data: workforceData,
    isPending: isWorkforceLoading,
    error: workforceError,
    refetch: refetchWorkforce,
  } = useWorkforce()

  const teams = workforceData?.internalAgents ?? []
  const externalAgents = workforceData?.externalAgents ?? []

  // One call for the whole page. Asked per row it would be one request per
  // team, all answering the same tenant-wide question.
  const { data: unreadCounts } = useChatUnreadCounts()
  // The Chief AI Officer's own surface: its dot rides the Plan Workforce
  // button in the header, from the same count its history modal's row dots
  // read, so the two indicators cannot disagree.
  const { data: teamPlanUnreadCount } = useTeamPlanUnreadCount()
  const hasUnreadTeamPlan = (teamPlanUnreadCount ?? 0) > 0
  const personnel = useMemo(() => workforceData?.personnel ?? [], [workforceData])

  const claudeCodeKeys = workforceData?.claudeCodeKeys ?? []

  useEffect(() => {
    if (viewedRef.current || isWorkforceLoading) return
    viewedRef.current = true
    track('teams_viewed', {
      total_teams: teams.length,
      total_external: externalAgents.length,
      total_claude_code: claudeCodeKeys.length,
    })
  }, [isWorkforceLoading, teams.length, externalAgents.length, claudeCodeKeys.length])

  // Mutations
  const deleteTeamMutation = useDeleteInternalAgent()
  const updateStatusMutation = useUpdateInternalAgentStatus()
  const deleteExternalAgentMutation = useDeleteExternalAgent()
  const updateExternalAgentStatusMutation = useUpdateExternalAgentStatus()
  const deleteClaudeCodeKeyMutation = useDeleteClaudeCodeProxyKey()
  const revokeMcpTokenMutation = useRevokeMcpToken()

  const handleUpdateTeam = (team: InternalAgent) => {
    track('teams_row_clicked', { kind: 'ai_team', id: team.id })
    navigate('/dashboard/agents/update', { state: { teamId: team.id } })
  }

  const handleUpdateExternalAgent = (agent: ExternalAgent) => {
    track('teams_row_clicked', { kind: 'external_agent', id: agent.id })
    navigate('/dashboard/agents/update', { state: { agentId: agent.id } })
  }

  // "Inspect Team" — the Activity feed with the team's name already typed into
  // the search box, so nobody has to go and search for their own team. The name
  // rides router state rather than the URL: /dashboard/activity stays clean and
  // nothing identifying is ever exposed in the address bar.
  const handleInspectTeam = (team: InternalAgent) => {
    track('teams_inspect_clicked', { kind: 'ai_team', id: team.id })
    const state: ActivityLocationState = { teamSearch: team.role }
    navigate('/dashboard/activity', { state })
  }

  const handleInspectExternalAgent = (agent: ExternalAgent) => {
    track('teams_inspect_clicked', { kind: 'external_agent', id: agent.id })
    const state: ActivityLocationState = { teamSearch: agent.name }
    navigate('/dashboard/activity', { state })
  }

  const handleDeleteExternalAgent = (agent: ExternalAgent) => {
    deleteExternalAgentMutation.mutate(agent.id, {
      onSuccess: () => {
        showToast('Team archived successfully', 'success')
      },
      onError: () => {
        showToast('Failed to archive team', 'error')
      },
    })
  }

  const handlePauseExternalAgent = (agent: ExternalAgent) => {
    const newStatus: ExternalAgentStatus = agent.status === 'disconnected' ? 'connected' : 'disconnected'
    updateExternalAgentStatusMutation.mutate(
      { agentId: agent.id, status: newStatus },
      {
        onSuccess: () => {
          showToast(`Team ${newStatus === 'connected' ? 'activated' : 'paused'} successfully`, 'success')
        },
        onError: () => {
          showToast('Failed to update team status', 'error')
        },
      }
    )
  }

  const handlePauseTeam = (team: InternalAgent) => {
    const newStatus: InternalAgentStatus = team.status === 'paused' || team.status === 'draft' ? 'active' : 'paused'
    updateStatusMutation.mutate(
      { internalAgentId: team.id, status: newStatus },
      {
        onSuccess: () => {
          showToast(`Team ${newStatus === 'active' ? 'activated' : 'paused'} successfully`, 'success')
        },
        // Starting a draft team on a workspace with no plan answers 402. That
        // is the paywall, not a failure — a draft saved during the unpaid
        // build-first flow is meant to land here and wait. Collect payment
        // instead of telling the user the update failed.
        onError: (err) => {
          if (openIfPaymentRequired(err)) return
          showToast('Failed to update team status', 'error')
        },
      }
    )
  }

  const handleDeleteTeam = (team: InternalAgent) => {
    deleteTeamMutation.mutate(team.id, {
      onSuccess: () => {
        showToast('Team archived successfully', 'success')
      },
      onError: () => {
        showToast('Failed to archive team', 'error')
      },
    })
  }

  const handleUpdateClaudeCode = (key: WorkforceClaudeCodeKey) => {
    track('teams_row_clicked', { kind: 'claude_code', id: key.id })
    navigate('/dashboard/agents/update', { state: { codingToolId: key.id } })
  }

  const handleDeleteClaudeCode = (key: WorkforceClaudeCodeKey) => {
    const mutation = key.keyType === 'mcp' ? revokeMcpTokenMutation : deleteClaudeCodeKeyMutation
    const { label } = connectionBrand(key)
    mutation.mutate(key.id, {
      onSuccess: () => {
        track('claude_code_key_revoked', {
          key_id: key.id,
          key_type: key.keyType === 'mcp' ? 'mcp' : 'proxy',
        })
        showToast(`${label} connection revoked`, 'success')
      },
      onError: () => {
        showToast(`Failed to revoke ${label} connection`, 'error')
      },
    })
  }

  const filteredTeams = teams.filter(team => {
    if (statusFilter === 'all') return true
    return normalizeToFilterStatus(team.status) === statusFilter
  })

  const filteredExternalAgents = externalAgents.filter(agent => {
    if (statusFilter === 'all') return true
    return normalizeToFilterStatus(agent.status) === statusFilter
  })

  // Claude Code keys: 'active' maps to 'active', 'revoked' maps to 'paused'
  const filteredClaudeCodeKeys = claudeCodeKeys.filter(key => {
    if (statusFilter === 'all') return true
    const normalized: InternalAgentStatus = key.status === 'active' ? 'active' : 'paused'
    return normalized === statusFilter
  })

  // Unified sorted list of teams, external agents, and Claude Code proxy keys
  type UnifiedItem =
    | { type: 'ai_team'; team: InternalAgent }
    | { type: 'external_agent'; agent: ExternalAgent }
    | { type: 'claude_code'; key: WorkforceClaudeCodeKey }

  // Helper to compare with null handling
  // Ascending: null first, then zero, then increasing
  // Descending: decreasing, then zero, then null last
  const compareWithNulls = (a: number | null, b: number | null, direction: 'asc' | 'desc'): number => {
    const aIsNull = a === null
    const bIsNull = b === null

    if (aIsNull && bIsNull) return 0
    if (direction === 'asc') {
      if (aIsNull) return -1
      if (bIsNull) return 1
    } else {
      if (aIsNull) return 1
      if (bIsNull) return -1
    }
    return direction === 'asc' ? a - b : b - a
  }

  function formatAssignmentDescription(assignments: { agentName: string }[]): string {
    if (assignments.length === 0) return ''
    const names = assignments.map(a => a.agentName)
    if (names.length === 1) return `Works with ${names[0]}`
    if (names.length === 2) return `Works with ${names[0]} and ${names[1]}`
    return `Works with ${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
  }

  function mapOnboardStatus(status: string | null): 'complete' | 'in_progress' | 'not_started' | 'error' {
    // Members with no payroll record are Active (they have workspace access)
    if (!status) return 'complete'
    if (status === 'completed') return 'complete'
    if (status === 'blocking' || status === 'needs_attention') return 'error'
    if (status === 'in_progress') return 'in_progress'
    return 'complete'
  }

  // Filter personnel by status, then sort by name. The sort is the page's own:
  // this list used to render in whatever order the workforce payload arrived
  // in, which looked alphabetical only for as long as the API happened to
  // return it that way. Sorted here, the third band reads like the two above
  // it. Note that the column headers still do not reach this list — clicking
  // Cost sorts the AI rows only, and people stay by name below them.
  const filteredHumanWorkforce = useMemo(() => {
    const matching = statusFilter === 'all' ? personnel : personnel.filter(p => {
      const mapped = mapOnboardStatus(p.onboardStatus)
      if (statusFilter === 'active') return mapped === 'complete'
      if (statusFilter === 'onboarding') return mapped === 'in_progress'
      if (statusFilter === 'invited') return mapped === 'not_started'
      if (statusFilter === 'error') return mapped === 'error'
      return false
    })
    // Copy before sorting: `personnel` is a memo the render also reads, and
    // Array.sort mutates in place.
    return [...matching].sort((a, b) => personDisplayName(a).localeCompare(personDisplayName(b)))
  }, [personnel, statusFilter])

  // Personnel status counts for filter labels
  const personnelStatusCounts = useMemo(() => {
    const counts = { active: 0, onboarding: 0, invited: 0, error: 0 }
    for (const p of personnel) {
      const mapped = mapOnboardStatus(p.onboardStatus)
      if (mapped === 'complete') counts.active++
      else if (mapped === 'in_progress') counts.onboarding++
      else if (mapped === 'not_started') counts.invited++
      else if (mapped === 'error') counts.error++
    }
    return counts
  }, [personnel])

  const sortedItems = useMemo(() => {
    if (workforceCategory === 'human_workforce') {
      return []
    }

    // Build unified list based on teamTypeFilter checkboxes
    // (workforceCategory 'all' and 'ai_workforce' both show all agents/agents)
    const items: UnifiedItem[] = []
    if (teamTypeFilter.ai_teams) {
      items.push(...filteredTeams.map(team => ({ type: 'ai_team' as const, team })))
    }
    if (teamTypeFilter.external_collaborators) {
      items.push(...filteredExternalAgents.map(agent => ({ type: 'external_agent' as const, agent })))
      items.push(...filteredClaudeCodeKeys.map(key => ({ type: 'claude_code' as const, key })))
    }

    // Helper to get values from unified item
    const getName = (item: UnifiedItem) =>
      item.type === 'ai_team' ? item.team.role
      : item.type === 'external_agent' ? item.agent.name
      : item.key.name
    const getStatus = (item: UnifiedItem) =>
      item.type === 'ai_team' ? item.team.status
      : item.type === 'external_agent' ? item.agent.status
      : item.key.status
    const getDescription = (item: UnifiedItem) =>
      item.type === 'ai_team' ? (item.team.summary || '')
      : item.type === 'external_agent' ? (item.agent.description || '')
      : (item.key.description || '')
    const getIntegrationsCount = (item: UnifiedItem) =>
      item.type === 'ai_team' ? item.team.integrations.length
      : item.type === 'external_agent' ? (item.agent.allowedInternalAgentIds?.length ?? 0)
      : 0
    const getTasks = (item: UnifiedItem) =>
      item.type === 'ai_team' ? (item.team.tasks30d ?? 0)
      : item.type === 'external_agent' ? (item.agent.tasks30d ?? 0)
      : 0
    const getActivityTime = (item: UnifiedItem): number | null => {
      if (item.type === 'claude_code') {
        return item.key.lastUsedAt ? new Date(item.key.lastUsedAt).getTime() : null
      }
      const ts = item.type === 'ai_team' ? item.team.lastActivity : item.agent.lastActivity
      return ts ? new Date(ts).getTime() : null
    }

    // Where a row sits in the default order, before any name comparison: the
    // workspace's own teams, then everyone connected in from outside (external
    // agents and coding-tool keys share the External Agents filter, so
    // they share a band and interleave by name within it). Human workforce is
    // not here because it is rendered as its own block after this list.
    const getOriginRank = (item: UnifiedItem) => (item.type === 'ai_team' ? 0 : 1)

    if (!sortColumn || !sortDirection) {
      // Default sort: internal before external, then name asc, status asc,
      // activity asc (nulls first).
      return items.sort((a, b) => {
        const originCompare = getOriginRank(a) - getOriginRank(b)
        if (originCompare !== 0) return originCompare
        const nameCompare = getName(a).localeCompare(getName(b))
        if (nameCompare !== 0) return nameCompare
        const statusCompare = getStatus(a).localeCompare(getStatus(b))
        if (statusCompare !== 0) return statusCompare
        return compareWithNulls(getActivityTime(a), getActivityTime(b), 'asc')
      })
    }

    return items.sort((a, b) => {
      switch (sortColumn) {
        case 'name':
          return sortDirection === 'asc'
            ? getName(a).localeCompare(getName(b))
            : getName(b).localeCompare(getName(a))
        case 'status':
          return sortDirection === 'asc'
            ? getStatus(a).localeCompare(getStatus(b))
            : getStatus(b).localeCompare(getStatus(a))
        case 'description':
          return sortDirection === 'asc'
            ? getDescription(a).localeCompare(getDescription(b))
            : getDescription(b).localeCompare(getDescription(a))
        case 'integrations':
          return sortDirection === 'asc'
            ? getIntegrationsCount(a) - getIntegrationsCount(b)
            : getIntegrationsCount(b) - getIntegrationsCount(a)
        case 'tasks':
          return sortDirection === 'asc'
            ? getTasks(a) - getTasks(b)
            : getTasks(b) - getTasks(a)
        case 'activity':
          return compareWithNulls(getActivityTime(a), getActivityTime(b), sortDirection)
        default:
          return 0
      }
    })
  }, [workforceCategory, filteredTeams, filteredExternalAgents, filteredClaudeCodeKeys, teamTypeFilter, sortColumn, sortDirection])

  // Centralized team stats (shared with HomePage)
  const { activeTeams, tasksCompletedLast30Days, hoursSavedLast30Days } = useAgentStats()

  // Dev-only: force error state with ?forceError=true
  const [searchParams, setSearchParams] = useSearchParams()
  const forceError = searchParams.get('forceError') === 'true'

  // Show toast for Slack OAuth callback status. `slack` = legacy per-agent
  // installs; `slack_workspace` = the workspace app connect (ADR-040).
  useEffect(() => {
    const slackStatus = searchParams.get('slack') ?? searchParams.get('slack_workspace')
    if (!slackStatus) return

    if (slackStatus === 'installed') {
      showToast('Slack integration installed successfully', 'success')
    } else if (slackStatus === 'cancelled') {
      showToast('Slack installation was cancelled', 'success')
    } else if (slackStatus === 'error') {
      showToast('Slack installation failed. Please try again.', 'error')
    }

    // Clear the query param so the toast doesn't re-show on refresh
    setSearchParams(prev => {
      prev.delete('slack')
      prev.delete('slack_workspace')
      prev.delete('reason')
      return prev
    }, { replace: true })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Error state (FE-002)
  if (workforceError || forceError) {
    return (
      <ErrorState
        onRetry={() => { refetchWorkforce() }}
      />
    )
  }

  // Loading skeleton - use isPending to show skeleton when query is disabled (tenant not ready) or loading
  if (isWorkforceLoading) {
    return (
      <div className="agents-page">
        <div className="agents-page__header">
          <div className="skeleton-text skeleton-text--title skeleton-pulse" style={{ width: '150px' }} />
          <div className="agents-page__actions">
            <div className="skeleton-text skeleton-pulse" style={{ width: '36px', height: '36px', borderRadius: '8px' }} />
            <div className="skeleton-text skeleton-pulse" style={{ width: '36px', height: '36px', borderRadius: '8px' }} />
            <div className="skeleton-text skeleton-pulse" style={{ width: '36px', height: '36px', borderRadius: '8px' }} />
            <div className="skeleton-text skeleton-pulse" style={{ width: '120px', height: '36px', borderRadius: '8px' }} />
          </div>
        </div>
        {/* Same guard as the real summary below: a skeleton for a row that never
            arrives is a placeholder that reserves space, pulses, and then
            collapses. Three, not four — the row it stands in for has three
            cards, and the fourth was reserving space nothing ever filled. */}
        {SHOW_TEAM_SUMMARY && (
          <div className="agents-page__summary">
            {[1, 2, 3].map(i => (
              <div key={i} className="agents-page__stat">
                <div className="skeleton-text skeleton-pulse" style={{ width: '60px', height: '32px' }} />
                <div className="skeleton-text skeleton-pulse" style={{ width: '100px', height: '16px' }} />
              </div>
            ))}
          </div>
        )}
        <div className="agents-page__filters-row">
          <div className="skeleton-text skeleton-pulse" style={{ width: '240px', height: '36px', borderRadius: '8px' }} />
          <div className="skeleton-text skeleton-pulse" style={{ width: '120px', height: '36px', borderRadius: '8px' }} />
        </div>

        {/* Desktop: table skeleton */}
        <div className="agents-table-wrapper">
          <table className="agents-table">
            <thead>
              <tr>
                <th className="agents-table__header">Team</th>
                <th className="agents-table__header">Status</th>
                <th className="agents-table__header">Description</th>
                <th className="agents-table__header">Integrations</th>
                <th className="agents-table__header">Tasks Last 30 Days</th>
                <th className="agents-table__header">Last Activity</th>
                <th className="agents-table__header"></th>
              </tr>
            </thead>
            <tbody>
              {[1, 2, 3, 4, 5].map(i => (
                <tr key={i} className="agents-table__row">
                  <td className="agents-table__cell agents-table__cell--name">
                    <div className="skeleton-text skeleton-pulse" style={{ width: `${50 + i * 8}%` }} />
                  </td>
                  <td className="agents-table__cell agents-table__cell--status">
                    <div className="skeleton-text skeleton-pulse" style={{ width: '70px', height: '24px', borderRadius: '12px' }} />
                  </td>
                  <td className="agents-table__cell">
                    <div className="skeleton-text skeleton-pulse" style={{ width: '90%' }} />
                  </td>
                  <td className="agents-table__cell">
                    <div className="skeleton-text skeleton-pulse" style={{ width: '80px' }} />
                  </td>
                  <td className="agents-table__cell">
                    <div className="skeleton-text skeleton-pulse" style={{ width: '40px' }} />
                  </td>
                  <td className="agents-table__cell">
                    <div className="skeleton-text skeleton-pulse" style={{ width: '60px' }} />
                  </td>
                  <td className="agents-table__cell">
                    <div className="skeleton-text skeleton-pulse" style={{ width: '24px', height: '24px', borderRadius: '4px' }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile: card skeletons */}
        <div className="agents-page__mobile-cards">
          {[1, 2, 3].map(i => <TeamCardSkeleton key={i} />)}
        </div>
      </div>
    )
  }

  if (teams.length === 0 && externalAgents.length === 0 && claudeCodeKeys.length === 0) {
    return (
      <div className="agents-empty">
        <div className="agents-empty__content">
          <div className="agents-empty__visual">
            <div className="agents-empty__visual-center">
              <CubeIcon />
            </div>
            <div className="agents-empty__visual-orbit">
              <div className="agents-empty__visual-node">
                <PersonCenteredIcon />
              </div>
              <div className="agents-empty__visual-node">
                <PersonCenteredIcon />
              </div>
              <div className="agents-empty__visual-node">
                <PersonCenteredIcon />
              </div>
            </div>
          </div>
          <h1 className="agents-empty__header">Bring on Your First Team</h1>
          <p className="agents-empty__subtext">Launch an agent that can start working autonomously right away.</p>
          <div className="agents-empty__actions">
            <Button variant="primary" onClick={() => {
              track('teams_explore_clicked', { source: 'empty_state' })
              navigate('/dashboard/agents/explore')
            }}>
              Explore agents
            </Button>
          </div>
          <div className="agents-empty__links">
            <button type="button" className="agents-empty__link" onClick={() => {
              track('teams_plan_workforce_clicked', { source: 'empty_state' })
              navigate('/dashboard/agents/plan')
            }}>
              Plan Workforce
            </button>
            <button type="button" className="agents-empty__link" onClick={() => {
              track('teams_connect_external_clicked', {})
              navigate('/dashboard/agents/connect')
            }}>
              Connect External Agent
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="agents-page">
      <PageHeader title="Your Teams">
        <Tooltip text="Plan Workforce">
          <button
            type="button"
            className="agents-page__icon-btn"
            onClick={() => {
              track('teams_plan_workforce_clicked', {})
              navigate('/dashboard/agents/plan')
            }}
            // The dot is not the only signal: colour alone reaches neither a
            // screen reader nor a colour-blind reader, so the state rides on
            // the control's accessible name too.
            aria-label={hasUnreadTeamPlan ? 'Plan Workforce, unread replies' : 'Plan Workforce'}
          >
            <SquareChartGanttIcon />
            {hasUnreadTeamPlan && (
              <span className="agents-page__icon-btn-dot" aria-hidden="true" />
            )}
          </button>
        </Tooltip>
        <Tooltip text="Connect External Agent">
          <button
            type="button"
            className="agents-page__icon-btn"
            onClick={() => {
              track('teams_connect_external_clicked', {})
              navigate('/dashboard/agents/connect')
            }}
            aria-label="Connect External Agent"
          >
            <PlugIcon />
          </button>
        </Tooltip>
        <Button variant="primary" onClick={() => {
          track('teams_explore_clicked', { source: 'header' })
          navigate('/dashboard/agents/explore')
        }}>
          Add Agent
        </Button>
      </PageHeader>

      {/* The Active Teams / Tasks Completed / Hours Saved summary is HIDDEN until
          further notice (product decision). Left in place rather than deleted
          because nothing about it is wrong — useAgentStats still computes the
          three figures and MetricCard still renders them — so restoring it is
          removing this guard, not rebuilding the row. */}
      {SHOW_TEAM_SUMMARY && (
        <div className="agents-page__summary">
          <MetricCard className="agents-page__stat" label="Active Teams" value={activeTeams} />
          <MetricCard className="agents-page__stat" label="Tasks Completed Last 30 Days" value={tasksCompletedLast30Days.toLocaleString()} />
          <MetricCard
            className="agents-page__stat"
            label="Hours Saved Last 30 Days"
            value={hoursSavedLast30Days.toLocaleString()}
            tooltip="This is how long it would have taken a human to perform the same workflows. Each task completed in the last 30 days is weighted by the time that type of work typically takes a person, and the hours are added together."
          />
        </div>
      )}

      <div className="agents-page__filters-row">
        {/* Workforce Category Toggle */}
        <SegmentedControl
          value={workforceCategory}
          onChange={(value) => {
            track('teams_workforce_category_changed', { category: value })
            setWorkforceCategory(value)
            setStatusFilter('all')
            setTeamTypeFilter({ ai_teams: true, external_collaborators: true, people: true })
          }}
          options={[
            { value: 'all', label: 'All' },
            { value: 'ai_workforce', label: 'AI Workforce' },
            { value: 'human_workforce', label: 'Human Workforce' },
          ]}
        />

        {/* Multi-Filter Dropdown */}
        <div className="agents-page__filter-dropdown" ref={filterDropdownRef}>
          <button
            type="button"
            className={`agents-page__filter-dropdown-trigger ${filterDropdownOpen ? 'agents-page__filter-dropdown-trigger--open' : ''}`}
            onClick={() => setFilterDropdownOpen(!filterDropdownOpen)}
          >
            <span>
              {statusFilter === 'all' ? 'All'
                : statusFilter === 'active' ? workforceCategory === 'human_workforce' ? `Active (${personnelStatusCounts.active})` : `Active (${teams.filter(t => normalizeToFilterStatus(t.status) === 'active').length + externalAgents.filter(a => normalizeToFilterStatus(a.status) === 'active').length + claudeCodeKeys.filter(k => k.status === 'active').length})`
                : statusFilter === 'paused' ? `Paused (${teams.filter(t => normalizeToFilterStatus(t.status) === 'paused').length + externalAgents.filter(a => normalizeToFilterStatus(a.status) === 'paused').length + claudeCodeKeys.filter(k => k.status === 'revoked').length})`
                : statusFilter === 'draft' ? `Awaiting Launch (${teams.filter(t => normalizeToFilterStatus(t.status) === 'draft').length + externalAgents.filter(a => normalizeToFilterStatus(a.status) === 'draft').length})`
                : statusFilter === 'onboarding' ? `Onboarding (${personnelStatusCounts.onboarding})`
                : statusFilter === 'invited' ? `Invited (${personnelStatusCounts.invited})`
                : statusFilter === 'error' ? `Error (${personnelStatusCounts.error})`
                : 'All'}
            </span>
            <ChevronDownIcon />
          </button>
          {filterDropdownOpen && (
            <div className="agents-page__filter-dropdown-menu">
              {workforceCategory === 'human_workforce' ? (
                <>
                  {/* Personnel Status Filters */}
                  <button
                    type="button"
                    className={`agents-page__filter-dropdown-option ${statusFilter === 'all' ? 'agents-page__filter-dropdown-option--selected' : ''}`}
                    onClick={() => { track('teams_status_filter_changed', { filter: 'all' }); setStatusFilter('all'); setFilterDropdownOpen(false) }}
                  >
                    <StatusDot color="var(--color-black)" />
                    All ({personnel.length})
                  </button>
                  <button
                    type="button"
                    className={`agents-page__filter-dropdown-option ${statusFilter === 'active' ? 'agents-page__filter-dropdown-option--selected' : ''}`}
                    onClick={() => { track('teams_status_filter_changed', { filter: 'active' }); setStatusFilter('active'); setFilterDropdownOpen(false) }}
                  >
                    <StatusDot variant="success" />
                    Active ({personnelStatusCounts.active})
                  </button>
                  <button
                    type="button"
                    className={`agents-page__filter-dropdown-option ${statusFilter === 'onboarding' ? 'agents-page__filter-dropdown-option--selected' : ''}`}
                    onClick={() => { track('teams_status_filter_changed', { filter: 'onboarding' }); setStatusFilter('onboarding'); setFilterDropdownOpen(false) }}
                  >
                    <StatusDot color="#8b5cf6" />
                    Onboarding ({personnelStatusCounts.onboarding})
                  </button>
                  <button
                    type="button"
                    className={`agents-page__filter-dropdown-option ${statusFilter === 'invited' ? 'agents-page__filter-dropdown-option--selected' : ''}`}
                    onClick={() => { track('teams_status_filter_changed', { filter: 'invited' }); setStatusFilter('invited'); setFilterDropdownOpen(false) }}
                  >
                    <StatusDot color="#8b5cf6" />
                    Invited ({personnelStatusCounts.invited})
                  </button>
                  <button
                    type="button"
                    className={`agents-page__filter-dropdown-option ${statusFilter === 'error' ? 'agents-page__filter-dropdown-option--selected' : ''}`}
                    onClick={() => { track('teams_status_filter_changed', { filter: 'error' }); setStatusFilter('error'); setFilterDropdownOpen(false) }}
                  >
                    <StatusDot variant="error" />
                    Error ({personnelStatusCounts.error})
                  </button>
                </>
              ) : (
                <>
                  {/* AI Status Filters */}
                  <button
                    type="button"
                    className={`agents-page__filter-dropdown-option ${statusFilter === 'all' ? 'agents-page__filter-dropdown-option--selected' : ''}`}
                    onClick={() => { track('teams_status_filter_changed', { filter: 'all' }); setStatusFilter('all'); setFilterDropdownOpen(false) }}
                  >
                    <StatusDot color="var(--color-black)" />
                    All ({teams.length + externalAgents.length + claudeCodeKeys.length})
                  </button>
                  <button
                    type="button"
                    className={`agents-page__filter-dropdown-option ${statusFilter === 'active' ? 'agents-page__filter-dropdown-option--selected' : ''}`}
                    onClick={() => { track('teams_status_filter_changed', { filter: 'active' }); setStatusFilter('active'); setFilterDropdownOpen(false) }}
                  >
                    <StatusDot variant="success" />
                    Active ({teams.filter(t => normalizeToFilterStatus(t.status) === 'active').length + externalAgents.filter(a => normalizeToFilterStatus(a.status) === 'active').length + claudeCodeKeys.filter(k => k.status === 'active').length})
                  </button>
                  <button
                    type="button"
                    className={`agents-page__filter-dropdown-option ${statusFilter === 'paused' ? 'agents-page__filter-dropdown-option--selected' : ''}`}
                    onClick={() => { track('teams_status_filter_changed', { filter: 'paused' }); setStatusFilter('paused'); setFilterDropdownOpen(false) }}
                  >
                    <StatusDot variant="neutral" />
                    Paused ({teams.filter(t => normalizeToFilterStatus(t.status) === 'paused').length + externalAgents.filter(a => normalizeToFilterStatus(a.status) === 'paused').length + claudeCodeKeys.filter(k => k.status === 'revoked').length})
                  </button>
                  <button
                    type="button"
                    className={`agents-page__filter-dropdown-option ${statusFilter === 'draft' ? 'agents-page__filter-dropdown-option--selected' : ''}`}
                    onClick={() => { track('teams_status_filter_changed', { filter: 'draft' }); setStatusFilter('draft'); setFilterDropdownOpen(false) }}
                  >
                    <StatusDot color="#8b5cf6" />
                    Awaiting Launch ({teams.filter(t => normalizeToFilterStatus(t.status) === 'draft').length + externalAgents.filter(a => normalizeToFilterStatus(a.status) === 'draft').length})
                  </button>

                  {/* Type Filters */}
                  <div className="agents-page__filter-dropdown-divider" />
                  <button
                    type="button"
                    className="agents-page__filter-dropdown-checkbox"
                    onClick={() => setTeamTypeFilter(prev => {
                      const next = !prev.ai_teams
                      track('teams_type_filter_toggled', { type: 'ai_teams', enabled: next })
                      return { ...prev, ai_teams: next }
                    })}
                  >
                    <span className={`agents-page__filter-checkbox ${teamTypeFilter.ai_teams ? 'agents-page__filter-checkbox--checked' : ''}`}>
                      {teamTypeFilter.ai_teams && (
                        <CheckIcon />
                      )}
                    </span>
                    Agents
                  </button>
                  <button
                    type="button"
                    className="agents-page__filter-dropdown-checkbox"
                    onClick={() => setTeamTypeFilter(prev => {
                      const next = !prev.external_collaborators
                      track('teams_type_filter_toggled', { type: 'external_collaborators', enabled: next })
                      return { ...prev, external_collaborators: next }
                    })}
                  >
                    <span className={`agents-page__filter-checkbox ${teamTypeFilter.external_collaborators ? 'agents-page__filter-checkbox--checked' : ''}`}>
                      {teamTypeFilter.external_collaborators && (
                        <CheckIcon />
                      )}
                    </span>
                    External Agents
                  </button>
                  {workforceCategory === 'all' && (
                    <button
                      type="button"
                      className="agents-page__filter-dropdown-checkbox"
                      onClick={() => setTeamTypeFilter(prev => {
                        const next = !prev.people
                        track('teams_type_filter_toggled', { type: 'people', enabled: next })
                        return { ...prev, people: next }
                      })}
                    >
                      <span className={`agents-page__filter-checkbox ${teamTypeFilter.people ? 'agents-page__filter-checkbox--checked' : ''}`}>
                        {teamTypeFilter.people && (
                          <CheckIcon />
                        )}
                      </span>
                      People
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="agents-table-wrapper">
        <table className="agents-table">
          <thead>
            <tr>
              <th className="agents-table__header agents-table__header--sortable" onClick={() => handleSort('name')}>Name{getSortIndicator('name')}</th>
              <th className="agents-table__header agents-table__header--sortable" onClick={() => handleSort('status')}>Status{getSortIndicator('status')}</th>
              <th className="agents-table__header agents-table__header--sortable" onClick={() => handleSort('description')}>Description{getSortIndicator('description')}</th>
              <th className="agents-table__header agents-table__header--sortable" onClick={() => handleSort('integrations')}>Integrations{getSortIndicator('integrations')}</th>
              <th className="agents-table__header agents-table__header--sortable" onClick={() => handleSort('tasks')}>Tasks Last 30 Days{getSortIndicator('tasks')}</th>
              <th className="agents-table__header agents-table__header--sortable" onClick={() => handleSort('activity')}>Last Activity{getSortIndicator('activity')}</th>
              <th className="agents-table__header"></th>
            </tr>
          </thead>
          <tbody>
            {sortedItems.map(item => {
              if (item.type === 'ai_team') {
                return (
                  <TeamRow
                    key={item.team.id}
                    type="ai_team"
                    team={item.team}
                    allExternalAgents={externalAgents}
                    lastActivity={item.team.lastActivity}
                    lastActivityAction={item.team.lastActivityAction}
                    onUpdate={() => handleUpdateTeam(item.team)}
                    onChat={() => navigate('/dashboard/agents/chat', { state: { agentId: item.team.id } })}
                    hasUnread={(unreadCounts?.[item.team.id] ?? 0) > 0}
                    onPause={() => handlePauseTeam(item.team)}
                    onInspect={() => handleInspectTeam(item.team)}
                    onDelete={() => handleDeleteTeam(item.team)}
                    toggleLabel={getInternalAgentActionLabel(item.team.status)}
                    isPausing={updateStatusMutation.isPending && updateStatusMutation.variables?.internalAgentId === item.team.id}
                    isDeleting={deleteTeamMutation.isPending && deleteTeamMutation.variables === item.team.id}
                    showIds={showIds}
                    onToggleIds={toggleIds}
                  />
                )
              }
              if (item.type === 'external_agent') {
                return (
                  <TeamRow
                    key={`external-${item.agent.id}`}
                    type="external_agent"
                    agent={item.agent}
                    allTeams={teams}
                    lastActivity={item.agent.lastActivity}
                    lastActivityAction={item.agent.lastActivityAction}
                    onUpdate={() => handleUpdateExternalAgent(item.agent)}
                    onPause={() => handlePauseExternalAgent(item.agent)}
                    onInspect={() => handleInspectExternalAgent(item.agent)}
                    onDelete={() => handleDeleteExternalAgent(item.agent)}
                    toggleLabel={getExternalAgentActionLabel(item.agent.status)}
                    isPausing={updateExternalAgentStatusMutation.isPending && updateExternalAgentStatusMutation.variables?.agentId === item.agent.id}
                    isDeleting={deleteExternalAgentMutation.isPending && deleteExternalAgentMutation.variables === item.agent.id}
                    showIds={showIds}
                    onToggleIds={toggleIds}
                  />
                )
              }
              // claude_code row
              const key = item.key
              const isRevoking = (deleteClaudeCodeKeyMutation.isPending && deleteClaudeCodeKeyMutation.variables === key.id) || (revokeMcpTokenMutation.isPending && revokeMcpTokenMutation.variables === key.id)
              const brand = connectionBrand(key)
              return (
                <tr key={`cc-${key.id}`} className={`agents-table__row ${isRevoking ? 'agents-table__row--deleting' : ''}`}>
                  <td className="agents-table__cell agents-table__cell--name">
                    <div className="agents-table__name-wrapper">
                      <span className="agents-table__name">{showIds ? <IdReveal id={key.id} name={key.name} /> : key.name}</span>
                      <Tooltip text={brand.label} position="top">
                        <span className={`agents-table__external-icon ${brand.dark ? 'agents-table__external-icon--vendor-mark' : ''}`}>
                          <brand.Icon />
                        </span>
                      </Tooltip>
                    </div>
                  </td>
                  <td className="agents-table__cell agents-table__cell--status" onDoubleClick={altDoubleClickToggle(toggleIds)}>
                    <StatusBadge variant={key.status === 'active' ? 'active' : 'neutral'}>
                      {key.status === 'active' ? 'Active' : 'Revoked'}
                    </StatusBadge>
                  </td>
                  <td className="agents-table__cell agents-table__cell--description">
                    <Tooltip text={key.description || ''} position="bottom">
                      <span className="agents-table__description">{key.description || '—'}</span>
                    </Tooltip>
                  </td>
                  <td className="agents-table__cell agents-table__cell--integrations">—</td>
                  <td className="agents-table__cell agents-table__cell--tasks">—</td>
                  <td className="agents-table__cell agents-table__cell--activity">
                    {key.lastUsedAt
                      ? <span className="agents-table__activity-time">{formatTimeAgo(key.lastUsedAt)}</span>
                      : <span className="agents-table__activity-empty">Never</span>
                    }
                  </td>
                  <td className="agents-table__cell agents-table__cell--actions">
                    {/* Same wrapper as every other row: this row has no chat
                        button, and the wrapper is what keeps its kebab on the
                        same vertical line as the ones that do. */}
                    <div className="agents-table__actions">
                      <PermissionGate permission="edit_teams" fallback={null}>
                        <ActionMenu
                          disabled={isRevoking}
                          items={[
                            { label: 'Update Team', onClick: () => handleUpdateClaudeCode(key) },
                            { label: isRevoking ? 'Archiving...' : 'Archive Team', onClick: () => handleDeleteClaudeCode(key), disabled: isRevoking },
                          ]}
                        />
                      </PermissionGate>
                    </div>
                  </td>
                </tr>
              )
            })}
            {(workforceCategory === 'human_workforce' || (workforceCategory === 'all' && teamTypeFilter.people)) && filteredHumanWorkforce.map(person => {
              const mapped = mapOnboardStatus(person.onboardStatus)
              const statusVariant = mapped === 'complete' ? 'active' as const
                : mapped === 'error' ? 'error' as const
                : 'draft' as const
              const statusLabel = mapped === 'complete' ? 'Active'
                : mapped === 'in_progress' ? 'Onboarding'
                : mapped === 'error' ? 'Error'
                : 'Invited'
              const description = formatAssignmentDescription(person.assignments)
              const displayName = personDisplayName(person)
              const internalCount = person.assignments.filter(a => a.agentType === 'internal').length
              const extCount = person.assignments.filter(a => a.agentType === 'external').length
              return (
                <tr key={person.personId} className="agents-table__row">
                  <td className="agents-table__cell agents-table__cell--name">
                    <div className="agents-table__name-wrapper">
                      <span className="agents-table__name">{showIds ? <IdReveal id={person.accountId} name={displayName} /> : displayName}</span>
                    </div>
                  </td>
                  <td className="agents-table__cell" onDoubleClick={altDoubleClickToggle(toggleIds)}>
                    <StatusBadge variant={statusVariant}>{statusLabel}</StatusBadge>
                  </td>
                  <td className="agents-table__cell agents-table__cell--description">
                    <Tooltip text={description} position="bottom">
                      <span className="agents-table__description">{description}</span>
                    </Tooltip>
                  </td>
                  <td className="agents-table__cell agents-table__cell--integrations">
                    <div className="agents-table__integrations">
                      {internalCount > 0 && (
                        <>
                          <Tooltip text="Agents" position="top">
                            <span className="agent-card__integration agent-card__integration--team">
                              <TeamIcon />
                            </span>
                          </Tooltip>
                          {internalCount > 1 && (
                            <span className="agent-card__integration-count">×{internalCount}</span>
                          )}
                        </>
                      )}
                      {extCount > 0 && (
                        <>
                          <Tooltip text="External Agents" position="top">
                            <span className="agent-card__integration agent-card__integration--external">
                              <PlugIcon />
                            </span>
                          </Tooltip>
                          {extCount > 1 && (
                            <span className="agent-card__integration-count">×{extCount}</span>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                  <td className="agents-table__cell agents-table__cell--tasks">{(person.tasks30d ?? 0).toLocaleString()}</td>
                  <td className="agents-table__cell agents-table__cell--activity">
                    <span className="agents-table__activity-empty">No activity</span>
                  </td>
                  <td className="agents-table__cell agents-table__cell--actions">
                    <div className="agents-table__actions">
                      <ActionMenu items={[
                        { label: 'Update Assignment', onClick: () => {
                        track('teams_row_clicked', { kind: 'person', id: person.accountId })
                        setEditingPerson(person)
                      }, disabled: !person.isAssignable },
                      ]} />
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile cards grid - shown only on mobile */}
      <div className="agents-page__mobile-cards">
        {sortedItems.map(item => {
          if (item.type === 'ai_team') {
            return (
              <TeamCard
                key={item.team.id}
                type="ai_team"
                team={item.team}
                allExternalAgents={externalAgents}
                lastActivity={item.team.lastActivity}
                lastActivityAction={item.team.lastActivityAction}
                onUpdate={() => handleUpdateTeam(item.team)}
                onChat={() => navigate('/dashboard/agents/chat', { state: { agentId: item.team.id } })}
                hasUnread={(unreadCounts?.[item.team.id] ?? 0) > 0}
                onPause={() => handlePauseTeam(item.team)}
                onInspect={() => handleInspectTeam(item.team)}
                onDelete={() => handleDeleteTeam(item.team)}
                toggleLabel={getInternalAgentActionLabel(item.team.status)}
                isPausing={updateStatusMutation.isPending && updateStatusMutation.variables?.internalAgentId === item.team.id}
                isDeleting={deleteTeamMutation.isPending && deleteTeamMutation.variables === item.team.id}
                showIds={showIds}
                onToggleIds={toggleIds}
                compact
              />
            )
          }
          if (item.type === 'external_agent') {
            return (
              <TeamCard
                key={`external-${item.agent.id}`}
                type="external_agent"
                agent={item.agent}
                allTeams={teams}
                lastActivity={item.agent.lastActivity}
                lastActivityAction={item.agent.lastActivityAction}
                onUpdate={() => handleUpdateExternalAgent(item.agent)}
                onPause={() => handlePauseExternalAgent(item.agent)}
                onInspect={() => handleInspectExternalAgent(item.agent)}
                onDelete={() => handleDeleteExternalAgent(item.agent)}
                toggleLabel={getExternalAgentActionLabel(item.agent.status)}
                isPausing={updateExternalAgentStatusMutation.isPending && updateExternalAgentStatusMutation.variables?.agentId === item.agent.id}
                isDeleting={deleteExternalAgentMutation.isPending && deleteExternalAgentMutation.variables === item.agent.id}
                showIds={showIds}
                onToggleIds={toggleIds}
                compact
              />
            )
          }
          // claude_code mobile card
          const key = item.key
          const isRevoking = (deleteClaudeCodeKeyMutation.isPending && deleteClaudeCodeKeyMutation.variables === key.id) || (revokeMcpTokenMutation.isPending && revokeMcpTokenMutation.variables === key.id)
          const brand = connectionBrand(key)
          return (
            <div key={`cc-${key.id}`} className={`agent-card ${isRevoking ? 'agent-card--deleting' : ''}`}>
              <div className="agent-card__header">
                <h3 className="agent-card__name">
                  {showIds ? <IdReveal id={key.id} name={key.name} /> : key.name}
                  <Tooltip text={brand.label} position="top">
                    <span className={`agent-card__external-icon ${brand.dark ? 'agent-card__external-icon--vendor-mark' : ''}`}>
                      <brand.Icon />
                    </span>
                  </Tooltip>
                </h3>
                <div className="agent-card__header-actions">
                  <span className="agent-card__status-hit" onDoubleClick={altDoubleClickToggle(toggleIds)}>
                    <StatusBadge variant={key.status === 'active' ? 'active' : 'neutral'}>
                      {key.status === 'active' ? 'Active' : 'Revoked'}
                    </StatusBadge>
                  </span>
                  <ActionMenu
                    disabled={isRevoking}
                    items={[
                      { label: 'Update Team', onClick: () => handleUpdateClaudeCode(key) },
                      { label: isRevoking ? 'Archiving...' : 'Archive Team', onClick: () => handleDeleteClaudeCode(key), disabled: isRevoking },
                    ]}
                  />
                </div>
              </div>
              {key.description && <p className="agent-card__description">{key.description}</p>}
              <div className="agent-card__activity">
                {key.lastUsedAt
                  ? <span className="agent-card__activity-line">Last used <span className="agent-card__activity-time">{formatTimeAgo(key.lastUsedAt)}</span></span>
                  : <span className="agent-card__activity-empty">Never used</span>
                }
              </div>
            </div>
          )
        })}
        {(workforceCategory === 'human_workforce' || (workforceCategory === 'all' && teamTypeFilter.people)) && filteredHumanWorkforce.map(person => {
          const mapped = mapOnboardStatus(person.onboardStatus)
          const statusVariant = mapped === 'complete' ? 'active' as const
            : mapped === 'error' ? 'error' as const
            : 'draft' as const
          const statusLabel = mapped === 'complete' ? 'Active'
            : mapped === 'in_progress' ? 'Onboarding'
            : mapped === 'error' ? 'Error'
            : 'Invited'
          const description = formatAssignmentDescription(person.assignments)
          const displayName = personDisplayName(person)
          return (
            <div key={person.personId} className="agent-card">
              <div className="agent-card__header">
                <h3 className="agent-card__name">{showIds ? <IdReveal id={person.accountId} name={displayName} /> : displayName}</h3>
                <div className="agent-card__header-actions">
                  <span className="agent-card__status-hit" onDoubleClick={altDoubleClickToggle(toggleIds)}>
                    <StatusBadge variant={statusVariant}>{statusLabel}</StatusBadge>
                  </span>
                  <ActionMenu items={[
                    { label: 'Update Assignment', onClick: () => {
                      track('teams_row_clicked', { kind: 'person', id: person.accountId })
                      setEditingPerson(person)
                    }, disabled: !person.isAssignable },
                  ]} />
                </div>
              </div>
              {description && <p className="agent-card__description">{description}</p>}
              <div className="agent-card__meta">
                <div className="agent-card__meta-item">
                  <span className="agent-card__meta-label">Assignments</span>
                  <span className="agent-card__meta-value">{person.assignments.length}</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {sortedItems.length === 0 && (workforceCategory !== 'all' && workforceCategory !== 'human_workforce' || filteredHumanWorkforce.length === 0) && (
        <EmptyState
          icon={
            workforceCategory === 'human_workforce' ? (
              <PeopleAltIcon />
            ) : (
              <FilterIcon />
            )
          }
          title={workforceCategory === 'human_workforce'
            ? 'No team members found'
            : `No ${statusFilter === 'active' ? 'active' : statusFilter === 'paused' ? 'paused' : statusFilter === 'draft' ? 'awaiting launch' : ''} teams`}
          description={workforceCategory === 'human_workforce'
            ? 'Invite people from workspace settings'
            : 'Try selecting a different filter'}
        />
      )}

      {editingPerson && (
        <PersonAssignmentModal
          person={editingPerson}
          internalAgents={teams}
          externalAgents={externalAgents}
          onClose={() => setEditingPerson(null)}
        />
      )}
    </div>
  )
}
