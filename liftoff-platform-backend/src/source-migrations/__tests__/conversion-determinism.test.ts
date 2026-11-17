// Conversion determinism.
//
// LLM distillation is not deterministic; the source-to-destination MAPPING must
// be. The three rules under test, in the order convertItem applies them:
//
//   1. destination agent present        -> return it. No distill, no create.
//   2. distill output present, no agent -> create from the stored output. No redistill.
//   3. neither                          -> may distill, subject to the attempt cap.
//
// Each is a real cost: breaking rule 1 charges a customer twice for one team
// member and leaves a duplicate in their workspace; breaking rule 2 pays for an
// LLM run that already succeeded.

import { sourceMigrationService } from '../service';
import { sourceMigrationRepository as repo } from '../repository';
import * as provisioning from '../../internal-agents/provisioning-helper';
import * as admission from '../admission';
import * as connections from '../connections';
import type { SourceMigration, SourceMigrationItem, StoredDistillInput } from '../types';

jest.mock('../repository');
jest.mock('../../internal-agents/provisioning-helper');
jest.mock('../connections');
jest.mock('../../internal-agents/service', () => ({
  InternalAgentService: jest.fn().mockImplementation(() => ({
    updateStatus: jest.fn().mockResolvedValue({ id: 'agent-1', status: 'active' }),
  })),
}));

const mockRepo = repo as jest.Mocked<typeof repo>;
const mockProvision = provisioning as jest.Mocked<typeof provisioning>;
const mockConnections = connections as jest.Mocked<typeof connections>;

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const MIGRATION_ID = '33333333-3333-4333-8333-333333333333';

const DISTILL_INPUT: StoredDistillInput = {
  role: 'Research',
  responsibilities: 'Research competitors.',
  attachments: [],
  integrationRefs: [],
  mcpServerRefs: [],
  routineRefs: [],
};

/** The smallest bundle acceptBundle will take. Contents do not matter here;
 *  what is under test is WHEN a replacement is allowed. */
const BUNDLE = {
  bundleVersion: 1,
  source: 'openclaw',
  adapterVersion: '1.0.0',
  installationFingerprint: 'fp',
  agents: [],
  teamRelationships: [],
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
} as never;

