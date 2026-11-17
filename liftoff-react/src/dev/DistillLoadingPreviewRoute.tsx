// Dev-only preview of the distillation loading screen.
//
// LoadingStep is normally unreachable except by running a real distillation:
// you must walk the builder to step 4 (or hire a template from Explore), the
// screen only exists while the backend stream is open, and it vanishes the
// moment the summary lands. That is roughly a minute of setup per look, with
// a real backend call behind it, to watch an animation you are trying to tune.
//
// This route mounts the REAL <LoadingStep /> inside the REAL .agent-builder
// wrapper both production callers use, and feeds it the REAL DistillStage
// union. Nothing is stubbed but the clock: a scripted timeline replaces the
// SSE stream, using durations close to what a live distillation takes, so the
// pacing you see here is the pacing someone gets. If it feels slow here, it
// feels slow in production.
//
// The component owns progression internally and only ever advances (see the
// `stageTarget > messageIndex` guard in LoadingStep), so stepping backwards
// remounts it via `runId` rather than pretending a rewind is possible.
//
// This file is only loaded under `import.meta.env.DEV` (see App.tsx). The
// conditional lazy() construction there tree-shakes the entire module, chunk
// included, out of production builds.

import { useCallback, useEffect, useRef, useState } from 'react'
import LoadingStep from '../pages/Dashboard/AgentBuilder/steps/LoadingStep'
import BackButton from '../components/BackButton'
import Button from '../components/Button'
import ModalOverlay from '../components/ModalOverlay'
import type { DistillVariant } from '../pages/Dashboard/AgentBuilder/steps/distillStageMessages'
import '../pages/Dashboard/AgentUpdatePage.css'
import type { DistillStage } from '../services/internalAgents'
import '../components/agentBuilderInput.css'
// Only for the .agent-builder wrapper the build surface sits in. The
// checklist's own rules come with the component: this import used to supply
// them too, which is why the preview looked right while the update page
// rendered the same component completely unstyled.
import '../pages/Dashboard/AgentBuilder/AgentBuilder.css'

/**
 * The stream as it actually arrives, with roughly the dwell time each stage
 * gets on a live build. `absorbing` is included because a build carrying
 * attachments emits it; drop the toggle to see the (more common) run without.
 */
const TIMELINE: { stage: DistillStage; ms: number }[] = [
  { stage: 'connected', ms: 1200 },
  { stage: 'validating', ms: 3500 },
  { stage: 'absorbing', ms: 2500 },
  { stage: 'analyzing', ms: 12000 },
  // Back to back with analyzing in the real service, which is exactly why it
  // went unnoticed: it flashes past, and its only visible effect was a crash.
  { stage: 'fetching_tools', ms: 400 },
  { stage: 'generating', ms: 26000 },
  { stage: 'finalizing', ms: 6000 },
]

type Mode = 'stream' | 'manual' | 'no-stage' | 'error'

const MODES: { id: Mode; label: string; note: string }[] = [
  { id: 'stream', label: 'Live stream', note: 'Scripted stage timings, close to a real build.' },
  { id: 'manual', label: 'Hold a stage', note: 'Pin one stage and study it.' },
  { id: 'no-stage', label: 'No stage events', note: 'The 6s fallback cycle, when the stream reports nothing.' },
  { id: 'error', label: 'Error', note: 'The failed state and its retry.' },
]

const SPEEDS = [0.25, 0.5, 1, 2, 4]

/** Where the screen actually appears in the product. */
const SURFACES: { id: DistillVariant; label: string; note: string }[] = [
  { id: 'build', label: 'Builder', note: 'Full screen, /dashboard/agents/build step 4.' },
  { id: 'update', label: 'Update modal', note: 'Over the settings, from Optimize or Save.' },
]

const panel: React.CSSProperties = {
  position: 'fixed',
  top: '16px',
  right: '16px',
  zIndex: 9999,
  width: '280px',
  padding: '14px',
  background: 'var(--bg-card)',
  border: '1px solid var(--border-medium)',
  borderRadius: '12px',
  boxShadow: 'var(--shadow-sm)',
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--text-sm)',
  color: 'var(--color-black)',
}

