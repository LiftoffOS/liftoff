// Finishing an import that ran out of hourly distillation allowance.
//
// Conversion always handled running out — the item is left `pending` with the
// reason. What it did not have was anything that came back, so a large import
// converted part of a team and then looked finished. There used to be a cap of
// 25 members hiding that; the cap is gone, and this is what replaced it.

import { sourceMigrationService } from '../service';
import { sourceMigrationRepository as repo } from '../repository';
import * as admission from '../admission';
import type { SourceMigration, SourceMigrationItem } from '../types';

jest.mock('../repository');
jest.mock('../connections');
jest.mock('../../internal-agents/provisioning-helper');
// readEntitlementSnapshot lives in the module under test and is called
// directly, so it cannot be spied on through the export. Its one query is
// stubbed instead; the admission decision itself is mocked below, so the row
// it would return does not matter — only that the read does not reach a
// database.
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(async (_tenantId: string, fn: (client: unknown) => unknown) =>
    fn({ query: async () => ({ rows: [] }) }),
  ),
}));
jest.mock('../../internal-agents/service', () => ({
  InternalAgentService: jest.fn().mockImplementation(() => ({
    updateStatus: jest.fn().mockResolvedValue({ id: 'agent-1' }),
  })),
}));

const mockRepo = repo as jest.Mocked<typeof repo>;

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const MIGRATION = '33333333-3333-4333-8333-333333333333';

function migration(overrides: Partial<SourceMigration> = {}): SourceMigration {
  return {
    id: MIGRATION,
    tenantId: TENANT,
    state: 'converting',
    bundle: { skills: [] },
    libraryApprovals: [],
    ...overrides,
  } as unknown as SourceMigration;
}

function item(state: SourceMigrationItem['state'], id = 'item-1'): SourceMigrationItem {
  return { id, sourceRef: `agent:${id}`, state } as unknown as SourceMigrationItem;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(admission, 'checkConversionAdmission').mockReturnValue({ allowed: true } as never);
  jest.spyOn(sourceMigrationService, 'convertItem').mockResolvedValue(undefined as never);
});

describe('resumePendingItems', () => {
  it('converts the items a rate-limited run left pending', async () => {
    mockRepo.getById.mockResolvedValue(migration());
    mockRepo.listItems
      .mockResolvedValueOnce([item('pending', 'a'), item('converted', 'b')])
      .mockResolvedValueOnce([item('converted', 'a'), item('converted', 'b')]);
    mockRepo.setState.mockResolvedValue(migration({ state: 'ready_to_cutover' }));

    await sourceMigrationService.resumePendingItems(TENANT, ACCOUNT, MIGRATION);

    expect(sourceMigrationService.convertItem).toHaveBeenCalledTimes(1);
    expect(sourceMigrationService.convertItem).toHaveBeenCalledWith(
      TENANT,
      ACCOUNT,
      expect.objectContaining({ id: MIGRATION }),
      expect.objectContaining({ id: 'a' }),
    );
  });

  it('leaves the migration converting while anything is still pending', async () => {
    // A wave that could not finish is not a failure. The next sweep takes it.
    mockRepo.getById.mockResolvedValue(migration());
    mockRepo.listItems
      .mockResolvedValueOnce([item('pending', 'a')])
      .mockResolvedValueOnce([item('pending', 'a')]);

    await sourceMigrationService.resumePendingItems(TENANT, ACCOUNT, MIGRATION);

    expect(mockRepo.setState).not.toHaveBeenCalled();
  });

  it('finishes the migration once every item has settled', async () => {
    mockRepo.getById.mockResolvedValue(migration());
    mockRepo.listItems
      .mockResolvedValueOnce([item('pending', 'a')])
      .mockResolvedValueOnce([item('converted', 'a')]);
    mockRepo.setState.mockResolvedValue(migration({ state: 'ready_to_cutover' }));

    await sourceMigrationService.resumePendingItems(TENANT, ACCOUNT, MIGRATION);

    expect(mockRepo.setState).toHaveBeenCalledWith(
      TENANT,
      MIGRATION,
      'ready_to_cutover',
      { convertedAt: true },
    );
  });

  it('re-checks the billing authority between waves', async () => {
    // Spend is decided by billing_controls and the OU buckets and by nothing
    // else. A subscription can lapse between one wave and the next.
    jest
      .spyOn(admission, 'checkConversionAdmission')
      .mockReturnValue({ allowed: false, code: 'not_paid', detail: 'no' } as never);
    mockRepo.getById.mockResolvedValue(migration());
    mockRepo.listItems.mockResolvedValue([item('pending', 'a')]);
    mockRepo.setState.mockResolvedValue(migration({ state: 'payment_required' }));

    await sourceMigrationService.resumePendingItems(TENANT, ACCOUNT, MIGRATION);

    expect(sourceMigrationService.convertItem).not.toHaveBeenCalled();
    expect(mockRepo.setState).toHaveBeenCalledWith(
      TENANT,
      MIGRATION,
      'payment_required',
      expect.objectContaining({ lastError: 'no' }),
    );
  });

  it('does nothing for a migration that is not converting', async () => {
    // Resuming a finished or cut-over import would rebuild members somebody
    // already has.
    mockRepo.getById.mockResolvedValue(migration({ state: 'active' }));

    await sourceMigrationService.resumePendingItems(TENANT, ACCOUNT, MIGRATION);

    expect(sourceMigrationService.convertItem).not.toHaveBeenCalled();
  });

  it('does nothing when there is nothing pending', async () => {
    mockRepo.getById.mockResolvedValue(migration());
    mockRepo.listItems.mockResolvedValue([item('converted', 'a')]);

    await sourceMigrationService.resumePendingItems(TENANT, ACCOUNT, MIGRATION);

    expect(sourceMigrationService.convertItem).not.toHaveBeenCalled();
    expect(mockRepo.setState).not.toHaveBeenCalled();
  });
});
