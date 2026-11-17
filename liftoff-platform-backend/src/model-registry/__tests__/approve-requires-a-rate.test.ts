// ModelRegistryService.approve — a model nobody can price cannot be approved.
//
// WHY THIS IS A GATE AND NOT A WARNING. Approval is not a label: the tier
// loaders resolve `findByTierAndProvider`, which takes the NEWEST approved row,
// so an approved model is immediately tier-resolvable and can be serving
// traffic seconds later. And an unpriced model does not fail loudly —
// `computeRowCost` falls back to the conservative default rather than billing
// $0, so it is charged at ANOTHER model's rate, on every row, indefinitely,
// while every dashboard looks healthy. The tenant runtime is worse again:
// `getModelPricing` returns null and the invocation books no cost at all.
//
// The CODE path was already fenced — pricing-coverage.test.ts gates every model
// reachable from a provider tier map or the vendor map, and its debt list is
// empty. This is the half that was not fenced: an operator adding a model
// through `POST /api/model-registry` and approving it touches no code and
// passes no ratchet.
//
// Both rate sources count, in computeRowCost's own resolution order (the
// shared `pricingKeysFor`): the static MODEL_PRICING table, and a synced
// `model_pricing` row. Migrations that insert `status='approved'` directly
// bypass this deliberately — they are covered by review and by the ratchet.

import { jest } from '@jest/globals';

const mockFindById = jest.fn();
const mockHasSyncedRate = jest.fn();
const mockUpdateStatus = jest.fn();

jest.mock('../repository', () => ({
  ModelRepository: jest.fn().mockImplementation(() => ({
    findById: (...args: unknown[]) => mockFindById(...args),
    hasSyncedRate: (...args: unknown[]) => mockHasSyncedRate(...args),
    updateStatus: (...args: unknown[]) => mockUpdateStatus(...args),
  })),
  ModelConfigRepository: jest.fn().mockImplementation(() => ({})),
  ModelRolloutRepository: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../events/publisher', () => ({ publishEvent: jest.fn(async () => undefined) }));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

import { ModelRegistryService } from '../service';

const service = new ModelRegistryService();

function model(provider: string, modelId: string): Record<string, unknown> {
  return { id: 'm1', name: 'Test', provider, modelId, tier: 'large', status: 'pending' };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockHasSyncedRate.mockResolvedValue(false as never);
  mockUpdateStatus.mockImplementation(async () => model('anthropic', 'claude-opus-5-5') as never);
});

describe('approve requires a published rate', () => {
  it('approves a model whose rate is in the static table', async () => {
    mockFindById.mockResolvedValue(model('anthropic', 'claude-opus-5-5') as never);

    await expect(service.approve('m1')).resolves.toBeDefined();
    expect(mockUpdateStatus).toHaveBeenCalledWith('m1', 'approved');
    // The static table answered, so the database was never asked.
    expect(mockHasSyncedRate).not.toHaveBeenCalled();
  });

  it('approves a model whose rate was written by the sync job', async () => {
    mockFindById.mockResolvedValue(model('glm', 'z-ai/glm-not-in-the-static-table') as never);
    mockHasSyncedRate.mockResolvedValue(true as never);

    await expect(service.approve('m1')).resolves.toBeDefined();
    expect(mockHasSyncedRate).toHaveBeenCalledWith('glm', 'z-ai/glm-not-in-the-static-table');
    expect(mockUpdateStatus).toHaveBeenCalledWith('m1', 'approved');
  });

  it('REFUSES a model with no rate in either source, and does not write the status', async () => {
    mockFindById.mockResolvedValue(model('anthropic', 'claude-not-released-yet') as never);

    await expect(service.approve('m1')).rejects.toThrow(/no published rate/);
    // The refusal has to be BEFORE the write, or the model is approved and
    // serving while the error propagates.
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  it('names both places a rate can live, so the error is actionable', async () => {
    mockFindById.mockResolvedValue(model('anthropic', 'claude-not-released-yet') as never);

    const err = await service.approve('m1').catch((e: Error) => e);
    expect(String(err)).toContain('anthropic/claude-not-released-yet');
    expect(String(err)).toContain('MODEL_PRICING');
    expect(String(err)).toContain('model_pricing');
  });

  it('refuses a model id that does not exist rather than approving nothing', async () => {
    mockFindById.mockResolvedValue(null as never);

    await expect(service.approve('nope')).rejects.toThrow(/not found/);
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });
});