const label: React.CSSProperties = {
  display: 'block',
  marginBottom: '4px',
  color: 'var(--color-gray-400)',
  fontSize: 'var(--text-xs)',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
}

// Custom controls drift heavier than body text without these three.
const fontReset: React.CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontVariationSettings: '"wght" 400',
  letterSpacing: 'normal',
}

const field: React.CSSProperties = {
  ...fontReset,
  width: '100%',
  padding: '7px 9px',
  background: 'var(--color-white)',
  border: '1px solid var(--border-medium)',
  borderRadius: '7px',
  fontSize: 'var(--text-sm)',
  color: 'var(--color-black)',
}

function chip(active: boolean): React.CSSProperties {
  return {
    ...fontReset,
    padding: '5px 9px',
    background: active ? 'var(--color-black)' : 'var(--color-white)',
    color: active ? 'var(--color-white)' : 'var(--color-black)',
    border: '1px solid var(--border-medium)',
    borderRadius: '999px',
    cursor: 'pointer',
    fontSize: 'var(--text-xs)',
  }
}

const row: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '5px' }

const backdrop: React.CSSProperties = {
  minHeight: '100vh',
  padding: '56px max(24px, calc(50vw - 380px))',
  background: 'var(--bg-light)',
  display: 'flex',
  flexDirection: 'column',
  gap: '18px',
}

const bar: React.CSSProperties = {
  background: 'var(--color-white)',
  border: '1px solid var(--border-medium)',
  borderRadius: '10px',
}
const group: React.CSSProperties = { marginTop: '12px' }

