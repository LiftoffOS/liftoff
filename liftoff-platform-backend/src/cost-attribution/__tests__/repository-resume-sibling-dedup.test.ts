/**
 * A run that paused is already billed by its continuation.
 *
 * `completeInvocation` is called only by the two fresh finalizers and the
 * resumed one — never by a pause. So a run that pauses for a person never
 * completes and never publishes under its own invocation id: the paused half's
 * spend is carried into the continuation's steps and billed by the
 * continuation's event, under `<id>:resume:<pauseId>`. That event covers the
 * WHOLE run, and the invocation row ends up holding those same tokens.
 *
 * runtime-ingester then sweeps the invocation feed as a backstop for
 * invocations that published nothing, finds that row, and prices it. Unless the
 * cross-ledger dedup recognises the `:resume:` sibling as the same invocation,
 * the sweep bills the full run a SECOND time on top of a correct event — and
 * afterwards the two rows look like any other pair.
 *
 * A paused run is then billed at close to twice its true cost.
 *
 * The `/` sibling is a different thing entirely (the bucket split of ONE event)
 * and the runtime uses `:` for the continuation precisely so a late redelivery
 * of one half cannot read as a duplicate of the other. Matching `/` alone can
 * therefore never be enough.
 */

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockClientQuery = jest.fn();
const mockClient = { query: mockClientQuery, release: jest.fn() };
jest.mock('../../infrastructure/database', () => ({
  withAdminScope: jest.fn(async (_opts: unknown, fn: (c: unknown) => Promise<unknown>) => fn(mockClient)),
  withTenantScope: jest.fn(),
  getPool: jest.fn(),
}));

const mockApplyOuConsumption = jest.fn();
jest.mock('../ou-bucket-service', () => ({
  applyOuConsumption: (...a: unknown[]) => mockApplyOuConsumption(...a),
  applyOuRefund: jest.fn(),
  getOuDefinitionRateUsd: jest.fn().mockResolvedValue(0.01),
}));

jest.mock('../reload-drain', () => ({
  applyReloadDrain: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../event-classification', () => ({
  classifyChargeability: jest.fn().mockReturnValue('customer'),
  VOICE_DICTATION_PURPOSE: 'voice_dictation',
}));

import { ingestEventWithBuckets } from '../repository';
import type { CostAttributionEvent } from '../types';

type Template = Omit<
  CostAttributionEvent,
  'sourceId' | 'costUsd' | 'ouConsumed' | 'customerCostUsd' | 'costBucket'
>;

const INVOCATION = '40b5cbf8-2788-4027-ab7b-8cad9e1f440b';

const template = (): Template => ({
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  eventType: 'llm_invocation',
  source: 'tenant_runtime',
  provider: 'glm',
  model: 'z-ai/glm-5.2',
  invocationId: INVOCATION,
  occurredAt: new Date('2026-09-24T06:43:49Z'),
});

/** The predicate the dedup callback runs, as SQL text plus its bound id. */
function dedupProbe(): { sql: string; boundId: unknown } | null {
  const call = mockClientQuery.mock.calls.find((c) =>
    String(c[0]).includes('FROM cost_attribution_events') && String(c[0]).includes('LIMIT 1'),
  );
  if (!call) return null;
  return { sql: String(call[0]), boundId: (call[1] as unknown[])[2] };
}

describe('an invocation already billed by its :resume: continuation', () => {
  /** No sibling in the ledger; every other statement succeeds. */
  const ledgerWithoutSibling = async (sql: string) => {
    const text = String(sql);
    if (text.includes('FROM cost_attribution_events') && text.includes('LIMIT 1')) {
      return { rowCount: 0, rows: [] };
    }
    if (text.includes('INSERT INTO cost_attribution_events')) return { rowCount: 1, rows: [] };
    return { rowCount: 1, rows: [{ stripe_customer_id: null, billing_exempt: true }] };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockClientQuery.mockImplementation(ledgerWithoutSibling);
    // Run the dedup callback the way applyOuConsumption does, and report what
    // it answered so the test asserts the PREDICATE rather than a mock's shape.
    mockApplyOuConsumption.mockImplementation(async (_c, _a, _cost, opts) => {
      const dup = opts?.isDuplicate ? await opts.isDuplicate(mockClient) : false;
      return dup ? [] : [{ ouConsumed: 4.06, costUsd: 0.040616, customerCostUsd: 0.0812, costBucket: 'included', sourceIdSuffix: '' }];
    });
  });

  it('recognises the continuation, so the backstop books nothing', async () => {
    // The sweep asks under the bare invocation id; the ledger already holds the
    // continuation's row.
    mockClientQuery.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes('FROM cost_attribution_events') && text.includes('LIMIT 1')) {
        return { rowCount: 1, rows: [{ '?column?': 1 }] };
      }
      if (text.includes('INSERT INTO cost_attribution_events')) return { rowCount: 1, rows: [] };
      return { rowCount: 1, rows: [{ stripe_customer_id: null, billing_exempt: true }] };
    });

    const inserted = await ingestEventWithBuckets('account-1', INVOCATION, 0.040616, template());

    expect(inserted).toBe(0);
  });

  it('asks for the :resume: sibling by name, not only the bucket split', () => {
    // Pinned as text because the omission is invisible at runtime: without this
    // arm the query still runs, still returns no rows, and the duplicate is
    // written as a normal-looking charge.
    return ingestEventWithBuckets('account-1', INVOCATION, 0.040616, template()).then(() => {
      const probe = dedupProbe();
      expect(probe).not.toBeNull();
      expect(probe!.sql).toContain("'/%'");
      expect(probe!.boundId).toBe(INVOCATION);
      // Both ledgers, not just one: billing_spend_events is where a paused
      // run's only row lives, so an arm missing there is the whole defect.
      expect(probe!.sql).toContain('billing_spend_events');
      const resumeArms = probe!.sql.match(/:resume:%/g) ?? [];
      expect(resumeArms.length).toBe(2);
    });
  });

  it('still books an invocation that has no sibling at all', async () => {
    // The backstop's real job: an invocation that published nothing.
    const inserted = await ingestEventWithBuckets('account-1', INVOCATION, 0.040616, template());
    expect(inserted).toBeGreaterThan(0);
  });
});
