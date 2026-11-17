/**
 * WHICH costs are a supplier's own charge, enumerated.
 *
 * The premium turns on one boundary: a `connector_call` and a `web_tool` are
 * bought from someone else and resold, everything else is the platform's own
 * work. Getting the line wrong is silent in both directions -- a platform cost
 * misfiled as pass-through is sold at a tenth of its markup forever, and a
 * supplier charge misfiled as platform is sold at several times what the same
 * data costs elsewhere.
 *
 * This enumerates the whole `EventType` union, so a new event type cannot land
 * without someone deciding which side of the line it is on. In particular it
 * pins that model tokens are NOT pass-through: a vendor's own search surcharge
 * books as `web_tool` and carries the premium, while its inference books as
 * `llm_invocation` and is priced exactly as it always was.
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

jest.mock('../reload-drain', () => ({ applyReloadDrain: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../event-classification', () => ({
  classifyChargeability: jest.fn().mockReturnValue('customer'),
  VOICE_DICTATION_PURPOSE: 'voice_dictation',
}));

import { ingestEventWithBuckets } from '../repository';
import type { CostAttributionEvent, EventType } from '../types';

/** Every member of the union, with the side of the line it belongs on. A new
 *  event type fails to compile here until it is classified. */
const EVERY_EVENT_TYPE: Record<EventType, 'pass_through' | 'platform'> = {
  // Bought from a supplier and resold unchanged.
  connector_call:      'pass_through',   // a data capability: Locus, Vaaya, an x402 vendor, an Apify run
  web_tool:            'pass_through',   // Perplexity, Exa, Steel, Browser Use, a model vendor's search surcharge
  // The platform's own work.
  llm_invocation:      'platform',       // model tokens, including xAI's
  embedding:           'platform',
  developer_proxy_llm: 'platform',
  sandbox:             'platform',
  infra_compute:       'platform',
  cloud_scheduler:     'platform',
  kms_operation:       'platform',
  cloud_tasks:         'platform',
  cloud_storage_op:    'platform',
  cloud_build:         'platform',
  voice_stt:           'platform',
  voice_tts:           'platform',
  credit:              'platform',
};

const CHARGE_CLASS_ARG = 3;

function baseEvent(eventType: EventType): Omit<
  CostAttributionEvent, 'sourceId' | 'costUsd' | 'ouConsumed' | 'customerCostUsd' | 'costBucket'
> {
  return {
    tenantId: 'tenant-1',
    agentId: 'agent-1',
    eventType,
    source: 'tenant_runtime',
    occurredAt: new Date('2026-09-22T00:00:00Z'),
    // A web tool only reaches the charge at all when the PLATFORM funded it;
    // a workspace on its own vendor key already paid the vendor and bypasses.
    ...(eventType === 'web_tool' ? { connector: 'browser_use', webToolFunding: 'platform' as const } : {}),
  };
}

describe('every event type is on one side of the line', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClientQuery.mockResolvedValue({ rowCount: 1, rows: [] });
    mockApplyOuConsumption.mockResolvedValue([]);
  });

  for (const [eventType, expected] of Object.entries(EVERY_EVENT_TYPE) as Array<[EventType, string]>) {
    it(`prices ${eventType} as ${expected}`, async () => {
      await ingestEventWithBuckets('account-1', `evt-${eventType}`, 0.05, baseEvent(eventType));

      expect(mockApplyOuConsumption).toHaveBeenCalled();
      const options = mockApplyOuConsumption.mock.calls[0][CHARGE_CLASS_ARG] as { chargeClass?: string };
      expect(options?.chargeClass).toBe(expected);
    });
  }
});
