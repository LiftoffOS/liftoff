// Where a migration state sends the browser.
//
// The same mapping is written down THREE times, in three repositories: here (as
// `webPath` on the view), in the CLI (`resumePathForState`, which is the URL it
// opens after an import), and in the web app (`stageForState`, which rewrites
// the address bar from the record). Nothing in the build compares them, and
// they drifted the moment the wizard collapsed six screens into three: this
// service kept emitting `/setup`, `/build`, `/converting` and `/cutover`, of
// which only two were still routes and none were the route the wizard would
// settle on. The user saw the URL correct itself in front of them.
//
// So this test pins the SET of destinations, not just one example. A fourth
// stage name added here without a screen behind it fails.

import { sourceMigrationService } from '../service';
import { sourceMigrationRepository as repo } from '../repository';
import type { MigrationState, SourceMigration } from '../types';

jest.mock('../repository');
jest.mock('../connections');

const mockRepo = repo as jest.Mocked<typeof repo>;

const TENANT = '11111111-1111-4111-8111-111111111111';

/** The wizard's three screens. There is no fourth. */
const STAGES = ['review', 'building', 'done'] as const;

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

function migration(state: MigrationState): SourceMigration {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    tenantId: TENANT,
    source: 'openclaw',
    sourceVersion: '2026.8.1',
    adapterVersion: '1.0.0',
    installationFingerprint: 'fp',
    state,
    bundle: null,
    unsupportedItems: [],
    hostingRequirements: [],
    diagnostics: [],
    lastError: null,
    libraryApprovals: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    convertedAt: null,
    completedAt: null,
  } as SourceMigration;
}

async function webPathFor(state: MigrationState): Promise<string> {
  const view = await sourceMigrationService.buildView(TENANT, migration(state), {
    onboardingComplete: true,
  });
  return view.webPath;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRepo.listItems.mockResolvedValue([]);
  mockRepo.listRoutines.mockResolvedValue([]);
  mockRepo.listConnections.mockResolvedValue([]);
});

describe('webPath', () => {
  it.each<[MigrationState, string]>([
    ['importing', 'review'],
    ['setup_required', 'review'],
    ['payment_required', 'review'],
    ['conversion_queued', 'building'],
    ['converting', 'building'],
    ['conversion_ready', 'done'],
    ['ready_to_cutover', 'done'],
    ['active', 'done'],
    // A failure is actionable, and review is where the per-member error and its
    // retry live. Stranding the person is the alternative.
    ['failed', 'review'],
  ])('sends %s to the %s screen', async (state, stage) => {
    expect(await webPathFor(state)).toBe(`/dashboard/switch/openclaw/${stage}`);
  });

  it('never names a screen the wizard does not have', async () => {
    for (const state of ALL_STATES) {
      const path = await webPathFor(state);
      const stage = path.split('/').pop();
      expect(STAGES).toContain(stage as (typeof STAGES)[number]);
    }
  });

  it('resolves every requirement onto a real screen', async () => {
    // A requirement whose resolvePath is a dead route is worse than no path at
    // all: the wizard renders a link that goes nowhere useful.
    const view = await sourceMigrationService.buildView(TENANT, migration('setup_required'), {
      onboardingComplete: true,
    });
    for (const requirement of view.requirements) {
      if (!requirement.resolvePath) continue;
      expect(STAGES).toContain(requirement.resolvePath.split('/').pop() as (typeof STAGES)[number]);
    }
  });
});
