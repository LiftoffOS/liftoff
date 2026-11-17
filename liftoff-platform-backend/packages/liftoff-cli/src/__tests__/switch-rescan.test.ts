// Re-running `switch` on an installation that already has a migration.
//
// The installation fingerprint is derived from the PATH — `sha256(source:root)`
// — so it is deliberately stable across runs and deliberately blind to the
// installation's contents. That combination made the first scan permanent:
// someone who ran `switch`, read the review screen, went and fixed their
// OpenClaw config, and re-ran got "opening your migration" and their original
// snapshot. There is no `--force`, so the fix could not be imported at all.
//
// The boundary is the first model call. Before it, a re-run re-scans and
// replaces the bundle. Once conversion has started, the stored bundle is what
// was paid to distill and a re-run must not move it.
//
// The server repeats this rule (acceptBundle refuses a replacement past
// `payment_required`), because a boundary that lives only in a client is not a
// boundary. This file covers the client half.

import { runSwitch } from '../switch/orchestrator';
import * as api from '../switch/api';
import * as localState from '../switch/local-state';
import type { DetectedInstallation, MigrationBundleV1, SourceAdapter } from '../switch/contract';

jest.mock('../switch/api');
jest.mock('../switch/local-state');

const mockApi = api as jest.Mocked<typeof api>;
const mockState = localState as jest.Mocked<typeof localState>;

const TENANT = '11111111-1111-4111-8111-111111111111';
const MIGRATION_ID = '33333333-3333-4333-8333-333333333333';
const FINGERPRINT = 'fp-openclaw-1';

const INSTALLATION: DetectedInstallation = {
  source: 'openclaw',
  stateRoot: '/home/someone/.openclaw',
  installationFingerprint: FINGERPRINT,
  sourceVersion: '2026.8.1',
} as DetectedInstallation;

function bundle(agentCount: number): MigrationBundleV1 {
  return {
    bundleVersion: 1,
    source: 'openclaw',
    adapterVersion: '1.0.0',
    installationFingerprint: FINGERPRINT,
    agents: Array.from({ length: agentCount }, (_, i) => ({
      sourceRef: `agent:${i}`,
      role: `Role ${i}`,
      responsibilities: 'Do the work.',
      attachments: [],
      integrationRefs: [],
      mcpServerRefs: [],
      routineRefs: [],
    })),
    agentRelationships: [],
    instructions: [],
    skills: [],
    memories: [],
    routines: [],
    catalogConnectorRequirements: [],
    customMcpServerRequirements: [],
    hostingRequirements: [],
    governanceRules: [],
    modelPreferences: [],
    unsupportedItems: [],
    diagnostics: [],
  } as MigrationBundleV1;
}

/** An adapter whose scan returns however many agents the test asks for, so a
 *  re-scan can be told apart from a replayed snapshot. */
function adapterReturning(agentCount: number): SourceAdapter {
  return {
    source: 'openclaw',
    adapterVersion: '1.0.0',
    detect: jest.fn().mockResolvedValue([INSTALLATION]),
    searchedPaths: jest.fn().mockReturnValue([]),
    inventory: jest.fn().mockResolvedValue({ diagnostics: [] }),
    normalize: jest.fn().mockResolvedValue(bundle(agentCount)),
    pauseGuidance: jest.fn().mockReturnValue({ steps: [] }),
  } as unknown as SourceAdapter;
}

function view(state: string, extra: Record<string, unknown> = {}) {
  return {
    id: MIGRATION_ID,
    source: 'openclaw',
    state,
    onboardingComplete: true,
    webPath: `/dashboard/switch/openclaw/review`,
    itemCount: 0,
    convertedCount: 0,
    unsupportedCount: 0,
    items: [],
    requirements: [],
    ...extra,
  } as unknown as api.MigrationView;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockState.findMigration.mockReturnValue({
    migrationId: MIGRATION_ID,
    source: 'openclaw',
    installationFingerprint: FINGERPRINT,
    tenantId: TENANT,
    lastKnownState: 'payment_required',
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
  } as never);
});

describe('re-running switch before the build', () => {
  it.each(['importing', 'setup_required', 'payment_required', 'failed'])(
    're-scans and re-uploads when the migration is %s',
    async (state) => {
      mockApi.getMigration.mockResolvedValue(view(state));
      mockApi.uploadBundle.mockResolvedValue(view(state));

      const adapter = adapterReturning(4);
      const outcome = await runSwitch({ adapter, firebaseToken: 't', tenantId: TENANT });

      // The whole point: the installation was read again.
      expect(adapter.inventory).toHaveBeenCalled();
      expect(mockApi.uploadBundle).toHaveBeenCalled();
      expect(outcome.kind).toBe('uploaded');
      // And the summary reflects the NEW scan, not the stored snapshot.
      expect(outcome.kind === 'uploaded' && outcome.summary.agents).toBe(4);
    },
  );

  it('reuses the existing migration rather than creating a second one', async () => {
    // Idempotency on (tenant, source, fingerprint) is what stops a re-run
    // becoming a parallel import the person then has to choose between.
    mockApi.getMigration.mockResolvedValue(view('payment_required'));
    mockApi.uploadBundle.mockResolvedValue(view('payment_required'));

    await runSwitch({ adapter: adapterReturning(2), firebaseToken: 't', tenantId: TENANT });

    expect(mockApi.uploadBundle).toHaveBeenCalledWith('t', MIGRATION_ID, TENANT, expect.anything());
    expect(mockApi.createOrResumeMigration).not.toHaveBeenCalled();
  });
});

describe('re-running switch once the build has started', () => {
  it.each(['conversion_queued', 'converting', 'conversion_ready', 'ready_to_cutover'])(
    'resumes without re-uploading when the migration is %s',
    async (state) => {
      mockApi.getMigration.mockResolvedValue(view(state));

      const adapter = adapterReturning(9);
      const outcome = await runSwitch({ adapter, firebaseToken: 't', tenantId: TENANT });

      // Replacing the bundle here would rewind a build the tenant is paying for.
      expect(adapter.inventory).not.toHaveBeenCalled();
      expect(mockApi.uploadBundle).not.toHaveBeenCalled();
      expect(outcome.kind).toBe('resume_web');
    },
  );

  it('reports an already-active installation instead of re-importing it', async () => {
    mockApi.getMigration.mockResolvedValue(view('active'));

    const adapter = adapterReturning(1);
    const outcome = await runSwitch({ adapter, firebaseToken: 't', tenantId: TENANT });

    expect(outcome.kind).toBe('already_active');
    expect(mockApi.uploadBundle).not.toHaveBeenCalled();
  });
});

describe('the secret gate is not bypassed by the re-scan path', () => {
  it('runs on a re-upload, not only on the first upload', async () => {
    // The two paths share one function precisely so they cannot drift. A
    // re-scan that skipped the gate would be the one path that leaked.
    mockApi.getMigration.mockResolvedValue(view('payment_required'));
    mockApi.uploadBundle.mockResolvedValue(view('payment_required'));

    const adapter = adapterReturning(1);
    const leaky = bundle(1);
    (leaky.agents[0] as { responsibilities: string }).responsibilities =
      'token ' + 'sk-ant-api03-' + 'c'.repeat(64);
    (adapter.normalize as jest.Mock).mockResolvedValue(leaky);

    await expect(
      runSwitch({ adapter, firebaseToken: 't', tenantId: TENANT }),
    ).rejects.toThrow();
    expect(mockApi.uploadBundle).not.toHaveBeenCalled();
  });
});
