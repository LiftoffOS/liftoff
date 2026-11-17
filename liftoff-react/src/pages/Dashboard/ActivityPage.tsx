import { useState, useMemo, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router'
import { useToast } from '../../contexts/ToastContext'
import { Button, DateRangeInput, PageHeader, TextInput } from '../../components'
import { useActivityLogs } from '../../hooks/useActivityLogs'
import { useCorrectionOptions, useCorrectionHistory, useRequestCorrection } from '../../hooks/useCorrections'
import { TOAST_MESSAGES } from '../../constants/toastMessages'
import { formatActionLabel } from '../../utils/formatAction'
import ClockIcon from '../../assets/icons/clock.svg?react'
import XIcon from '../../assets/icons/x.svg?react'
import ChevronDownIcon from '../../assets/icons/chevron-down.svg?react'
import { reportAuditEvent } from '../../services/auditEvents'
import ChevronLeftIcon from '../../assets/icons/chevron-left.svg?react'
import ChevronRightIcon from '../../assets/icons/chevron-right.svg?react'
import EllipsisVerticalIcon from '../../assets/icons/ellipsis-vertical.svg?react'
import InfoCircleIcon from '../../assets/icons/info-circle.svg?react'
import type { ActivityLogFilters, AgentAuditLog, AuditOutcome } from '../../services/activityLogs'
import type { ActivityLocationState } from '../../types/activityScope'
import { canRerunActivityLog } from '../../services/activityLogs'
import { useRerunRun } from '../../hooks/useRerunRun'
import { FileOutputCard } from '../../components/Chat/FileOutputCard'
import type { FileAttachment } from '../../components/Chat/ChatMessages'
import { track } from '../../lib/analytics'
import '../../components/Chat/ChatMessages.css'
import './ActivityPage.css'
import { PermissionGate } from '../../components/PermissionGate'

type TimeRangePreset = 'all' | '1h' | '2h' | '4h' | '8h' | '12h' | '24h' | '7d' | '30d' | 'custom'

const TIME_RANGE_PRESETS: { value: TimeRangePreset; label: string }[] = [
  { value: 'all', label: 'All time' },
  { value: '1h', label: 'Last hour' },
  { value: '2h', label: 'Last 2 hours' },
  { value: '4h', label: 'Last 4 hours' },
  { value: '8h', label: 'Last 8 hours' },
  { value: '12h', label: 'Last 12 hours' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'custom', label: 'Custom range' },
]

function getDateRangeFromPreset(preset: TimeRangePreset): { startDate: Date; endDate: Date } | null {
  if (preset === 'all' || preset === 'custom') return null

  const now = new Date()
  const endDate = now
  const startDate = new Date()

  switch (preset) {
    case '1h':
      startDate.setHours(now.getHours() - 1)
      break
    case '2h':
      startDate.setHours(now.getHours() - 2)
      break
    case '4h':
      startDate.setHours(now.getHours() - 4)
      break
    case '8h':
      startDate.setHours(now.getHours() - 8)
      break
    case '12h':
      startDate.setHours(now.getHours() - 12)
      break
    case '24h':
      startDate.setDate(now.getDate() - 1)
      break
    case '7d':
      startDate.setDate(now.getDate() - 7)
      break
    case '30d':
      startDate.setDate(now.getDate() - 30)
      break
  }

  return { startDate, endDate }
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins} ${diffMins === 1 ? 'minute' : 'minutes'} ago`
  if (diffHours < 24) return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`
  if (diffDays < 7) return `${diffDays} ${diffDays === 1 ? 'day' : 'days'} ago`

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '-'
  if (ms < 1000) return 'less than 1 second'
  if (ms < 60000) {
    const secs = Math.round(ms / 1000)
    return `${secs} ${secs === 1 ? 'second' : 'seconds'}`
  }
  const mins = Math.round(ms / 60000)
  return `${mins} ${mins === 1 ? 'minute' : 'minutes'}`
}

function getOutcomeVariant(outcome: AuditOutcome): 'success' | 'error' | 'warning' {
  switch (outcome) {
    case 'success':
      return 'success'
    case 'error':
      return 'error'
    case 'gated':
      return 'warning'
    default:
      return 'success'
  }
}

function getTriggeredByLabel(
  triggeredBy: string,
  triggeredByAgentName: string | null | undefined
): string {
  if (triggeredBy === 'cron') return 'Scheduled'
  if (triggeredBy === 'system') return 'System'
  if (triggeredBy.startsWith('human:')) return 'Human'
  if (triggeredBy.startsWith('event:')) return triggeredBy.replace('event:', 'Event: ')
  if (triggeredBy === 'agent' || triggeredBy.startsWith('agent:')) {
    return triggeredByAgentName ?? 'Agent'
  }
  return triggeredBy
}

