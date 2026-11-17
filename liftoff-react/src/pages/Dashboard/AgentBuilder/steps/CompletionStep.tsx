import { useEffect, useRef } from 'react'
import { Button, IntegrationIconsDisplay } from '../../../../components'
import { type SelectedIntegration } from '../../../../components/IntegrationsSelector'
import { type ArtifactClassification, type DistillStage } from '../../../../services/internalAgents'
import { track } from '../../../../lib/analytics'
import { distillStageMessage } from './distillStageMessages'

interface CompletionStepProps {
  role: string
  scopeSummary: string
  integrations: SelectedIntegration[]
  onLaunch: () => void
  onNotNow: () => void
  isLaunching?: boolean
  isSaving?: boolean
  /** Where absorption routed each imported file (P1.1). Absent when the build
   *  carried no attachments, which is the ordinary case. */
  absorption?: ArtifactClassification[]
  /** Artifact names approved for the shared knowledge library. The library is
   *  a curated help centre, so nothing lands there without this. */
  libraryApprovals?: string[]
  onLibraryApprovalsChange?: (names: string[]) => void
  /** Set when creating the team failed. Previously a failed create did nothing
   *  observable here: the spinner stopped and the screen was unchanged, so the
   *  person had no way to tell the request had been rejected. */
  error?: string | null
  /** The distillation is still running behind this screen.
   *
   *  Under the waved strategy the summary arrives long before the rest of the
   *  artifact, so this screen is readable while the work continues. A decision
   *  taken now is honoured, but the create cannot be sent until the artifact
   *  lands — which is what the stage line below explains. */
  finalizing?: boolean
  /** Current stage of that remaining work, for the line shown while waiting. */
  finalizingStage?: DistillStage | null
  /** Which flow rendered this screen. Explore and build differ in what precedes
   *  the screen, so their dwell times are not one population. */
  surface?: 'build' | 'explore'
  /** Re-run the distillation.
   *
   *  Set only when the artifact never arrived. Under the waved strategy this
   *  screen renders on the summary, so a failure can land AFTER it is showing —
   *  and the "Try Again" button lives on the loading step, which is no longer on
   *  screen. Without this the person is left looking at an error beside two
   *  buttons that cannot proceed. */
  onRetryDistill?: () => void
}

