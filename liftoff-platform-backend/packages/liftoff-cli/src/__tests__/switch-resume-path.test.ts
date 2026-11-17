// Which page the CLI opens after an import.
//
// The CLI's whole job ends with a browser hand-off, so this mapping IS the
// hand-off. It is the third copy of a mapping that also lives in the platform
// backend (`webPath`) and the web app (`stageForState`), and when the wizard
// collapsed six screens into three, all three copies had to move together.
// This one is the most visible when it does not: the person watches the URL the
// CLI printed rewrite itself the moment the page loads.
//
// See src/source-migrations/__tests__/stage-paths.test.ts for the same pin on
// the backend side.

import { resumePathForState } from '../switch/orchestrator';
import type { MigrationState } from '../switch/contract';

/** The wizard's three screens. There is no fourth. */
const STAGES = ['review', 'building', 'done'];

const ALL_STATES: MigrationState[] = [
  'importing',
  'setup_required',
  'payment_required',
  'conversion_queued',
  'converting',
  'conversion_ready',
  'ready_to_cutover',
  'active',
  'failed',
];

describe('resumePathForState', () => {
  it.each<[MigrationState, string]>([
    ['importing', 'review'],
    ['setup_required', 'review'],
    ['payment_required', 'review'],
    ['conversion_queued', 'building'],
    ['converting', 'building'],
    ['conversion_ready', 'done'],
    ['ready_to_cutover', 'done'],
    ['active', 'done'],
    ['failed', 'review'],
  ])('opens the %s state on the %s screen', (state, stage) => {
    expect(resumePathForState('openclaw', state)).toBe(`/dashboard/switch/openclaw/${stage}`);
  });

  it('never opens a screen the wizard does not have', () => {
    for (const state of ALL_STATES) {
      expect(STAGES).toContain(resumePathForState('hermes', state).split('/').pop());
    }
  });

  it('keeps the source in the path', () => {
    // Both sources share one wizard; losing the segment would land the person
    // on the other product's import.
    expect(resumePathForState('hermes', 'importing')).toContain('/switch/hermes/');
    expect(resumePathForState('openclaw', 'importing')).toContain('/switch/openclaw/');
  });
});
