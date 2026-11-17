/* eslint-disable @typescript-eslint/no-var-requires */
import type { HarvestEvent, ClassificationResult } from '../types';

// ---------------------------------------------------------------------------
// Mock setup. Module mocks must be declared before importing the SUT so jest
// hoists them above the require() of '../runner'.
// ---------------------------------------------------------------------------

const mockQuery = jest.fn();
jest.mock('../infrastructure/database', () => ({
  getPool: jest.fn(() => ({ query: mockQuery })),
  closePool: jest.fn(),
}));

jest.mock('../infrastructure/logging', () => ({
  log: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../filter', () => ({
  shouldAttemptClassification: jest.fn(),
  extractText: jest.fn(),
}));

jest.mock('../classifier', () => ({
  classifyWithUsage: jest.fn(),
}));

jest.mock('../cost-log', () => ({
  logCostEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../memory-client', () => ({
  writeMemory: jest.fn().mockResolvedValue('memory-id-123'),
}));

jest.mock('../pricing', () => ({
  computeCostUsd: jest.fn().mockReturnValue(0.0001),
}));

jest.mock('../change-detection', () => ({
  computeContentHash: jest.fn().mockReturnValue('hash-abc'),
  lookupEntity: jest.fn().mockResolvedValue(null),
  upsertEntity: jest.fn().mockResolvedValue(undefined),
  needsTtlRefresh: jest.fn().mockReturnValue(false),
}));

jest.mock('../ttl', () => ({
  computeExpiresAt: jest.fn().mockReturnValue('2026-12-31T00:00:00.000Z'),
  MEMORY_TYPE_TTL_DAYS: { CONTEXT: 30, PREFERENCE: 90, CONVENTION: 180, GOTCHA: 365, ARCHITECTURAL_DECISION: 365 },
}));

// fetch is global in node 20.
const mockFetch = jest.fn();
(global as unknown as { fetch: jest.Mock }).fetch = mockFetch;

// Import after mocks are set up.
import { runHarvestPipeline } from '../runner';
import { LlmGatewayError } from '../llm-client';
import { shouldAttemptClassification, extractText } from '../filter';
import { classifyWithUsage } from '../classifier';
import { logCostEvent } from '../cost-log';
import { writeMemory } from '../memory-client';
import { computeContentHash, lookupEntity, upsertEntity, needsTtlRefresh } from '../change-detection';

const mockedShould = shouldAttemptClassification as jest.MockedFunction<typeof shouldAttemptClassification>;
const mockedExtract = extractText as jest.MockedFunction<typeof extractText>;
const mockedClassify = classifyWithUsage as jest.MockedFunction<typeof classifyWithUsage>;
const mockedCostLog = logCostEvent as jest.MockedFunction<typeof logCostEvent>;
const mockedWriteMemory = writeMemory as jest.MockedFunction<typeof writeMemory>;
void (computeContentHash as jest.MockedFunction<typeof computeContentHash>); // referenced via mock
const mockedLookup = lookupEntity as jest.MockedFunction<typeof lookupEntity>;
const mockedUpsert = upsertEntity as jest.MockedFunction<typeof upsertEntity>;
const mockedNeedsTtl = needsTtlRefresh as jest.MockedFunction<typeof needsTtlRefresh>;

function makeEvent(partial: Partial<HarvestEvent> = {}): HarvestEvent {
  return {
    tenantId: 'tenant-1',
    connectorId: 'conn-1',
    connectorType: 'slack',
    entityType: 'Message',
    entityId: 'entity-1',
    data: { body: 'a'.repeat(200) },
    messageId: 'msg-1',
    ...partial,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const WORTHY_RESULT: ClassificationResult = {
  worthy: true,
  memoryType: 'CONVENTION',
  confidence: 0.9,
  extractedContent: 'Use Postgres for primary store.',
  suggestedTags: ['db'],
  suggestedLayer: 'global',
};

beforeEach(() => {
  jest.clearAllMocks();
  // Default happy-path stubs; individual tests override.
  // Upfront-claim INSERT returns rowCount=1 (claim succeeded → proceed).
  mockQuery.mockResolvedValue({ rowCount: 1, rows: [{ message_id: 'msg-1' }] });
  mockedShould.mockReturnValue(true);
  mockedExtract.mockReturnValue('a'.repeat(200));
  mockedClassify.mockResolvedValue({
    classification: WORTHY_RESULT,
    model: 'claude-haiku-4-5',
    inputTokens: 100,
    outputTokens: 50,
    fullText: 'a'.repeat(200),
  });
  // Default fetch: tenant-features and connector-ownership both return 200/ok.
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/features/harvest')) return jsonResponse(200, { enabled: true });
    if (url.includes('/connectors/')) return jsonResponse(200, { tenantId: 'tenant-1' });
    return jsonResponse(200, {});
  });
  // Hard-reset change-detection mocks (mockReset clears all state including impl
  // queues so mockReturnValue/mockImplementation in individual tests take effect
  // on the first call without a phantom stale value from clearAllMocks).
  mockedNeedsTtl.mockReset();
  mockedNeedsTtl.mockReturnValue(false);
  mockedLookup.mockReset();
  mockedLookup.mockResolvedValue(null);
});