interface ActivityRowProps {
  log: AgentAuditLog
  teamName: string
  onSelect: (log: AgentAuditLog) => void
  onCorrect: (log: AgentAuditLog) => void
  onRerun: (log: AgentAuditLog) => void
  rerunPending: boolean
}

function ActivityRow({ log, teamName, onSelect, onCorrect, onRerun, rerunPending }: ActivityRowProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  // The dropdown is rendered in a portal (below) so it is never clipped by the
  // table wrapper's `overflow: hidden`. We anchor it to the trigger's viewport
  // rect and close on scroll/resize (a fixed popover would otherwise detach).
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const outcomeVariant = getOutcomeVariant(log.outcome)

  const openMenu = () => {
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) setMenuPos({ top: r.bottom + 4, right: window.innerWidth - r.right })
    setMenuOpen(true)
  }

  useEffect(() => {
    if (!menuOpen) return
    function handleClickOutside(e: MouseEvent) {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || dropdownRef.current?.contains(t)) return
      setMenuOpen(false)
    }
    function close() { setMenuOpen(false) }
    document.addEventListener('mousedown', handleClickOutside)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [menuOpen])

  return (
    <tr className="activity-table__row">
      <td className="activity-table__cell activity-table__cell--time">
        {formatTimestamp(log.createdAt)}
      </td>
      <td className="activity-table__cell activity-table__cell--team">
        {teamName}
      </td>
      <td className="activity-table__cell activity-table__cell--action">
        <code className="activity-action">{formatActionLabel(log.action)}</code>
      </td>
      <td className="activity-table__cell activity-table__cell--outcome">
        <span className={`activity-outcome activity-outcome--${outcomeVariant}`}>
          {log.outcome}
        </span>
      </td>
      <td className="activity-table__cell activity-table__cell--trigger">
        {getTriggeredByLabel(log.triggeredBy, log.triggeredByAgentName)}
      </td>
      <td className="activity-table__cell activity-table__cell--duration">
        {formatDuration(log.durationMs)}
      </td>
      <td className="activity-table__cell activity-table__cell--actions">
        <div className="activity-row__menu-wrapper">
          <button
            type="button"
            ref={triggerRef}
            className="activity-row__menu-trigger"
            onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
            aria-label="More options"
          >
            <EllipsisVerticalIcon />
          </button>
          {menuOpen && menuPos && createPortal(
            <div
              ref={dropdownRef}
              className="activity-row__menu-dropdown activity-row__menu-dropdown--portal"
              style={{ top: menuPos.top, right: menuPos.right }}
            >
              <button onClick={() => { onSelect(log); setMenuOpen(false); }}>
                See Details
              </button>
              <PermissionGate permission="submit_corrections" fallback={null}>
                <button onClick={() => { onCorrect(log); setMenuOpen(false); }}>
                  Correct
                </button>
              </PermissionGate>
              {canRerunActivityLog(log) && (
                <button disabled={rerunPending} onClick={() => { onRerun(log); setMenuOpen(false); }}>
                  Run Again
                </button>
              )}
            </div>,
            document.body
          )}
        </div>
      </td>
    </tr>
  )
}

interface CorrectConfirmModalProps {
  log: AgentAuditLog
  onClose: () => void
  onSuccess: () => void
}