function migration(overrides: Partial<SourceMigration> = {}): SourceMigration {
  return {
    id: MIGRATION_ID,
    tenantId: TENANT,
    source: 'openclaw',
    sourceVersion: '2026.8.1',
    adapterVersion: '1.0.0',
    installationFingerprint: 'fp',
    state: 'converting',
    bundle: null,
    unsupportedItems: [],
    hostingRequirements: [],
    diagnostics: [],
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    convertedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function item(overrides: Partial<SourceMigrationItem> = {}): SourceMigrationItem {
  return {
    id: 'item-1',
    migrationId: MIGRATION_ID,
    tenantId: TENANT,
    sourceRef: 'agent:research',
    normalizedInputHash: 'hash-1',
    distillInput: DISTILL_INPUT,
    state: 'pending',
    attemptCount: 0,
    lastError: null,
    distillOutput: null,
    destinationAgentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    convertedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: the live service agrees with the stored copy. Tests that care
  // about the two DISAGREEING override this.
  mockConnections.resolveConnectionStatuses.mockImplementation(
    async (_t: unknown, _a: unknown, connections: unknown) => connections as never,
  );
  mockConnections.resolveAgentBindings.mockResolvedValue({
    integrations: [],
    pendingIntegrations: [],
  });
  mockRepo.listRoutines.mockResolvedValue([]);
  mockProvision.provisionAgentFromDistill.mockResolvedValue({
    agent: { id: 'agent-1' } as never,
    distillOutput: { summary: 's' } as never,
    reusedDistill: false,
  });
  jest.spyOn(admission, 'reserveDistillSlot').mockResolvedValue({ allowed: true });
});

describe('rule 1: an item that already has a destination agent', () => {
  it('does no distill and no create', async () => {
    await sourceMigrationService.convertItem(
      TENANT,
      ACCOUNT,
      migration(),
      item({ destinationAgentId: 'agent-existing', state: 'converted' }),
    );

    expect(mockProvision.provisionAgentFromDistill).not.toHaveBeenCalled();
    expect(admission.reserveDistillSlot).not.toHaveBeenCalled();
    expect(mockRepo.setItemState).not.toHaveBeenCalled();
  });
});

describe('rule 2: an item whose distill succeeded but whose create did not', () => {
  it('creates from the stored output and never redistills', async () => {
    await sourceMigrationService.convertItem(
      TENANT,
      ACCOUNT,
      migration(),
      item({ distillOutput: { summary: 'stored' }, state: 'creating', attemptCount: 1 }),
    );

    expect(mockProvision.provisionAgentFromDistill).toHaveBeenCalledTimes(1);
    const call = mockProvision.provisionAgentFromDistill.mock.calls[0][0];
    // The stored output is replayed rather than regenerated.
    expect(call.existingDistillOutput).toEqual({ summary: 'stored' });
    // A replay consumes no rate-limit slot: the expensive work already happened.
    expect(admission.reserveDistillSlot).not.toHaveBeenCalled();
  });

  it('does not increment the attempt count on a replay', async () => {
    await sourceMigrationService.convertItem(
      TENANT,
      ACCOUNT,
      migration(),
      item({ distillOutput: { summary: 'stored' }, attemptCount: 1 }),
    );
    expect(mockRepo.setItemState).toHaveBeenCalledWith(
      TENANT,
      'item-1',
      'creating',
      expect.objectContaining({ incrementAttempt: false }),
    );
  });
});

describe('rule 3: a fresh item', () => {
  it('reserves a distill slot before doing any LLM work', async () => {
    await sourceMigrationService.convertItem(TENANT, ACCOUNT, migration(), item());

    expect(admission.reserveDistillSlot).toHaveBeenCalledWith({
      tenantId: TENANT,
      accountId: ACCOUNT,
    });
    expect(mockProvision.provisionAgentFromDistill).toHaveBeenCalledTimes(1);
    expect(mockProvision.provisionAgentFromDistill.mock.calls[0][0].existingDistillOutput).toBeUndefined();
  });

  it('does not distill when no rate-limit slot is available', async () => {
    jest.spyOn(admission, 'reserveDistillSlot').mockResolvedValue({
      allowed: false,
      code: 'rate_limited',
      detail: 'busy',
    });

    await sourceMigrationService.convertItem(TENANT, ACCOUNT, migration(), item());

    expect(mockProvision.provisionAgentFromDistill).not.toHaveBeenCalled();
    // Left pending so a later pass picks it up, not failed.
    expect(mockRepo.setItemState).toHaveBeenCalledWith(
      TENANT,
      'item-1',
      'pending',
      expect.objectContaining({ lastError: 'busy' }),
    );
  });

  it('stops distilling once the attempt cap is reached', async () => {
    await sourceMigrationService.convertItem(
      TENANT,
      ACCOUNT,
      migration(),
      item({ attemptCount: admission.MAX_ITEM_ATTEMPTS }),
    );

    expect(mockProvision.provisionAgentFromDistill).not.toHaveBeenCalled();
    expect(mockRepo.setItemState).toHaveBeenCalledWith(
      TENANT,
      'item-1',
      'failed',
      expect.objectContaining({ lastError: expect.stringContaining('failed to build') }),
    );
  });
});

describe('a bundle may be replaced only before the build', () => {
  // Re-uploading is how someone picks up a change they made to their
  // installation after seeing the review screen: the fingerprint is
  // path-derived, so it cannot see content change and a first scan would
  // otherwise be permanent.
  it.each<['importing' | 'setup_required' | 'payment_required' | 'failed']>([
    ['importing'],
    ['setup_required'],
    ['payment_required'],
    ['failed'],
  ])('accepts a replacement while the migration is %s', async (state) => {
    mockRepo.getById.mockResolvedValue(migration({ bundle: {} as never, state }));
    mockRepo.upsertItem.mockResolvedValue(item());
    mockRepo.saveBundle.mockResolvedValue(migration({ state }));
    mockConnections.materializeCatalogPlaceholders.mockResolvedValue({ unsupported: [] } as never);
    mockConnections.resolveHostingRequirements.mockResolvedValue(
      { catalog: [], mcp: [], remaining: [], diagnostics: [] } as never,
    );
    mockConnections.materializeMcpPlaceholders.mockResolvedValue(undefined as never);

    await expect(
      sourceMigrationService.acceptBundle(TENANT, ACCOUNT, MIGRATION_ID, BUNDLE),
    ).resolves.toBeDefined();
  });

  it('refuses a replacement once conversion has started', async () => {
    // saveBundle re-derives the migration state, so accepting one mid-build
    // would rewind a conversion the tenant is already paying for.
    mockRepo.getById.mockResolvedValue(migration({ bundle: {} as never, state: 'converting' }));

    await expect(
      sourceMigrationService.acceptBundle(TENANT, ACCOUNT, MIGRATION_ID, BUNDLE),
    ).rejects.toMatchObject({ statusCode: 409, code: 'bundle_locked_by_conversion' });
  });

  it('still accepts the FIRST bundle whatever the state', async () => {
    // No bundle yet means nothing to protect, and refusing here would strand a
    // migration whose row was created before its scan finished.
    mockRepo.getById.mockResolvedValue(migration({ bundle: null, state: 'converting' }));
    mockRepo.upsertItem.mockResolvedValue(item());
    mockRepo.saveBundle.mockResolvedValue(migration());
    mockConnections.materializeCatalogPlaceholders.mockResolvedValue({ unsupported: [] } as never);
    mockConnections.resolveHostingRequirements.mockResolvedValue(
      { catalog: [], mcp: [], remaining: [], diagnostics: [] } as never,
    );
    mockConnections.materializeMcpPlaceholders.mockResolvedValue(undefined as never);

    await expect(
      sourceMigrationService.acceptBundle(TENANT, ACCOUNT, MIGRATION_ID, BUNDLE),
    ).resolves.toBeDefined();
  });
});

describe('a targeted retry rebuilds only what was asked for', () => {
  it('skips outstanding items that were not named', async () => {
    mockRepo.getById.mockResolvedValue(migration({ bundle: {} as never }));
    mockRepo.listConnections.mockResolvedValue([{ status: 'active' } as never]);
    mockRepo.listItems.mockResolvedValue([
      item({ id: 'item-failed', sourceRef: 'agent:one', state: 'failed' }),
      item({ id: 'item-other', sourceRef: 'agent:two', state: 'failed' }),
    ]);

    await sourceMigrationService.convert(
      TENANT,
      ACCOUNT,
      MIGRATION_ID,
      { paid: true },
      undefined,
      ['agent:one'],
    );

    // One retry, one build. Sweeping the other failure in would spend a model
    // call nobody asked for.
    expect(mockProvision.provisionAgentFromDistill).toHaveBeenCalledTimes(1);
    expect(mockProvision.provisionAgentFromDistill.mock.calls[0][0].idempotencyKey).toContain(
      'agent:one',
    );
  });

  it('does not rewind a finished migration back to converting', async () => {
    // The migration is finished; ONE row is being rebuilt. Reporting the whole
    // import as building again throws every viewer back to the progress screen
    // for work that concerns a single member.
    mockRepo.getById.mockResolvedValue(
      migration({ bundle: {} as never, state: 'ready_to_cutover' }),
    );
    mockRepo.listConnections.mockResolvedValue([{ status: 'active' } as never]);
    mockRepo.listItems.mockResolvedValue([
      item({ id: 'ok', sourceRef: 'agent:one', state: 'converted' }),
      item({ id: 'bad', sourceRef: 'agent:two', state: 'failed' }),
    ]);

    await sourceMigrationService.convert(TENANT, ACCOUNT, MIGRATION_ID, { paid: true }, undefined, [
      'agent:two',
    ]);

    const states = mockRepo.setState.mock.calls.map((c) => c[2]);
    expect(states).not.toContain('converting');
    expect(states).not.toContain('conversion_queued');
  });

  it('still announces converting for a full run', async () => {
    mockRepo.getById.mockResolvedValue(migration({ bundle: {} as never }));
    mockRepo.listConnections.mockResolvedValue([{ status: 'active' } as never]);
    mockRepo.listItems.mockResolvedValue([item({ id: 'a', sourceRef: 'agent:one' })]);

    await sourceMigrationService.convert(TENANT, ACCOUNT, MIGRATION_ID, { paid: true });
    expect(mockRepo.setState.mock.calls.map((c) => c[2])).toContain('converting');
  });

  it('still runs everything outstanding when nothing is named', async () => {
    mockRepo.getById.mockResolvedValue(migration({ bundle: {} as never }));
    mockRepo.listConnections.mockResolvedValue([{ status: 'active' } as never]);
    mockRepo.listItems.mockResolvedValue([
      item({ id: 'a', sourceRef: 'agent:one' }),
      item({ id: 'b', sourceRef: 'agent:two' }),
    ]);

    await sourceMigrationService.convert(TENANT, ACCOUNT, MIGRATION_ID, { paid: true });
    expect(mockProvision.provisionAgentFromDistill).toHaveBeenCalledTimes(2);
  });
});

describe('re-importing drops connections the source no longer has', () => {
  // Re-importing replaces the bundle. A connection removed from the
  // installation would otherwise stay as Needs Reconnect that nothing can
  // satisfy and nothing can clear, so the build could never start again.
  beforeEach(() => {
    mockRepo.getById.mockResolvedValue(migration({ bundle: {} as never, state: 'payment_required' }));
    mockRepo.upsertItem.mockResolvedValue(item());
    mockRepo.saveBundle.mockResolvedValue(migration());
    mockConnections.materializeCatalogPlaceholders.mockResolvedValue({ unsupported: [] } as never);
    mockConnections.resolveHostingRequirements.mockResolvedValue(
      { catalog: [], mcp: [], remaining: [], diagnostics: [] } as never,
    );
    mockConnections.materializeMcpPlaceholders.mockResolvedValue(undefined as never);
    mockRepo.pruneConnectionsNotIn.mockResolvedValue(0);
  });

  it('keeps only what the new bundle still references', async () => {
    await sourceMigrationService.acceptBundle(TENANT, ACCOUNT, MIGRATION_ID, {
      ...(BUNDLE as object),
      catalogConnectorRequirements: [{ sourceRef: 'channel:slack', connectorType: 'slack' }],
      customMcpServerRequirements: [{ sourceRef: 'mcp:reporting', name: 'reporting' }],
    } as never);

    expect(mockRepo.pruneConnectionsNotIn).toHaveBeenCalledWith(TENANT, MIGRATION_ID, [
      'channel:slack',
      'mcp:reporting',
    ]);
  });

  it('drops every connection when the source now has none', async () => {
    await sourceMigrationService.acceptBundle(TENANT, ACCOUNT, MIGRATION_ID, BUNDLE);
    expect(mockRepo.pruneConnectionsNotIn).toHaveBeenCalledWith(TENANT, MIGRATION_ID, []);
  });
});

describe('connection status is read live, not from the local copy', () => {
  // `source_migration_connections.status` is written 'needs_reconnect' when the
  // placeholder is created and nothing ever updated it. The connector lives in
  // connector-service's database, so the reconnect flips the status THERE and
  // this copy stayed stale forever — the review screen kept showing Needs
  // Reconnect for a connector just reconnected, and this gate refused to build
  // for the same reason. Continue could never succeed for anyone.
  it('builds once connector-service reports the connector active', async () => {
    mockRepo.getById.mockResolvedValue(migration({ bundle: {} as never }));
    mockRepo.listItems.mockResolvedValue([item({ sourceRef: 'agent:one' })]);
    // The stored copy still says needs_reconnect. The live service disagrees.
    mockRepo.listConnections.mockResolvedValue([
      { connectorId: 'c-1', status: 'needs_reconnect' } as never,
    ]);
    mockConnections.resolveConnectionStatuses.mockResolvedValue([
      { connectorId: 'c-1', status: 'active' } as never,
    ]);

    await expect(
      sourceMigrationService.convert(TENANT, ACCOUNT, MIGRATION_ID, { paid: true }),
    ).resolves.toBeDefined();
    expect(mockProvision.provisionAgentFromDistill).toHaveBeenCalled();
  });

  it('refuses when the connector is merely pending', async () => {
    // Someone opened the connect flow and did not finish it. Building here
    // would bind a team member to credentials that do not exist.
    mockRepo.getById.mockResolvedValue(migration({ bundle: {} as never }));
    mockRepo.listItems.mockResolvedValue([item({ sourceRef: 'agent:one' })]);
    mockRepo.listConnections.mockResolvedValue([
      { connectorId: 'c-1', status: 'needs_reconnect' } as never,
    ]);
    mockConnections.resolveConnectionStatuses.mockResolvedValue([
      { connectorId: 'c-1', status: 'needs_reconnect' } as never,
    ]);

    await expect(
      sourceMigrationService.convert(TENANT, ACCOUNT, MIGRATION_ID, { paid: true }),
    ).rejects.toMatchObject({ code: 'connections_not_reconnected' });
  });

  it('refuses to build when connector-service cannot be reached', async () => {
    // Fails CLOSED. The view may fall back to the stored copy because a screen
    // that says "needs reconnect" too often is harmless; a gate that assumed
    // "reconnected" would build every member against tools it cannot reach.
    mockRepo.getById.mockResolvedValue(migration({ bundle: {} as never }));
    mockRepo.listItems.mockResolvedValue([item({ sourceRef: 'agent:one' })]);
    mockRepo.listConnections.mockResolvedValue([
      { connectorId: 'c-1', status: 'needs_reconnect' } as never,
    ]);
    mockConnections.resolveConnectionStatuses.mockRejectedValue(new Error('service down'));

    await expect(
      sourceMigrationService.convert(TENANT, ACCOUNT, MIGRATION_ID, { paid: true }),
    ).rejects.toThrow();
    expect(mockProvision.provisionAgentFromDistill).not.toHaveBeenCalled();
  });
});

describe('conversion refuses to build against unreconnected connections', () => {
  it('rejects when an imported connection is still awaiting reconnection', async () => {
    mockRepo.getById.mockResolvedValue(migration({ bundle: {} as never }));
    mockRepo.listItems.mockResolvedValue([item()]);
    mockRepo.listConnections.mockResolvedValue([
      { status: 'needs_reconnect' } as never,
    ]);

    await expect(
      sourceMigrationService.convert(TENANT, ACCOUNT, MIGRATION_ID, { paid: true }),
    ).rejects.toThrow(/still need reconnecting/);

    // Nothing billable ran: the guard sits before admission and before any
    // distill, so a blocked build costs nothing.
    expect(mockProvision.provisionAgentFromDistill).not.toHaveBeenCalled();
  });

  it('proceeds once every connection is active', async () => {
    mockRepo.getById.mockResolvedValue(migration({ bundle: {} as never }));
    mockRepo.listItems.mockResolvedValue([]);
    mockRepo.listConnections.mockResolvedValue([{ status: 'active' } as never]);

    await expect(
      sourceMigrationService.convert(TENANT, ACCOUNT, MIGRATION_ID, { paid: true }),
    ).resolves.toBeDefined();
  });
});

describe('the imported schedule', () => {
  it('overrides whatever the distiller inferred', async () => {
    await sourceMigrationService.convertItem(
      TENANT,
      ACCOUNT,
      migration(),
      item({ distillInput: { ...DISTILL_INPUT, cronExpr: '0 9 * * 1' } }),
    );
    const call = mockProvision.provisionAgentFromDistill.mock.calls[0][0];
    // The source said Mondays at 09:00. Letting the LLM re-derive that from
    // prose is how a weekly brief quietly becomes a daily one.
    expect(call.triggerOverride).toEqual({ type: 'cron', cronExpr: '0 9 * * 1' });
  });

  it('leaves the distiller in charge when the source had no schedule', async () => {
    await sourceMigrationService.convertItem(TENANT, ACCOUNT, migration(), item());
    expect(mockProvision.provisionAgentFromDistill.mock.calls[0][0].triggerOverride).toBeUndefined();
  });
});

describe('the create call itself', () => {
  it('uses a deterministic idempotency key derived from migration and source ref', async () => {
    await sourceMigrationService.convertItem(TENANT, ACCOUNT, migration(), item());
    const call = mockProvision.provisionAgentFromDistill.mock.calls[0][0];
    expect(call.idempotencyKey).toBe(`switch:${MIGRATION_ID}:agent:agent:research`);
  });

  it('creates the imported team member as a draft', async () => {
    await sourceMigrationService.convertItem(TENANT, ACCOUNT, migration(), item());
    expect(mockProvision.provisionAgentFromDistill.mock.calls[0][0].status).toBe('draft');
  });

  it('persists the distill output before the agent row is created', async () => {
    const order: string[] = [];
    mockRepo.saveDistillOutput.mockImplementation(async () => {
      order.push('saveDistillOutput');
    });
    mockProvision.provisionAgentFromDistill.mockImplementation(async (params) => {
      // The helper calls this hook after distilling and before creating.
      await params.onDistillComplete?.({ summary: 'fresh' } as never);
      order.push('create');
      return { agent: { id: 'agent-1' } as never, distillOutput: { summary: 'fresh' } as never, reusedDistill: false };
    });

    await sourceMigrationService.convertItem(TENANT, ACCOUNT, migration(), item());

    expect(order).toEqual(['saveDistillOutput', 'create']);
  });

  it('records the source-to-agent mapping after a successful create', async () => {
    await sourceMigrationService.convertItem(TENANT, ACCOUNT, migration(), item());
    expect(mockRepo.saveDestinationAgent).toHaveBeenCalledWith(TENANT, 'item-1', 'agent-1');
  });

  it('marks the item failed and does not throw when provisioning fails', async () => {
    mockProvision.provisionAgentFromDistill.mockRejectedValue(new Error('distiller unavailable'));

    await expect(
      sourceMigrationService.convertItem(TENANT, ACCOUNT, migration(), item()),
    ).resolves.toBeUndefined();

    expect(mockRepo.setItemState).toHaveBeenLastCalledWith(
      TENANT,
      'item-1',
      'failed',
      expect.objectContaining({ lastError: 'distiller unavailable' }),
    );
  });
});
