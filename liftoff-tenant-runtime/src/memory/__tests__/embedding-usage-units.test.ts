// usage_events.credits is the ACTION unit. The embedding usage hook wrote the
// raw input-token count into it, which put a third incompatible unit in a
// single column (alongside milli-USD sandbox alive-ticks and action counts) and
// made 87% of one tenant's recorded "burn" an artifact of tokenizer size —
// 7,167,647 "credits" from 289,267 embedding calls, up to 14,970 per call.
//
// One embedding call is one action. The token count is telemetry and belongs in
// metadata, where its unit is stated.

import { jest } from '@jest/globals';

type UsageHandler = (event: Record<string, unknown>) => Promise<void>;

const recordUsage = jest.fn<(e: Record<string, unknown>) => Promise<void>>().mockResolvedValue(undefined);
let registeredHandler: UsageHandler | undefined;

jest.mock('../../usage-ledger/service', () => ({
  usageLedgerService: { recordUsage },
}));

jest.mock('@liftoffos/embedding', () => ({
  embeddingClient: {
    init: jest.fn(),
    onUsage: (handler: UsageHandler) => { registeredHandler = handler; },
    embed: jest.fn(),
  },
  OpenAIEmbeddingProvider: class {},
  GoogleEmbeddingProvider: class {},
  VoyageEmbeddingProvider: class {},
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../infrastructure/database', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
  getPool: () => ({ query: jest.fn() }),
  getPoolForService: () => ({ query: jest.fn() }),
}));

// `_ensureEmbeddingClientInitialized` is the test seam onto the one-time init
// that registers the onUsage hook under test.
import { _ensureEmbeddingClientInitialized } from '../embedding';

const USAGE_EVENT = {
  provider: 'google',
  model: 'gemini-embedding-001',
  inputTokens: 14970,
  success: true,
  error: undefined,
  context: { tenantId: 'tenant-test-456', agentId: 'agent-test-789', purpose: 'memory_write' },
};

describe('embedding usage ledger row', () => {
  beforeEach(() => {
    recordUsage.mockClear();
    _ensureEmbeddingClientInitialized();
  });

  it('records ONE action credit, not the input-token count', async () => {
    await registeredHandler!(USAGE_EVENT);

    expect(recordUsage).toHaveBeenCalledTimes(1);
    const row = recordUsage.mock.calls[0][0] as Record<string, unknown>;
    expect(row.credits).toBe(1);
    expect(row.credits).not.toBe(14970);
  });

  it('keeps the token count in metadata, with its unit named', async () => {
    await registeredHandler!(USAGE_EVENT);

    const row = recordUsage.mock.calls[0][0] as Record<string, unknown>;
    const metadata = row.metadata as Record<string, unknown>;
    expect(metadata.inputTokens).toBe(14970);
    expect(metadata.unit).toBe('action_credit');
    expect(metadata.provider).toBe('google');
    expect(metadata.purpose).toBe('memory_write');
  });

  it('charges one credit regardless of how large the input was', async () => {
    await registeredHandler!({ ...USAGE_EVENT, inputTokens: 3 });
    await registeredHandler!({ ...USAGE_EVENT, inputTokens: 14970 });

    const credits = recordUsage.mock.calls.map(c => (c[0] as Record<string, unknown>).credits);
    expect(credits).toEqual([1, 1]);
  });

  it('still writes no row without a tenant scope', async () => {
    await registeredHandler!({ ...USAGE_EVENT, context: { purpose: 'memory_write' } });

    expect(recordUsage).not.toHaveBeenCalled();
  });
});