function CorrectConfirmModal({ log, onClose, onSuccess }: CorrectConfirmModalProps) {
  const { showToast } = useToast()
  const [reason, setReason] = useState('')
  const { data: options, isLoading: isLoadingOptions } = useCorrectionOptions(log.id)
  const requestCorrection = useRequestCorrection()

  const handleConfirm = async () => {
    try {
      const result = await requestCorrection.mutateAsync({
        auditLogId: log.id,
        reason: reason.trim() || undefined,
      })

      if (result.success) {
        track('activity_correction_requested', {
          log_id: log.id,
          result: result.status === 'gated' ? 'gated' : 'success',
          reason_provided: !!reason.trim(),
        })
        if (result.status === 'gated') {
          showToast(TOAST_MESSAGES.CORRECTION_GATED, 'success')
        } else {
          showToast(TOAST_MESSAGES.CORRECTION_REQUESTED, 'success')
        }
        onSuccess()
        onClose()
      } else {
        track('activity_correction_requested', { log_id: log.id, result: 'failed', reason_provided: !!reason.trim() })
        showToast(result.error || TOAST_MESSAGES.CORRECTION_FAILED, 'error')
      }
    } catch {
      track('activity_correction_requested', { log_id: log.id, result: 'failed', reason_provided: !!reason.trim() })
      showToast(TOAST_MESSAGES.CORRECTION_FAILED, 'error')
    }
  }

  const formatTimeRemaining = (seconds: number): string => {
    if (seconds < 60) return `${seconds}s remaining`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m remaining`
    return `${Math.floor(seconds / 3600)}h remaining`
  }

  return createPortal(
    <div
      className="activity-modal-overlay"
      role="presentation"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="activity-modal" role="dialog" aria-modal="true" tabIndex={-1}>
        <div className="activity-modal__header">
          <h2 className="activity-modal__title">Correct Action</h2>
          <button className="activity-modal__close" onClick={onClose} aria-label="Close">
            <XIcon width="16" height="16" />
          </button>
        </div>

        <div className="activity-modal__content">
          {isLoadingOptions ? (
            <div className="correction-modal__loading">
              <div className="loading-spinner" role="status" aria-label="Loading correction options" />
            </div>
          ) : options?.correctable === false ? (
            <div className="correction-modal__not-correctable">
              <p className="correction-modal__not-correctable-reason">
                {options.reason || TOAST_MESSAGES.CORRECTION_NOT_CORRECTABLE}
              </p>
              {options.suggestion && (
                <p className="correction-modal__not-correctable-suggestion">
                  {options.suggestion}
                </p>
              )}
            </div>
          ) : (
            <>
              {options?.description && (
                <p className="correction-modal__description">{options.description}</p>
              )}

              <div className="correction-modal__info">
                <div className="correction-modal__info-row">
                  <span className="correction-modal__info-label">Action</span>
                  <code className="activity-modal__code">{formatActionLabel(log.action)}</code>
                </div>

                {options?.correctionType && (
                  <div className="correction-modal__info-row">
                    <span className="correction-modal__info-label">Correction Type</span>
                    <span className="correction-modal__badge correction-modal__badge--type">
                      {options.label || options.correctionType}
                    </span>
                  </div>
                )}

                {options?.requiresApproval && (
                  <div className="correction-modal__info-row">
                    <span className="correction-modal__info-label">Approval</span>
                    <span className="correction-modal__badge correction-modal__badge--approval">
                      Requires approval
                    </span>
                  </div>
                )}

                {options?.timeRemaining != null && options.timeRemaining > 0 && (
                  <div className="correction-modal__info-row">
                    <span className="correction-modal__info-label">Time Window</span>
                    <span className="correction-modal__badge correction-modal__badge--time">
                      {formatTimeRemaining(options.timeRemaining)}
                    </span>
                  </div>
                )}
              </div>

              <div className="correction-modal__reason-section">
                <label className="correction-modal__reason-label" htmlFor="correction-reason">
                  Reason (optional)
                </label>
                <textarea
                  id="correction-reason"
                  className="correction-modal__reason-input"
                  placeholder="Explain why this action needs to be corrected..."
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  maxLength={1000}
                />
                <p className="correction-modal__reason-hint">
                  {reason.length}/1000 characters
                </p>
              </div>
            </>
          )}

          <div className="correction-modal__actions">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            {options?.correctable !== false && (
              <Button
                variant="primary"
                onClick={handleConfirm}
                disabled={isLoadingOptions || requestCorrection.isPending}
              >
                {requestCorrection.isPending ? 'Requesting...' : 'Confirm'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

interface ActivityDetailModalProps {
  log: AgentAuditLog
  teamName: string
  onClose: () => void
  onRerun: (log: AgentAuditLog) => void
  rerunPending: boolean
}

function ActivityDetailModal({ log, teamName, onClose, onRerun, rerunPending }: ActivityDetailModalProps) {
  const outcomeVariant = getOutcomeVariant(log.outcome)
  const { data: historyData } = useCorrectionHistory(log.id)

  return createPortal(
    <div
      className="activity-modal-overlay"
      role="presentation"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="activity-modal" role="dialog" aria-modal="true" tabIndex={-1}>
        <div className="activity-modal__header">
          <h2 className="activity-modal__title">Activity Details</h2>
          <button className="activity-modal__close" onClick={onClose} aria-label="Close">
            <XIcon width="16" height="16" />
          </button>
        </div>

        <div className="activity-modal__content">
          <div className="activity-modal__row">
            <span className="activity-modal__label">Time</span>
            <span className="activity-modal__value">
              {new Date(log.createdAt).toLocaleString(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                timeZoneName: 'short'
              })}
            </span>
          </div>

          <div className="activity-modal__row">
            <span className="activity-modal__label">Agent</span>
            <span className="activity-modal__value">{teamName}</span>
          </div>

          <div className="activity-modal__row">
            <span className="activity-modal__label">Action</span>
            <code className="activity-modal__code">{formatActionLabel(log.action)}</code>
          </div>

          <div className="activity-modal__row">
            <span className="activity-modal__label">Outcome</span>
            <span className={`activity-outcome activity-outcome--${outcomeVariant}`}>
              {log.outcome}
            </span>
          </div>

          <div className="activity-modal__row">
            <span className="activity-modal__label">Triggered By</span>
            <span className="activity-modal__value">{getTriggeredByLabel(log.triggeredBy, log.triggeredByAgentName)}</span>
          </div>

          <div className="activity-modal__row">
            <span className="activity-modal__label">Duration</span>
            <span className="activity-modal__value">{formatDuration(log.durationMs)}</span>
          </div>

          {log.errorCode && (
            <div className="activity-modal__row">
              <span className="activity-modal__label">Error Code</span>
              <code className="activity-modal__code activity-modal__code--error">{log.errorCode}</code>
            </div>
          )}

          <div className="activity-modal__section">
            <span className="activity-modal__label">Input Arguments</span>
            {log.action === 'document.generated' ? (
              <FileOutputCard attachment={{
                generatedFileId: String(log.inputArgs.generatedFileId ?? ''),
                filename: String(log.inputArgs.filename ?? ''),
                outputType: (log.inputArgs.outputType as FileAttachment['outputType']) ?? 'docx',
                version: Number(log.inputArgs.version ?? 1),
                downloadUrl: log.inputArgs.connectorFileId
                  ? null
                  : (log.inputArgs.downloadUrl != null ? String(log.inputArgs.downloadUrl) : ''),
                webViewUrl: log.inputArgs.webViewUrl != null ? String(log.inputArgs.webViewUrl) : undefined,
              }} />
            ) : (
              <pre className="activity-modal__pre">
                {JSON.stringify(log.inputArgs, null, 2)}
              </pre>
            )}
          </div>

          {log.outputSummary && (
            <div className="activity-modal__section">
              <span className="activity-modal__label">Output Summary</span>
              <pre className="activity-modal__pre">{log.outputSummary}</pre>
            </div>
          )}

          {/* State Snapshot Section */}
          {(log.preActionSnapshot || log.postActionSnapshot || log.snapshotStatus === 'unavailable_approved' || log.snapshotStatus === 'unavailable') && (
            <div className="activity-modal__section">
              <span className="activity-modal__label">State Snapshot</span>
              <div className="activity-modal__snapshot-list">
                {log.preActionSnapshot && (
                  <div>
                    <p className="activity-modal__snapshot-label">Before</p>
                    <pre className="activity-modal__pre activity-modal__pre--before">
                      {JSON.stringify(log.preActionSnapshot, null, 2)}
                    </pre>
                  </div>
                )}
                {log.postActionSnapshot && (
                  <div>
                    <p className="activity-modal__snapshot-label">After (Created)</p>
                    <pre className="activity-modal__pre activity-modal__pre--after">
                      {JSON.stringify(log.postActionSnapshot, null, 2)}
                    </pre>
                  </div>
                )}
                {log.snapshotStatus === 'unavailable_approved' && (
                  <p className="activity-modal__snapshot-warning">
                    ⚠ Human approved proceeding without audit trail for this change
                  </p>
                )}
                {log.snapshotStatus === 'unavailable' && log.outcome === 'gated' && (
                  <p className="activity-modal__snapshot-error">
                    ✕ Write blocked — snapshot capture failed and no human approval was granted
                  </p>
                )}
              </div>
            </div>
          )}

          {log.externalResponse && (
            <div className="activity-modal__section">
              <span className="activity-modal__label">External API Response</span>
              <pre className="activity-modal__pre">
                {JSON.stringify(log.externalResponse, null, 2)}
              </pre>
            </div>
          )}

          {/* Correction History Section */}
          {historyData?.history && historyData.history.length > 1 && (
            <div className="activity-modal__history-section">
              <div className="activity-modal__history-header">
                <h3 className="activity-modal__history-title">Correction History</h3>
              </div>
              <div className="activity-modal__history-list">
                {historyData.history
                  .filter(entry => entry.id !== log.id)
                  .map(entry => (
                    <div key={entry.id} className="activity-modal__history-item">
                      <div className="activity-modal__history-item-header">
                        <span className="activity-modal__history-item-action">{formatActionLabel(entry.action)}</span>
                        <span className={`activity-modal__history-item-outcome activity-modal__history-item-outcome--${entry.outcome}`}>
                          {entry.outcome}
                        </span>
                      </div>
                      <div className="activity-modal__history-item-meta">
                        <span>{getTriggeredByLabel(entry.triggeredBy, null)}</span>
                        <span>{formatTimestamp(entry.createdAt)}</span>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}

          <div className="activity-modal__meta">
            <span>ID: {log.id}</span>
            {log.threadId && <span>Thread: {log.threadId}</span>}
            {log.invocationId && <span>Invocation: {log.invocationId}</span>}
          </div>

          {canRerunActivityLog(log) && (
            <div className="activity-modal__rerun-actions">
              <Button variant="primary" disabled={rerunPending} onClick={() => { onRerun(log); onClose(); }}>
                Run Again
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

const ITEMS_PER_PAGE = 20

export default function ActivityPage() {
  const location = useLocation()

  // "Inspect Team" on the Teams page hands the team's name over through router
  // state, and it goes straight into the search box the user would otherwise
  // have typed it into. Router state rather than the URL, so
  // /dashboard/activity stays a clean address with nothing identifying in it.
  const teamSearchSeed = (location.state as ActivityLocationState | null)?.teamSearch ?? ''

  // Filter state
  const [timeRangePreset, setTimeRangePreset] = useState<TimeRangePreset>('all')
  const [customStartDate, setCustomStartDate] = useState('')
  const [customEndDate, setCustomEndDate] = useState('')
  const [search, setSearch] = useState(teamSearchSeed)
  // The ID is the state; the row is derived from it below.
  //
  // Holding the object meant it went stale the moment a background refetch
  // rebuilt `allLogs`, so an outcome flipping server-side disagreed with the
  // row underneath it, and an effect had to rebind the two on every fetch.
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null)
  const [correctingLog, setCorrectingLog] = useState<AgentAuditLog | null>(null)
  const { showToast } = useToast()
  const rerun = useRerunRun()

  // ADR-030: "Run again" — re-run a failed autonomous run. The activity feed is
  // refreshed by the mutation's onSuccess; here we just surface the outcome.
  const handleRerun = async (log: AgentAuditLog) => {
    if (rerun.isPending) return
    if (!log.internalAgentId || !log.invocationId) return
    try {
      await rerun.mutateAsync({ internalAgentId: log.internalAgentId, invocationId: log.invocationId })
      track('activity_rerun_clicked', { log_id: log.id, result: 'success' })
      showToast('Started a new run', 'success')
    } catch {
      track('activity_rerun_clicked', { log_id: log.id, result: 'failed' })
      showToast('Could not start a new run', 'error')
    }
  }
  const [showTimeRangeDropdown, setShowTimeRangeDropdown] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const viewedRef = useRef(false)
  useEffect(() => {
    if (viewedRef.current) return
    viewedRef.current = true
    track('activity_viewed', {})
  }, [])
  // Debounced server-side search term. The raw `search` state drives the
  // input UI for snappy typing; `debouncedSearch` is what we forward to the
  // backend filter so the request only fires once the user pauses. Without
  // this, every keystroke would re-fetch.
  // Seeded, not left empty, so a team arriving from "Inspect Team" is on the
  // very first request. Starting at '' would fetch the whole workspace feed and
  // only narrow it 400 ms later, which the user would see flash past.
  const [debouncedSearch, setDebouncedSearch] = useState(teamSearchSeed)
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    searchDebounceRef.current = setTimeout(() => {
      setDebouncedSearch(search)
      if (search) track('activity_search_performed', { query_length: search.length })
    }, 400)
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    }
  }, [search])

  // Refs for click outside
  const timeRangeRef = useRef<HTMLDivElement>(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (timeRangeRef.current && !timeRangeRef.current.contains(event.target as Node)) {
        setShowTimeRangeDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Parse MM/DD/YYYY date string
  const parseDateString = (dateStr: string): Date | null => {
    const match = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
    if (!match) return null
    const [, month, day, year] = match
    const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day))
    if (isNaN(date.getTime())) return null
    return date
  }

  // Compute date range from preset or custom
  const dateRange = useMemo(() => {
    if (timeRangePreset === 'custom') {
      if (customStartDate && customEndDate) {
        const startDate = parseDateString(customStartDate)
        const endDate = parseDateString(customEndDate)
        if (startDate && endDate) {
          // Set end date to end of day
          endDate.setHours(23, 59, 59, 999)
          return { startDate, endDate }
        }
      }
      return null
    }
    return getDateRangeFromPreset(timeRangePreset)
  }, [timeRangePreset, customStartDate, customEndDate])

  // Build filters. `q` is the server-side search term; when present, the
  // backend filters across agent name, action, input_args, and output_summary
  // so high-volume agents can't bury matches past the client-fetched window.
  // Filtering only already-fetched rows would make it impossible to find a
  // low-volume agent's entries once they paginate off the recent feed: a busy
  // agent's rapid-fire entries bury every row of a quieter one past the
  // loaded page.
  const filters: ActivityLogFilters = useMemo(() => ({
    startDate: dateRange?.startDate.toISOString(),
    endDate: dateRange?.endDate.toISOString(),
    q: debouncedSearch.trim() || undefined,
  }), [dateRange, debouncedSearch])

  // Fetch activity logs
  const {
    data,
    isLoading,
    isPending,
    isError,
    error,
    fetchNextPage,
    isFetchingNextPage,
  } = useActivityLogs(filters)

  // True if we're still waiting for data (either loading or query not yet enabled)
  const isWaitingForData = isPending || isLoading

  // Flatten paginated data
  const allLogs = useMemo(() => {
    if (!data?.pages) return []
    return data.pages.flatMap(page => page.items)
  }, [data])

  // A deep link from the dashboard names the row to open. Applied once, when
  // it changes, rather than on every re-flatten of `allLogs`: the row does not
  // have to have arrived yet, because selection is by id now.
  const deepLinkId = (location.state as ActivityLocationState | null)?.selectedLogId ?? null
  const [seenDeepLinkId, setSeenDeepLinkId] = useState<string | null>(null)
  if (deepLinkId && deepLinkId !== seenDeepLinkId) {
    setSeenDeepLinkId(deepLinkId)
    setSelectedLogId(deepLinkId)
  }

  // Always the entry in the current `allLogs`, so it cannot be stale, and null
  // by itself once a new query filters the row out.
  const selectedLog = selectedLogId ? allLogs.find(l => l.id === selectedLogId) ?? null : null

  // Phase 3: report time-range / search / details events back to the audit
  // trail. Debounced so each keystroke doesn't fire its own row.
  //
  // The `mountedRef` gate prevents the initial-render fire of each effect
  // — a useEffect always runs on mount even when no user interaction has
  // occurred. Without this, every visit to /activity writes phantom
  // "user changed time range" / "user selected log" audit rows.
  const auditMountedRef = useRef(false)
  useEffect(() => {
    auditMountedRef.current = true
  }, [])

  useEffect(() => {
    if (!auditMountedRef.current) return
    reportAuditEvent(
      'activity.time_range_changed',
      { params: { preset: timeRangePreset, customStartDate, customEndDate } },
      800,
    )
  }, [timeRangePreset, customStartDate, customEndDate])

  useEffect(() => {
    if (!auditMountedRef.current) return
    if (search) {
      reportAuditEvent('activity.search_performed', { params: { query: search } }, 1500)
    }
  }, [search])

  useEffect(() => {
    if (!auditMountedRef.current) return
    if (selectedLog) {
      reportAuditEvent('activity.details_viewed', {
        resourceId: selectedLog.id,
        params: {
          agentId: selectedLog.internalAgentId ?? selectedLog.externalAgentId,
          action: selectedLog.action,
        },
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLogId])

  // Apply frontend search filter (for team name, input args, output summary)
  const filteredLogs = useMemo(() => {
    if (!search.trim()) return allLogs

    const query = search.toLowerCase()
    return allLogs.filter(log => {
      // Search in team name
      const agentName = log.agentName || ''
      if (agentName.toLowerCase().includes(query)) return true

      // Search in action
      if (log.action.toLowerCase().includes(query)) return true

      // Search in input args (stringify and search)
      const inputStr = JSON.stringify(log.inputArgs).toLowerCase()
      if (inputStr.includes(query)) return true

      // Search in output summary
      if (log.outputSummary?.toLowerCase().includes(query)) return true

      return false
    })
  }, [allLogs, search])

  // Back to page 1 whenever the query changes. Compared during render, so the
  // first frame after a new search is page 1 rather than the old page number
  // against the new results.
  const [pagedQuery, setPagedQuery] = useState(`${search}|${timeRangePreset}`)
  if (`${search}|${timeRangePreset}` !== pagedQuery) {
    setPagedQuery(`${search}|${timeRangePreset}`)
    setCurrentPage(1)
  }

  // Pagination calculations.
  // Two-layer pagination: useInfiniteQuery streams pages from the backend
  // (cursor-based, BACKEND_PAGE_SIZE rows each) and the UI displays
  // ITEMS_PER_PAGE per page. The two sizes don't have to match — what matters
  // is that we have ENOUGH ROWS loaded for the page being displayed.
  // Page count uses backend `total` so the user sees the true number of pages.
  // When a search is active we fall back to filteredLogs.length since search
  // narrows visible rows after fetch.
  const backendTotal = data?.pages[0]?.total ?? 0
  const loadedRowsCount = search.trim() ? filteredLogs.length : Math.max(filteredLogs.length, backendTotal)
  const totalPages = Math.max(1, Math.ceil(loadedRowsCount / ITEMS_PER_PAGE))
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE
  const endIndex = startIndex + ITEMS_PER_PAGE
  const paginatedLogs = filteredLogs.slice(startIndex, endIndex)

  const handlePrevPage = () => {
    setCurrentPage(prev => {
      const target = Math.max(1, prev - 1)
      track('activity_paginated', { direction: 'prev', to_page: target })
      return target
    })
  }

  const handleNextPage = async () => {
    const next = Math.min(totalPages, currentPage + 1)
    if (next === currentPage) return
    track('activity_paginated', { direction: 'next', to_page: next })

    // We need next * ITEMS_PER_PAGE rows loaded to fully render that page.
    // The UI page size and backend batch size don't have to divide evenly —
    // we just keep fetching backend pages until we have enough rows. We read
    // counts from each fetchNextPage result (not the closure-captured `data`,
    // which doesn't update mid-function) so the loop terminates correctly.
    const targetRows = next * ITEMS_PER_PAGE
    let currentData = data
    while (true) {
      const loadedRows = currentData?.pages.flatMap(p => p.items).length ?? 0
      if (loadedRows >= targetRows) break
      const lastPage = currentData?.pages[currentData.pages.length - 1]
      if (!lastPage?.hasMore) break
      const result = await fetchNextPage()
      if (!result.data) break
      currentData = result.data
    }
    setCurrentPage(next)
  }

  const handleTimeRangeSelect = (preset: TimeRangePreset) => {
    track('activity_time_range_changed', { preset })
    setTimeRangePreset(preset)
    if (preset !== 'custom') {
      setShowTimeRangeDropdown(false)
    }
  }

  const currentPresetLabel = TIME_RANGE_PRESETS.find(p => p.value === timeRangePreset)?.label || 'Select range'

  const showEmptyState = !isWaitingForData && allLogs.length === 0 && !search

  return (
    <>
      <div className="activity-page">
        <PageHeader title="Activity" subtitle="View all agent activity across your workspace" />

        <div className="activity-page__filters">
          {/* Time Range Filter */}
          <div className="activity-filter" ref={timeRangeRef}>
            <button
              className="activity-filter__trigger"
              onClick={() => setShowTimeRangeDropdown(!showTimeRangeDropdown)}
            >
              <ClockIcon width="16" height="16" />
              {currentPresetLabel}
              <ChevronDownIcon width="12" height="12" />
            </button>

            {showTimeRangeDropdown && (
              <div className="activity-filter__dropdown">
                {TIME_RANGE_PRESETS.map(preset => (
                  <button
                    key={preset.value}
                    className={`activity-filter__option ${timeRangePreset === preset.value ? 'activity-filter__option--active' : ''}`}
                    onClick={() => handleTimeRangeSelect(preset.value)}
                  >
                    {preset.label}
                  </button>
                ))}

                {timeRangePreset === 'custom' && (
                  <div className="activity-filter__custom">
                    <DateRangeInput
                      startDate={customStartDate}
                      endDate={customEndDate}
                      onStartDateChange={setCustomStartDate}
                      onEndDateChange={setCustomEndDate}
                    />
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => setShowTimeRangeDropdown(false)}
                      disabled={!customStartDate || !customEndDate}
                    >
                      Apply
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Search Input */}
          <TextInput
            variant="search"
            className="activity-search"
            placeholder="Search by team, action, input, or output..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {/* Results count */}
        <div className="activity-page__count">
          {filteredLogs.length} {filteredLogs.length === 1 ? 'activity' : 'activities'}
          {search && ` matching "${search}"`}
        </div>

        {/* Activity Table */}
        <div className="activity-table-wrapper">
          {isError ? (
            <div className="activity-page__error">
              <InfoCircleIcon width="48" height="48" style={{ color: 'var(--color-gray-300)', marginBottom: '16px' }} />
              <p>Failed to load activity logs</p>
              <p className="activity-page__error-detail">{error?.message}</p>
              <div style={{ marginTop: '16px' }}>
                <Button variant="outline" onClick={() => window.location.reload()}>
                  Retry
                </Button>
              </div>
            </div>
          ) : (
            <table className="activity-table">
              <thead>
                <tr className="activity-table__header-row">
                  <th className="activity-table__header">Time</th>
                  <th className="activity-table__header">Agent</th>
                  <th className="activity-table__header">Action</th>
                  <th className="activity-table__header">Outcome</th>
                  <th className="activity-table__header">Triggered By</th>
                  <th className="activity-table__header">Duration</th>
                  <th className="activity-table__header activity-table__header--actions"></th>
                </tr>
              </thead>
              <tbody>
                {isWaitingForData ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="activity-table__state">
                        <div className="activity-empty__visual">
                          <div className="activity-empty__visual-center">
                            <ClockIcon />
                          </div>
                          <div className="activity-empty__visual-ring activity-empty__visual-ring--1" />
                          <div className="activity-empty__visual-ring activity-empty__visual-ring--2" />
                          <div className="activity-empty__visual-ring activity-empty__visual-ring--3" />
                        </div>
                        <h2 className="activity-empty__header">Loading Activity</h2>
                        <p className="activity-empty__subtext">
                          Fetching recent activity from your agents...
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : showEmptyState ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="activity-table__state">
                        <div className="activity-empty__visual">
                          <div className="activity-empty__visual-center">
                            <ClockIcon />
                          </div>
                          <div className="activity-empty__visual-ring activity-empty__visual-ring--1" />
                          <div className="activity-empty__visual-ring activity-empty__visual-ring--2" />
                          <div className="activity-empty__visual-ring activity-empty__visual-ring--3" />
                        </div>
                        <h2 className="activity-empty__header">No Activity Yet</h2>
                        <p className="activity-empty__subtext">
                          Once your agents start working, their actions, decisions, and results will appear here.
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : filteredLogs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="activity-table__empty">
                      {search ? (
                        <>No activities match your search.</>
                      ) : (
                        <>No activity recorded for this time period.</>
                      )}
                    </td>
                  </tr>
                ) : (
                  paginatedLogs.map(log => (
                    <ActivityRow
                      key={log.id}
                      log={log}
                      teamName={log.agentName ?? 'Unknown agent'}
                      onSelect={(l) => {
                        track('activity_details_modal_opened', { log_id: l.id, action: l.action })
                        setSelectedLogId(l.id)
                      }}
                      onCorrect={(l) => {
                        track('activity_correct_modal_opened', { log_id: l.id })
                        setCorrectingLog(l)
                      }}
                      onRerun={handleRerun}
                      rerunPending={rerun.isPending}
                    />
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        {filteredLogs.length > 0 && (
          <div className="activity-page__pagination">
            <button
              className="activity-pagination__btn"
              onClick={handlePrevPage}
              disabled={currentPage === 1}
              aria-label="Previous page"
            >
              <ChevronLeftIcon width="16" height="16" />
            </button>
            <span className="activity-pagination__info">
              {currentPage} of {totalPages}
            </span>
            <button
              className="activity-pagination__btn"
              onClick={handleNextPage}
              disabled={currentPage >= totalPages || isFetchingNextPage}
              aria-label="Next page"
            >
              <ChevronRightIcon width="16" height="16" />
            </button>
          </div>
        )}
      </div>

      {/* Detail Modal */}
      {selectedLog && (
        <ActivityDetailModal
          log={selectedLog}
          teamName={selectedLog.agentName ?? 'Unknown agent'}
          onClose={() => setSelectedLogId(null)}
          onRerun={handleRerun}
          rerunPending={rerun.isPending}
        />
      )}

      {/* Correction Modal */}
      {correctingLog && (
        <CorrectConfirmModal
          log={correctingLog}
          onClose={() => setCorrectingLog(null)}
          onSuccess={() => {
            // Activity logs will be invalidated by the mutation
          }}
        />
      )}
    </>
  )
}