export default function CompletionStep({
  role,
  scopeSummary,
  integrations,
  onLaunch,
  onNotNow,
  isLaunching = false,
  isSaving = false,
  absorption,
  libraryApprovals = [],
  onLibraryApprovalsChange,
  error,
  finalizing = false,
  finalizingStage = null,
  surface = 'build',
  onRetryDistill,
}: CompletionStepProps) {
  const roleDisplay = role || 'team member'
  const isAnyPending = isLaunching || isSaving

  // Dwell time: how long this screen was read before a decision.
  //
  // Phase 0 of the waves plan. The split shows this screen at ~4s but the
  // artifact is not ready until ~64s, so whether the remaining wait is a real
  // problem depends entirely on how long people actually spend here — and
  // nothing measured that before. A ref rather than state: reading it must not
  // re-render, and it must survive the re-render a pending action causes.
  // Stamped in the effect rather than at the useRef call: reading the clock
  // during render is an impure call, and the effect runs before any click can
  // reach the buttons, so nothing can read a zero.
  const shownAtRef = useRef<number>(0)
  useEffect(() => {
    shownAtRef.current = Date.now()
  }, [])

  const decide = (action: 'launch' | 'not_now') => {
    track('team_builder_completion_decided', {
      action,
      dwell_ms: Date.now() - shownAtRef.current,
      // Recorded at click time, not at resolution: the question is whether the
      // person ran into the wait, not whether the wait had ended by the time
      // the request settled.
      blocked: finalizing,
      surface,
    })
    if (action === 'launch') onLaunch()
    else onNotNow()
  }

  // The line shown when a decision is waiting on the artifact. The plan is
  // explicit that this must not be a bare spinner: a spinning button reads as
  // stuck, where named progress reads as working.
  const waitingLine = isAnyPending && finalizing
    ? distillStageMessage(finalizingStage)
    : null

  // What the import produced. Counted rather than listed: the detail lives on
  // the team member's settings page, where it stays editable.
  const importedSkillCount = (absorption ?? [])
    .reduce((total, a) => total + (a.skills?.length ?? 0), 0)
  const importedMemoryCount = (absorption ?? [])
    .reduce((total, a) => total + (a.memories?.filter(m => m.scope === 'individual').length ?? 0), 0)
  const referenceCandidates = (absorption ?? []).filter(a => a.category === 'reference')

  const importedSummary = [
    importedSkillCount > 0
      ? `${importedSkillCount} ${importedSkillCount === 1 ? 'skill' : 'skills'}`
      : null,
    importedMemoryCount > 0
      ? `${importedMemoryCount} ${importedMemoryCount === 1 ? 'note' : 'notes'}`
      : null,
  ].filter(Boolean).join(' and ')

  const toggleApproval = (name: string) => {
    const next = libraryApprovals.includes(name)
      ? libraryApprovals.filter(n => n !== name)
      : [...libraryApprovals, name]
    onLibraryApprovalsChange?.(next)
  }

  // Separate app integrations from collaborators
  const appIntegrations = integrations
    .filter(i => i.type !== 'collaborator')
    .map(i => ({ id: i.id, integrationId: i.integrationId, selectedObjects: i.selectedObjects }))

  const collaboratorCount = integrations.filter(i => i.type === 'collaborator').length

  const hasWorkingWith = appIntegrations.length > 0 || collaboratorCount > 0

  return (
    <div className="completion-step">
      <div className="completion-step__message">
        <h1 className="completion-step__header">
          Your new {roleDisplay} is ready.
        </h1>
        <p className="completion-step__subtext">
          Aligned to your goals and ready to begin immediately.
        </p>
      </div>

      <div className="completion-step__columns">
        {/* Left Column - What this is */}
        <div className="completion-step__card">
          <div className="completion-step__detail">
            <span className="completion-step__detail-label">Scope</span>
            <p className="completion-step__detail-value">{scopeSummary}</p>
          </div>

          <div className="completion-step__detail">
            <span className="completion-step__detail-label">Operating model</span>
            <p className="completion-step__detail-value">Works autonomously within your defined scope and guardrails.</p>
          </div>

          {importedSummary && (
            <div className="completion-step__detail">
              <span className="completion-step__detail-label">Carried over from your files</span>
              <p className="completion-step__detail-value">
                {importedSummary}. You can review these on the team member settings page.
              </p>
            </div>
          )}

          {referenceCandidates.length > 0 && (
            <div className="completion-step__detail">
              <span className="completion-step__detail-label">Add to your knowledge library</span>
              <p className="completion-step__detail-value">
                These look like reference documents your whole workspace could use. Nothing is added unless you choose it.
              </p>
              <ul className="completion-step__library-list">
                {referenceCandidates.map(candidate => (
                  <li key={candidate.name} className="completion-step__library-item">
                    <label className="completion-step__library-label">
                      <input
                        type="checkbox"
                        checked={libraryApprovals.includes(candidate.name)}
                        onChange={() => toggleApproval(candidate.name)}
                        disabled={isAnyPending}
                      />
                      <span>{candidate.referenceTitle || candidate.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {hasWorkingWith && (
            <div className="completion-step__detail">
              <span className="completion-step__detail-label">Working with</span>
              <div className="completion-step__integrations">
                <IntegrationIconsDisplay
                  appIntegrations={appIntegrations}
                  externalAgentCount={collaboratorCount}
                  classPrefix="completion-step"
                />
              </div>
            </div>
          )}
        </div>

        {/* Right Column - Decision panel */}
        <div className="completion-step__decision">
          {/* role="alert" because this appears in response to an action the
              person just took, on a screen that otherwise does not change —
              exactly the case a live region exists for. */}
          {error && <p className="completion-step__error-message" role="alert">{error}</p>}
          {/* Only when the artifact itself never arrived. A rejected create is a
              different failure: the artifact is fine and the two buttons below
              can be pressed again, so offering a re-distill there would throw
              away good work to retry the wrong step. */}
          {error && onRetryDistill && (
            <div className="completion-step__actions">
              <Button variant="primary" onClick={onRetryDistill}>
                Try Again
              </Button>
            </div>
          )}
          <div className="completion-step__actions">
            <Button
              variant="primary"
              onClick={() => decide('launch')}
              disabled={isAnyPending || !!onRetryDistill}
              loading={isLaunching}
            >
              Launch Now
            </Button>
            <Button
              variant="text"
              onClick={() => decide('not_now')}
              disabled={isAnyPending || !!onRetryDistill}
              loading={isSaving}
            >
              Maybe Later
            </Button>
          </div>

          {/* aria-live so the stage changes are announced rather than only
              painted: this region is the sole feedback during a wait that can
              run to the better part of a minute. */}
          {waitingLine && (
            <p className="completion-step__waiting" role="status" aria-live="polite">
              {waitingLine}
            </p>
          )}

          <p className="completion-step__control-note">Pause or adjust this scope at any time.</p>

          <div className="completion-step__why">
            <span className="completion-step__why-title">What to expect</span>
            <ul className="completion-step__why-list">
              <li>Starts working immediately</li>
              <li>No hiring or onboarding required</li>
              <li>Expand scope later as your needs grow</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