export default function DistillLoadingPreviewRoute() {
  const [role, setRole] = useState('Recruiter')
  const [mode, setMode] = useState<Mode>('stream')
  const [speed, setSpeed] = useState(1)
  const [withAttachments, setWithAttachments] = useState(true)
  const [surface, setSurface] = useState<DistillVariant>('build')
  const [stageIndex, setStageIndex] = useState(-1)
  // Remount key. LoadingStep advances monotonically, so replaying (or stepping
  // back) means giving it a fresh instance rather than a lower stage.
  const [runId, setRunId] = useState(0)

  const timeline = withAttachments ? TIMELINE : TIMELINE.filter((t) => t.stage !== 'absorbing')

  // Every control that invalidates the current run funnels through here.
  // Deliberately called from the handlers rather than an effect on [mode]:
  // resetting in an effect is a cascading render, and the reset is a
  // consequence of the click, not of the state settling.
  const restart = useCallback(() => {
    setStageIndex(-1)
    setRunId((n) => n + 1)
  }, [])

  // Scripted stream. One timeout per stage rather than an interval, so each
  // stage keeps its own dwell time.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    if (mode !== 'stream') return
    if (stageIndex >= timeline.length - 1) return
    const next = stageIndex + 1
    const wait = next === 0 ? 400 : timeline[stageIndex].ms
    timer.current = setTimeout(() => setStageIndex(next), wait / speed)
    return () => clearTimeout(timer.current)
  }, [mode, stageIndex, timeline, speed])

  const activeStage: DistillStage | null =
    mode === 'no-stage' || mode === 'error' || stageIndex < 0 ? null : timeline[stageIndex].stage

  const pinStage = (i: number) => {
    // Backwards is a remount; forwards keeps the fade you came to watch.
    if (i <= stageIndex) setRunId((n) => n + 1)
    setStageIndex(i)
  }

  const step = (
    <LoadingStep
      key={runId}
      role={role}
      stage={mode === 'manual' && stageIndex < 0 ? null : activeStage}
      error={mode === 'error' ? 'The build could not be completed. Please try again.' : null}
      onRetry={restart}
      variant={surface}
    />
  )

  return (
    <>
      {surface === 'build' ? (
        <div className="agent-builder">
          {/* Positioned by the parent, not by LoadingStep, exactly as both real
              callers do it. Here it restarts rather than cancels, since there is
              no run to abandon. */}
          <BackButton onClick={restart} />
          <div className="agent-builder__content">{step}</div>
        </div>
      ) : (
        <>
          {/* A stand-in for the settings page underneath. Deliberately shapes
              only, no borrowed copy: its whole job is to give the overlay's
              backdrop-filter something to blur, which an empty preview page
              cannot do. Without it the blur is invisible here and reads as
              missing. */}
          <div style={backdrop} aria-hidden="true">
            {[68, 40, 52, 44, 60, 36, 48].map((h, i) => (
              <div key={i} style={{ ...bar, height: `${h}px` }} />
            ))}
          </div>
          {/* The same composition AgentUpdatePage uses: its own box class inside
              the shared overlay, so the dialog width and padding are real. */}
          <ModalOverlay onClose={restart} contentClassName="modal-overlay__content--rows">
            <div className="agent-update__distill-modal">
              {step}
              <Button variant="outline" onClick={restart}>Cancel</Button>
            </div>
          </ModalOverlay>
        </>
      )}

      <div style={panel}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <strong>Distill loading</strong>
          <span style={{ color: 'var(--color-gray-400)', fontSize: 'var(--text-xs)' }}>dev only</span>
        </div>

        <div style={group}>
          <label style={label} htmlFor="preview-role">Role</label>
          <input
            id="preview-role"
            style={field}
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="Recruiter"
          />
        </div>

        <div style={group}>
          <span style={label}>Surface</span>
          <div style={row}>
            {SURFACES.map((v) => (
              <button
                key={v.id}
                type="button"
                style={chip(surface === v.id)}
                onClick={() => { setSurface(v.id); restart() }}
              >
                {v.label}
              </button>
            ))}
          </div>
          <p style={{ margin: '6px 0 0', color: 'var(--color-gray-400)', fontSize: 'var(--text-xs)' }}>
            {SURFACES.find((v) => v.id === surface)?.note}
          </p>
        </div>

        <div style={group}>
          <span style={label}>Mode</span>
          <div style={row}>
            {MODES.map((m) => (
              <button key={m.id} type="button" style={chip(mode === m.id)} onClick={() => { setMode(m.id); restart() }}>
                {m.label}
              </button>
            ))}
          </div>
          <p style={{ margin: '6px 0 0', color: 'var(--color-gray-400)', fontSize: 'var(--text-xs)' }}>
            {MODES.find((m) => m.id === mode)?.note}
          </p>
        </div>

        {mode === 'stream' && (
          <div style={group}>
            <span style={label}>Speed</span>
            <div style={row}>
              {SPEEDS.map((s) => (
                <button key={s} type="button" style={chip(speed === s)} onClick={() => setSpeed(s)}>
                  {s}x
                </button>
              ))}
            </div>
          </div>
        )}

        {(mode === 'stream' || mode === 'manual') && (
          <div style={group}>
            <span style={label}>Stage</span>
            <div style={row}>
              {timeline.map((t, i) => (
                <button
                  key={t.stage}
                  type="button"
                  style={chip(i === stageIndex)}
                  onClick={() => pinStage(i)}
                >
                  {t.stage}
                </button>
              ))}
            </div>
          </div>
        )}

        {(mode === 'stream' || mode === 'manual') && (
          <div style={group}>
            <label style={{ ...fontReset, display: 'flex', gap: '7px', alignItems: 'center', fontSize: 'var(--text-xs)' }}>
              <input
                type="checkbox"
                checked={withAttachments}
                onChange={(e) => { setWithAttachments(e.target.checked); restart() }}
              />
              Build carries attachments (emits absorbing)
            </label>
          </div>
        )}

        <div style={group}>
          <button type="button" style={{ ...chip(false), width: '100%', borderRadius: '7px', padding: '8px' }} onClick={restart}>
            Replay from the top
          </button>
        </div>
      </div>
    </>
  )
}