describe('runHarvestPipeline', () => {
  it('idempotency: returns early when upfront-claim INSERT returns rowCount=0 (concurrent delivery already claimed)', async () => {
    // rowCount=0 means ON CONFLICT DO NOTHING fired — another delivery owns this message_id.
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await runHarvestPipeline(makeEvent());
    expect(mockedClassify).not.toHaveBeenCalled();
    expect(mockedCostLog).not.toHaveBeenCalled();
    expect(mockedWriteMemory).not.toHaveBeenCalled();
  });

  it('TENANT-OPT-001: drops message (fail-closed) when tenant-features returns 404', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/features/harvest')) return jsonResponse(404, {});
      if (url.includes('/connectors/')) return jsonResponse(200, { tenantId: 'tenant-1' });
      return jsonResponse(200, {});
    });
    await runHarvestPipeline(makeEvent());
    expect(mockedClassify).not.toHaveBeenCalled();
    expect(mockedWriteMemory).not.toHaveBeenCalled();
  });

  it('TENANT-OPT-001: returns early when harvest is disabled for the tenant', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/features/harvest')) return jsonResponse(200, { enabled: false });
      return jsonResponse(200, {});
    });
    await runHarvestPipeline(makeEvent());
    expect(mockedClassify).not.toHaveBeenCalled();
    expect(mockedWriteMemory).not.toHaveBeenCalled();
  });

  it('SEC-001: drops message (fail-closed) when connector-ownership returns 404', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/features/harvest')) return jsonResponse(200, { enabled: true });
      if (url.includes('/connectors/')) return jsonResponse(404, {});
      return jsonResponse(200, {});
    });
    await runHarvestPipeline(makeEvent());
    expect(mockedClassify).not.toHaveBeenCalled();
    expect(mockedWriteMemory).not.toHaveBeenCalled();
  });

  it('SEC-001: returns early when connector-ownership reports a different tenant', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/features/harvest')) return jsonResponse(200, { enabled: true });
      if (url.includes('/connectors/')) return jsonResponse(200, { tenantId: 'other-tenant' });
      return jsonResponse(200, {});
    });
    await runHarvestPipeline(makeEvent());
    expect(mockedClassify).not.toHaveBeenCalled();
    expect(mockedWriteMemory).not.toHaveBeenCalled();
  });

  it('pre-filter: skips classify + memory write when filter returns false', async () => {
    mockedShould.mockReturnValue(false);
    await runHarvestPipeline(makeEvent());
    expect(mockedClassify).not.toHaveBeenCalled();
    expect(mockedWriteMemory).not.toHaveBeenCalled();
  });

  it('unworthy: cost-log is called but memory write is not', async () => {
    mockedClassify.mockResolvedValueOnce({
      classification: null,
      model: 'claude-haiku-4-5',
      inputTokens: 80,
      outputTokens: 10,
      fullText: 'a'.repeat(200),
    });
    await runHarvestPipeline(makeEvent());
    expect(mockedCostLog).toHaveBeenCalledTimes(1);
    expect(mockedWriteMemory).not.toHaveBeenCalled();
  });

  // BILLING-GATE: the platform-backend gateway refuses LLM for suspended /
  // not-execution-allowed tenants with a 4xx. That is terminal — ack & skip,
  // never nack (a nack just retry-storms to the DLQ). No cost log (no token
  // was spent: the gateway refused before calling the model).
  it('terminal 4xx (tenant suspended): acks and skips — no throw, no cost-log, no memory write', async () => {
    mockedClassify.mockRejectedValueOnce(new LlmGatewayError(403, '{"error":"tenant_execution_not_allowed"}'));
    await expect(runHarvestPipeline(makeEvent())).resolves.toBeUndefined();
    expect(mockedCostLog).not.toHaveBeenCalled();
    expect(mockedWriteMemory).not.toHaveBeenCalled();
  });

  it('retryable 5xx: rethrows so Pub/Sub nacks and redelivers', async () => {
    mockedClassify.mockRejectedValueOnce(new LlmGatewayError(503, 'upstream unavailable'));
    await expect(runHarvestPipeline(makeEvent())).rejects.toThrow('LLM gateway error 503');
    expect(mockedCostLog).not.toHaveBeenCalled();
    expect(mockedWriteMemory).not.toHaveBeenCalled();
  });

  it('non-gateway classifier error: rethrows (nack) as before', async () => {
    mockedClassify.mockRejectedValueOnce(new Error('boom'));
    await expect(runHarvestPipeline(makeEvent())).rejects.toThrow('boom');
    expect(mockedWriteMemory).not.toHaveBeenCalled();
  });

  it('worthy: both cost-log and writeMemory are called', async () => {
    await runHarvestPipeline(makeEvent());
    expect(mockedCostLog).toHaveBeenCalledTimes(1);
    expect(mockedWriteMemory).toHaveBeenCalledTimes(1);
    expect(mockedCostLog.mock.calls[0][0].messageId).toBe('msg-1');
  });

  it('classifier throws → pipeline throws (nack behavior)', async () => {
    mockedClassify.mockRejectedValueOnce(new Error('LLM gateway 500'));
    await expect(runHarvestPipeline(makeEvent())).rejects.toThrow('LLM gateway 500');
    expect(mockedWriteMemory).not.toHaveBeenCalled();
  });

  it('memory write throws → pipeline throws (nack behavior)', async () => {
    mockedWriteMemory.mockRejectedValueOnce(new Error('memory 503'));
    await expect(runHarvestPipeline(makeEvent())).rejects.toThrow('memory 503');
  });

  it('cost-log failure is swallowed (pipeline succeeds and memory is written)', async () => {
    // logCostEvent's own implementation swallows DB errors; here we model
    // a logCostEvent that resolves even though internally something failed.
    // The contract: logCostEvent never throws → memory write still happens.
    mockedCostLog.mockResolvedValueOnce(undefined);
    await runHarvestPipeline(makeEvent());
    expect(mockedWriteMemory).toHaveBeenCalledTimes(1);
  });

  it('worthy result with empty extractedContent: memory write is skipped (no throw)', async () => {
    mockedClassify.mockResolvedValueOnce({
      classification: { ...WORTHY_RESULT, extractedContent: '' },
      model: 'claude-haiku-4-5',
      inputTokens: 100,
      outputTokens: 50,
      fullText: 'a'.repeat(200),
    });
    await expect(runHarvestPipeline(makeEvent())).resolves.toBeUndefined();
    expect(mockedWriteMemory).not.toHaveBeenCalled();
    expect(mockedCostLog).toHaveBeenCalledTimes(1);
  });

  it('change-detection: classifies when prior record exists but content hash differs (changed content)', async () => {
    mockedLookup.mockResolvedValueOnce({
      contentHash: 'old-hash-different', // differs from mockedComputeHash return 'hash-abc'
      memoryId: 'mem-1',
      memoryType: 'CONVENTION',
      expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
    });
    mockedNeedsTtl.mockReturnValueOnce(false);
    await runHarvestPipeline(makeEvent());
    expect(mockedClassify).toHaveBeenCalledTimes(1);
    expect(mockedUpsert).toHaveBeenCalledTimes(1);
    expect(mockedUpsert.mock.calls[0][0].contentHash).toBe('hash-abc');
  });

  it('change-detection: skips classify when content unchanged and not approaching expiry', async () => {
    mockedLookup.mockResolvedValueOnce({
      contentHash: 'hash-abc', memoryId: 'mem-1', memoryType: 'CONVENTION', expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
    });
    mockedNeedsTtl.mockReturnValueOnce(false);
    await runHarvestPipeline(makeEvent());
    expect(mockedClassify).not.toHaveBeenCalled();
    expect(mockedWriteMemory).not.toHaveBeenCalled();
  });

  it('change-detection: re-classifies when content unchanged but TTL refresh needed', async () => {
    mockedLookup.mockResolvedValueOnce({
      contentHash: 'hash-abc', memoryId: 'mem-1', memoryType: 'CONVENTION', expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
    });
    mockedNeedsTtl.mockReturnValue(true); // beforeEach mockReset + mockReturnValue(false) runs next
    await runHarvestPipeline(makeEvent());
    expect(mockedClassify).toHaveBeenCalledTimes(1);
  });

  it('change-detection: always classifies when connectorId is null', async () => {
    await runHarvestPipeline(makeEvent({ connectorId: null }));
    expect(mockedClassify).toHaveBeenCalledTimes(1);
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('change-detection: upsertEntity called with memoryId after worthy write', async () => {
    await runHarvestPipeline(makeEvent());
    expect(mockedUpsert).toHaveBeenCalledTimes(1);
    expect(mockedUpsert.mock.calls[0][0].memoryId).toBe('memory-id-123');
  });

  it('change-detection: upsertEntity called with null memoryId for unworthy result', async () => {
    mockedClassify.mockResolvedValueOnce({
      classification: null, model: 'claude-haiku-4-5', inputTokens: 80, outputTokens: 10,
      fullText: 'a'.repeat(200),
    });
    await runHarvestPipeline(makeEvent());
    expect(mockedUpsert).toHaveBeenCalledTimes(1);
    expect(mockedUpsert.mock.calls[0][0].memoryId).toBeNull();
  });

  it('change-detection: upsertEntity failure is swallowed (pipeline completes)', async () => {
    mockedUpsert.mockRejectedValueOnce(new Error('db error'));
    await expect(runHarvestPipeline(makeEvent())).resolves.toBeUndefined();
    expect(mockedWriteMemory).toHaveBeenCalledTimes(1);
  });
});
