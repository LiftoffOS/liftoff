// OversightPage - Tenant oversight settings for HITL enforcement
// Per implementation plan: Phase 1.4 Connect to API with loading/error states

import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { track } from '../../lib/analytics'
import EllipsisVerticalIcon from '../../assets/icons/ellipsis-vertical.svg?react'
import { Button, PageHeader } from '../../components'
import {
  useOversightSettings,
  useUpdateOversightSettings,
  usePendingApprovalCount,
} from '../../hooks/useOversight'
import type {
  AutonomyLevel,
  EscalationLevel,
  CommunicationMode,
  SensitiveWorkSettings,
  OversightSettings,
} from '../../services/oversight'
import './OversightPage.css'

const autonomyLabels: Record<AutonomyLevel, string> = {
  autonomous: 'More autonomous',
  balanced: 'Balanced',
  controlled: 'More controlled',
}

const autonomyDescriptions: Record<AutonomyLevel, string> = {
  autonomous: 'Handle most work independently, escalate only when needed',
  balanced: 'Work independently, escalate important or sensitive decisions',
  controlled: 'Escalate more often for visibility and oversight',
}

const escalationLabels: Record<EscalationLevel, string> = {
  exceptions: 'Only exceptions',
  important: 'Important decisions',
  sensitive: 'Sensitive or high-impact work',
}

const communicationLabels: Record<CommunicationMode, string> = {
  draft: 'Draft first',
  auto: 'Send automatically when safe',
  review: 'Review for sensitive cases',
}

const sensitiveWorkLabels: Record<keyof SensitiveWorkSettings, string> = {
  customerCommunication: 'Customer communication',
  financialActions: 'Financial or revenue-impacting actions',
  dataChanges: 'Data changes (CRM, records, etc.)',
  externalPublishing: 'External publishing (email, Slack, etc.)',
  hiringDecisions: 'Hiring or people decisions',
  mergeToMain: 'Merging code to main branch',
}

// Must match the server's own defaults, field for field.
//
// The server is authoritative — `internal-agent-oversight/service.ts` seeds a
// new row with ('balanced', 'important', DEFAULT_SENSITIVE_WORK, 'review'), and
// reads merge `{ ...DEFAULT_SENSITIVE_WORK, ...stored }`. This object is what
// this page shows and edits before that row is known, so a field that disagrees
// is a value the page can WRITE BACK over the server's.
//
// `mergeToMain` was the one that disagreed, and it disagreed in the direction
// that costs the most. The server comment on DEFAULT_SENSITIVE_WORK records why
// it defaults ON: the category shipped `false`, so every tenant created before
// it — and every one after who never opened this page — had the single control
// governing merges to a default branch silently switched off, "an operator
// reasonably believing merges were governed because that is what the page is
// for." The server was fixed. This copy still held the pre-fix value, so the
// page could put it back: with no settings loaded, `draftSettings` starts from
// here, and `startEditing` only refreshes from `settings` when there ARE
// settings — so editing any section and saving persists `mergeToMain: false`,
// and the read-merge above then honours it forever.
//
// A safety category that arrives off is indistinguishable from one nobody
// added. Keep this in step with DEFAULT_SENSITIVE_WORK.
const defaultOversightSettings: Omit<OversightSettings, 'tenantId' | 'currentVersion' | 'createdAt' | 'updatedAt'> = {
  autonomy: 'balanced',
  escalation: 'important',
  sensitiveWork: {
    customerCommunication: true,
    financialActions: true,
    dataChanges: false,
    externalPublishing: true,
    hiringDecisions: false,
    mergeToMain: true,
  },
  communication: 'review',
}

type EditingSection = 'autonomy' | 'escalation' | 'sensitiveWork' | 'communication' | null

// Loading skeleton component [FIX: FE-001]
function OversightPageSkeleton() {
  return (
    <div className="oversight-page">
      <PageHeader title="Oversight" />
      <div className="oversight-page__content">
        {[1, 2, 3, 4, 5].map((i) => (
          <section key={i} className="oversight-section oversight-section--skeleton">
            <div className="skeleton skeleton--title" />
            <div className="skeleton skeleton--text" />
          </section>
        ))}
      </div>
    </div>
  )
}

// Error banner component [FIX: FE-001]
function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="oversight-page">
      <PageHeader title="Oversight" />
      <div className="oversight-page__error">
        <div className="error-banner">
          <span className="error-banner__icon">!</span>
          <p className="error-banner__message">{message}</p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      </div>
    </div>
  )
}

