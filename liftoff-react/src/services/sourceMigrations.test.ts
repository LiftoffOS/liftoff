// Switch wizard service client.
//
// The stage mapping is the piece that matters: it is what makes a deep link, a
// fresh page load, and the CLI's browser hand-off all agree about where the
// user is. It must mirror the backend's webPath exactly, because the wizard
// rewrites the URL to whatever the migration state implies.

import { describe, expect, it } from 'vitest'
import { SOURCE_LABELS, stageForState, type MigrationState } from './sourceMigrations'

describe('stageForState', () => {
  it.each<[MigrationState, string]>([
    ['importing', 'review'],
    ['setup_required', 'review'],
    ['payment_required', 'review'],
    ['conversion_queued', 'building'],
    ['converting', 'building'],
    ['conversion_ready', 'done'],
    ['ready_to_cutover', 'done'],
    ['active', 'done'],
  ])('maps %s to the %s stage', (state, stage) => {
    expect(stageForState(state)).toBe(stage)
  })

  it('sends a failed migration back to review rather than stranding the user', () => {
    // A failure is actionable: the review stage is where the per-item error is
    // shown and where a retry starts.
    expect(stageForState('failed')).toBe('review')
  })

  it('covers every state the backend can report', () => {
    // A state with no stage would leave the wizard rendering nothing, which is
    // how a user gets stuck on a blank page mid-migration.
    const ALL: MigrationState[] = [
      'importing',
      'setup_required',
      'payment_required',
      'conversion_queued',
      'converting',
      'conversion_ready',
      'ready_to_cutover',
      'active',
      'failed',
    ]
    const KNOWN_STAGES = ['review', 'building', 'done']
    for (const state of ALL) {
      expect(KNOWN_STAGES).toContain(stageForState(state))
    }
  })
})

describe('source labels', () => {
  it('names only the sources this release supports', () => {
    // DeerFlow, Omnigent and Agno are deferred. A label here would imply a
    // funnel that does not exist.
    expect(Object.keys(SOURCE_LABELS).sort()).toEqual([
      'claude-code',
      'codex',
      'hermes',
      'openclaw',
    ])
  })

  it('uses the products own capitalisation', () => {
    expect(SOURCE_LABELS.openclaw).toBe('OpenClaw')
    expect(SOURCE_LABELS.hermes).toBe('Hermes')
    expect(SOURCE_LABELS['claude-code']).toBe('Claude Code')
    expect(SOURCE_LABELS.codex).toBe('Codex')
  })
})