export default function OversightPage() {
  const navigate = useNavigate()

  // Fetch settings from API [FIX: FE-001]
  const { data: settings, isLoading, error, refetch } = useOversightSettings()
  const { mutate: updateSettings, isPending: isSaving } = useUpdateOversightSettings()
  const { data: pendingCount } = usePendingApprovalCount()

  const [editingSection, setEditingSection] = useState<EditingSection>(null)
  const [draftSettings, setDraftSettings] = useState<typeof defaultOversightSettings>(defaultOversightSettings)
  const viewedRef = useRef(false)
  useEffect(() => {
    if (viewedRef.current) return
    viewedRef.current = true
    track('oversight_viewed', {})
  }, [])

  // Seeded during render, from undefined rather than from `settings`: starting
  // from the current value makes the comparison false on the first render, so
  // settings already in cache would never reach the draft and a save would
  // persist this page's defaults instead. That is precisely how mergeToMain
  // came to be switched off for workspaces that never opened this page.
  const [seededSettings, setSeededSettings] = useState<typeof settings | undefined>(undefined)
  if (settings && settings !== seededSettings) {
    setSeededSettings(settings)
    setDraftSettings({
      autonomy: settings.autonomy,
      escalation: settings.escalation,
      sensitiveWork: settings.sensitiveWork,
      communication: settings.communication,
    })
  }

  // Review queue count from API. Null means the backend could not reach the
  // tenant runtime, which is rendered as an unknown count rather than as zero.
  const reviewQueueCount = pendingCount?.count ?? null

  const startEditing = (section: EditingSection) => {
    if (section) track('oversight_section_edit_started', { section })
    if (settings) {
      setDraftSettings({
        autonomy: settings.autonomy,
        escalation: settings.escalation,
        sensitiveWork: settings.sensitiveWork,
        communication: settings.communication,
      })
    }
    setEditingSection(section)
  }

  const cancelEditing = () => {
    if (editingSection) track('oversight_section_canceled', { section: editingSection })
    if (settings) {
      setDraftSettings({
        autonomy: settings.autonomy,
        escalation: settings.escalation,
        sensitiveWork: settings.sensitiveWork,
        communication: settings.communication,
      })
    }
    setEditingSection(null)
  }

  // Save with optimistic update [FIX: FE-007]
  const saveEditing = () => {
    const section = editingSection
    const changedFields: string[] = []
    if (settings) {
      if (settings.autonomy !== draftSettings.autonomy) changedFields.push('autonomy')
      if (settings.escalation !== draftSettings.escalation) changedFields.push('escalation')
      if (settings.communication !== draftSettings.communication) changedFields.push('communication')
      const swKeys = Object.keys(draftSettings.sensitiveWork) as (keyof SensitiveWorkSettings)[]
      const swChanged = swKeys.some((k) => settings.sensitiveWork[k] !== draftSettings.sensitiveWork[k])
      if (swChanged) changedFields.push('sensitiveWork')
    }
    updateSettings(draftSettings, {
      onSuccess: () => {
        track('oversight_settings_updated', { changed_fields: changedFields })
        if (section) {
          const newValue =
            section === 'autonomy' ? autonomyLabels[draftSettings.autonomy]
              : section === 'escalation' ? escalationLabels[draftSettings.escalation]
                : section === 'communication' ? communicationLabels[draftSettings.communication]
                  : (Object.entries(draftSettings.sensitiveWork)
                      .filter(([, v]) => v)
                      .map(([k]) => sensitiveWorkLabels[k as keyof SensitiveWorkSettings]))
          track('oversight_section_saved', { section, new_value: newValue })
        }
        setEditingSection(null)
      },
    })
  }

  const updateDraft = <K extends keyof typeof draftSettings>(
    key: K,
    value: (typeof draftSettings)[K]
  ) => {
    setDraftSettings({ ...draftSettings, [key]: value })
  }

  const toggleDraftSensitiveWork = (key: keyof SensitiveWorkSettings) => {
    setDraftSettings({
      ...draftSettings,
      sensitiveWork: {
        ...draftSettings.sensitiveWork,
        [key]: !draftSettings.sensitiveWork[key],
      },
    })
  }

  const getEnabledSensitiveWorkItems = () => {
    const workSettings = settings?.sensitiveWork ?? draftSettings.sensitiveWork
    return Object.entries(workSettings)
      .filter(([, enabled]) => enabled)
      .map(([key]) => sensitiveWorkLabels[key as keyof SensitiveWorkSettings])
  }

  // Loading state [FIX: FE-001]
  if (isLoading) {
    return <OversightPageSkeleton />
  }

  // Error state [FIX: FE-001]
  if (error) {
    return (
      <ErrorBanner
        message="Failed to load oversight settings"
        onRetry={() => refetch()}
      />
    )
  }

  // Use settings from API or defaults
  const currentSettings = settings ?? {
    ...defaultOversightSettings,
    tenantId: '',
    currentVersion: 1,
    createdAt: '',
    updatedAt: '',
  }

  return (
    <div className="oversight-page">
      <PageHeader title="Oversight" />

      <div className="oversight-page__content">
        {/* Section 1: Autonomy */}
        <section className="oversight-section">
          {editingSection === 'autonomy' ? (
            <>
              <div className="oversight-section__header">
                <h2 className="oversight-section__title">Autonomy</h2>
                <p className="oversight-section__helper">
                  How independently your agents should operate.
                </p>
              </div>
              <div className="oversight-segmented">
                {(['autonomous', 'balanced', 'controlled'] as AutonomyLevel[]).map((level) => (
                  <button
                    key={level}
                    className={`oversight-segmented__option ${draftSettings.autonomy === level ? 'oversight-segmented__option--active' : ''}`}
                    onClick={() => updateDraft('autonomy', level)}
                  >
                    <span className="oversight-segmented__label">{autonomyLabels[level]}</span>
                    <span className="oversight-segmented__description">
                      {autonomyDescriptions[level]}
                    </span>
                  </button>
                ))}
              </div>
              <div className="oversight-section__actions">
                <Button variant="outline" size="sm" onClick={cancelEditing} disabled={isSaving}>
                  Cancel
                </Button>
                <Button variant="primary" size="sm" onClick={saveEditing} disabled={isSaving}>
                  {isSaving ? 'Saving...' : 'Save'}
                </Button>
              </div>
            </>
          ) : (
            <div className="oversight-section__row">
              <div className="oversight-section__left">
                <h2 className="oversight-section__title">Autonomy</h2>
                <p className="oversight-section__helper">
                  How independently your agents should operate.
                </p>
              </div>
              <div className="oversight-section__right">
                <span className="oversight-section__value">
                  {autonomyLabels[currentSettings.autonomy]} - {autonomyDescriptions[currentSettings.autonomy]}
                </span>
                <button
                  className="oversight-section__more"
                  onClick={() => startEditing('autonomy')}
                  aria-label="More options"
                >
                  <EllipsisVerticalIcon />
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Section 2: Escalation */}
        <section className="oversight-section">
          {editingSection === 'escalation' ? (
            <>
              <div className="oversight-section__header">
                <h2 className="oversight-section__title">Escalation</h2>
                <p className="oversight-section__helper">
                  When work should be surfaced for review.
                </p>
              </div>
              <div className="oversight-segmented">
                {(['exceptions', 'important', 'sensitive'] as EscalationLevel[]).map((level) => (
                  <button
                    key={level}
                    className={`oversight-segmented__option ${draftSettings.escalation === level ? 'oversight-segmented__option--active' : ''}`}
                    onClick={() => updateDraft('escalation', level)}
                  >
                    <span className="oversight-segmented__label">{escalationLabels[level]}</span>
                  </button>
                ))}
              </div>
              <div className="oversight-section__actions">
                <Button variant="outline" size="sm" onClick={cancelEditing} disabled={isSaving}>
                  Cancel
                </Button>
                <Button variant="primary" size="sm" onClick={saveEditing} disabled={isSaving}>
                  {isSaving ? 'Saving...' : 'Save'}
                </Button>
              </div>
            </>
          ) : (
            <div className="oversight-section__row">
              <div className="oversight-section__left">
                <h2 className="oversight-section__title">Escalation</h2>
                <p className="oversight-section__helper">
                  When work should be surfaced for review.
                </p>
              </div>
              <div className="oversight-section__right">
                <span className="oversight-section__value">{escalationLabels[currentSettings.escalation]}</span>
                <button
                  className="oversight-section__more"
                  onClick={() => startEditing('escalation')}
                  aria-label="More options"
                >
                  <EllipsisVerticalIcon />
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Section 3: Sensitive Work */}
        <section className="oversight-section">
          {editingSection === 'sensitiveWork' ? (
            <>
              <div className="oversight-section__header">
                <h2 className="oversight-section__title">Sensitive Work</h2>
                <p className="oversight-section__helper">
                  Reviewed unless an approved workflow covers it.
                </p>
              </div>
              <div className="oversight-checkboxes">
                {(Object.keys(sensitiveWorkLabels) as (keyof SensitiveWorkSettings)[]).map((key) => (
                  <label key={key} className="oversight-checkbox">
                    <input
                      type="checkbox"
                      checked={draftSettings.sensitiveWork[key]}
                      onChange={() => toggleDraftSensitiveWork(key)}
                    />
                    <span className="oversight-checkbox__checkmark" />
                    <span className="oversight-checkbox__label">{sensitiveWorkLabels[key]}</span>
                  </label>
                ))}
              </div>
              <div className="oversight-section__actions">
                <Button variant="outline" size="sm" onClick={cancelEditing} disabled={isSaving}>
                  Cancel
                </Button>
                <Button variant="primary" size="sm" onClick={saveEditing} disabled={isSaving}>
                  {isSaving ? 'Saving...' : 'Save'}
                </Button>
              </div>
            </>
          ) : (
            <div className="oversight-section__row">
              <div className="oversight-section__left">
                <h2 className="oversight-section__title">Sensitive Work</h2>
                <p className="oversight-section__helper">
                  Reviewed unless an approved workflow covers it.
                </p>
              </div>
              <div className="oversight-section__right">
                {getEnabledSensitiveWorkItems().length > 0 ? (
                  <ul className="oversight-section__list">
                    {getEnabledSensitiveWorkItems().map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <span className="oversight-section__empty">No sensitive work types selected</span>
                )}
                <button
                  className="oversight-section__more"
                  onClick={() => startEditing('sensitiveWork')}
                  aria-label="More options"
                >
                  <EllipsisVerticalIcon />
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Section 4: Communication */}
        <section className="oversight-section">
          {editingSection === 'communication' ? (
            <>
              <div className="oversight-section__header">
                <h2 className="oversight-section__title">Communication</h2>
                <p className="oversight-section__helper">
                  How agents should handle outbound messages.
                </p>
              </div>
              <div className="oversight-segmented">
                {(['draft', 'auto', 'review'] as CommunicationMode[]).map((mode) => (
                  <button
                    key={mode}
                    className={`oversight-segmented__option ${draftSettings.communication === mode ? 'oversight-segmented__option--active' : ''}`}
                    onClick={() => updateDraft('communication', mode)}
                  >
                    <span className="oversight-segmented__label">
                      {communicationLabels[mode]}
                      {mode === 'review' && (
                        <span className="oversight-segmented__badge">Recommended</span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
              <div className="oversight-section__actions">
                <Button variant="outline" size="sm" onClick={cancelEditing} disabled={isSaving}>
                  Cancel
                </Button>
                <Button variant="primary" size="sm" onClick={saveEditing} disabled={isSaving}>
                  {isSaving ? 'Saving...' : 'Save'}
                </Button>
              </div>
            </>
          ) : (
            <div className="oversight-section__row">
              <div className="oversight-section__left">
                <h2 className="oversight-section__title">Communication</h2>
                <p className="oversight-section__helper">
                  How agents should handle outbound messages.
                </p>
              </div>
              <div className="oversight-section__right">
                <span className="oversight-section__value">
                  {communicationLabels[currentSettings.communication]}
                </span>
                <button
                  className="oversight-section__more"
                  onClick={() => startEditing('communication')}
                  aria-label="More options"
                >
                  <EllipsisVerticalIcon />
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Section 5: Review */}
        <section className="oversight-section oversight-section--highlight">
          <div className="oversight-section__row">
            <div className="oversight-section__left">
              <h2 className="oversight-section__title">Review</h2>
              <p className="oversight-section__helper">
                Items that need your attention.
              </p>
            </div>
            <div className="oversight-section__right">
              <span className="oversight-section__value">
                {reviewQueueCount === null
                  ? 'Count unavailable'
                  : `${reviewQueueCount} ${reviewQueueCount === 1 ? 'item' : 'items'} awaiting decision`}
              </span>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  track('oversight_review_queue_clicked', { pending_count: reviewQueueCount })
                  navigate('/dashboard/review')
                }}
              >
                Review
              </Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
