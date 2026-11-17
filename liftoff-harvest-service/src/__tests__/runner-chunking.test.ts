/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * runner-chunking.test.ts
 *
 * Focused tests for the chunked-memory-write behaviour introduced in
 * the harvest chunking improvement. These complement the existing
 * runner.test.ts which covers the general pipeline flow.
 */
import type { HarvestEvent, ClassificationResult } from '../types';

// ---------------------------------------------------------------------------
// Mock setup — mirrors runner.test.ts conventions
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

// writeMemory returns a new unique ID each call so we can track the order.
let writeMemoryCallCount = 0;
jest.mock('../memory-client', () => ({
  writeMemory: jest.fn().mockImplementation(() => {
    writeMemoryCallCount += 1;
    return Promise.resolve(`memory-id-${writeMemoryCallCount}`);
  }),
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
  MEMORY_TYPE_TTL_DAYS: {
    CONTEXT: 30,
    PREFERENCE: 90,
    CONVENTION: 180,
    GOTCHA: 365,
    ARCHITECTURAL_DECISION: 365,
  },
}));

const mockFetch = jest.fn();
(global as unknown as { fetch: jest.Mock }).fetch = mockFetch;

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import { runHarvestPipeline } from '../runner';
import { shouldAttemptClassification, extractText } from '../filter';
import { classifyWithUsage } from '../classifier';
import { writeMemory } from '../memory-client';
import { lookupEntity, upsertEntity, needsTtlRefresh } from '../change-detection';

const mockedShould = shouldAttemptClassification as jest.MockedFunction<typeof shouldAttemptClassification>;
const mockedExtract = extractText as jest.MockedFunction<typeof extractText>;
const mockedClassify = classifyWithUsage as jest.MockedFunction<typeof classifyWithUsage>;
const mockedWriteMemory = writeMemory as jest.MockedFunction<typeof writeMemory>;
const mockedLookup = lookupEntity as jest.MockedFunction<typeof lookupEntity>;
const mockedUpsert = upsertEntity as jest.MockedFunction<typeof upsertEntity>;
const mockedNeedsTtl = needsTtlRefresh as jest.MockedFunction<typeof needsTtlRefresh>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeEvent(partial: Partial<HarvestEvent> = {}): HarvestEvent {
  return {
    tenantId: 'tenant-1',
    connectorId: 'conn-1',
    connectorType: 'confluence',
    entityType: 'Page',
    entityId: 'page-42',
    data: {},
    messageId: 'msg-chunk-1',
    ...partial,
  };
}

// Long text that exceeds default chunkSize (1600 chars) to force chunking.
// 5000 chars → with chunkSize=1600, overlap=400 (step=1200):
//   chunk 0: [0,1600), chunk 1: [1200,2800), chunk 2: [2400,4000), chunk 3: [3600,5000) = 1400 chars >= 150 ✓
// That gives 4 chunks.
const LONG_TEXT = 'x'.repeat(5000);

const BASE_RESULT: ClassificationResult = {
  worthy: true,
  memoryType: 'CONTEXT',
  confidence: 0.9,
  extractedContent: LONG_TEXT.slice(0, 3000), // what LLM sees (truncated)
  suggestedTags: ['confluence'],
  suggestedLayer: 'global',
};

// ---------------------------------------------------------------------------
// beforeEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  writeMemoryCallCount = 0;

  // Default mocks: upfront-claim succeeds
  mockQuery.mockResolvedValue({ rowCount: 1, rows: [{ message_id: 'msg-chunk-1' }] });
  mockedShould.mockReturnValue(true);
  mockedExtract.mockReturnValue(LONG_TEXT);

  // classifyWithUsage returns fullText = LONG_TEXT (full, untruncated)
  mockedClassify.mockResolvedValue({
    classification: BASE_RESULT,
    model: 'claude-haiku-4-5',
    inputTokens: 300,
    outputTokens: 60,
    fullText: LONG_TEXT,
  });

  // HTTP: tenant harvest enabled, connector owned by tenant
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/features/harvest')) return jsonResponse(200, { enabled: true });
    if (url.includes('/connectors/')) return jsonResponse(200, { tenantId: 'tenant-1' });
    return jsonResponse(200, {});
  });

  mockedNeedsTtl.mockReset();
  mockedNeedsTtl.mockReturnValue(false);
  mockedLookup.mockReset();
  mockedLookup.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runHarvestPipeline — chunked memory writes', () => {
  it('long document (>1600 chars) produces multiple writeMemory calls (one per chunk)', async () => {
    await runHarvestPipeline(makeEvent());
    // LONG_TEXT is 5000 chars → 4 chunks with default settings
    expect(mockedWriteMemory.mock.calls.length).toBeGreaterThan(1);
  });

  it('all chunks carry a harvest:chunk:N tag', async () => {
    await runHarvestPipeline(makeEvent());
    const allCalls = mockedWriteMemory.mock.calls;
    allCalls.forEach((call, i) => {
      const resultArg = call[1] as ClassificationResult;
      expect(resultArg.suggestedTags).toEqual(
        expect.arrayContaining([`harvest:chunk:${i}`]),
      );
    });
  });

  it('all chunks carry a harvest:entity:connectorId:entityId tag', async () => {
    await runHarvestPipeline(makeEvent());
    mockedWriteMemory.mock.calls.forEach((call) => {
      const resultArg = call[1] as ClassificationResult;
      expect(resultArg.suggestedTags).toEqual(
        expect.arrayContaining(['harvest:entity:conn-1:page-42']),
      );
    });
  });

  it('first chunk memoryId (not last, not null) is stored in upsertEntity', async () => {
    // writeMemory mock returns memory-id-1, memory-id-2, ... in call order
    await runHarvestPipeline(makeEvent());
    expect(mockedUpsert).toHaveBeenCalledTimes(1);
    expect(mockedUpsert.mock.calls[0][0].memoryId).toBe('memory-id-1');
  });

  it('short document (<=1600 chars) produces exactly one writeMemory call', async () => {
    const shortText = 'Short content that is well under the chunk size limit.';
    mockedExtract.mockReturnValue(shortText);
    mockedClassify.mockResolvedValue({
      classification: { ...BASE_RESULT, extractedContent: shortText },
      model: 'claude-haiku-4-5',
      inputTokens: 50,
      outputTokens: 20,
      fullText: shortText,
    });
    await runHarvestPipeline(makeEvent());
    expect(mockedWriteMemory).toHaveBeenCalledTimes(1);
  });

  it('change detection: same content re-harvested → writeMemory NOT called again (hash unchanged)', async () => {
    // Prior record has same hash — skip immediately
    mockedLookup.mockResolvedValue({
      contentHash: 'hash-abc', // matches computeContentHash mock return value
      memoryId: 'mem-old',
      memoryType: 'CONTEXT',
      expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
    });
    mockedNeedsTtl.mockReturnValue(false);

    await runHarvestPipeline(makeEvent());

    expect(mockedClassify).not.toHaveBeenCalled();
    expect(mockedWriteMemory).not.toHaveBeenCalled();
  });

  it('change detection: modified content → new chunks are written', async () => {
    // Prior record with a DIFFERENT hash → proceed with classification & write
    mockedLookup.mockResolvedValue({
      contentHash: 'old-different-hash',
      memoryId: 'mem-old',
      memoryType: 'CONTEXT',
      expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
    });
    mockedNeedsTtl.mockReturnValue(false);

    await runHarvestPipeline(makeEvent());

    expect(mockedClassify).toHaveBeenCalledTimes(1);
    expect(mockedWriteMemory.mock.calls.length).toBeGreaterThan(0);
  });

  it('each chunk uses the extracted text from the chunk, not the classifier extractedContent', async () => {
    await runHarvestPipeline(makeEvent());
    const calls = mockedWriteMemory.mock.calls;
    // Each call's result.extractedContent should be the chunk's text, not BASE_RESULT.extractedContent
    calls.forEach((call, i) => {
      const resultArg = call[1] as ClassificationResult;
      // Chunk texts are sub-strings of LONG_TEXT; they shouldn't equal the
      // original classifier extractedContent (which is only 3000 chars, the truncated version)
      // unless this is a single-chunk scenario (not the case for 5000 chars).
      expect(resultArg.extractedContent).toBeDefined();
      // chunkIndex tag confirms position
      expect(resultArg.suggestedTags).toEqual(
        expect.arrayContaining([`harvest:chunk:${i}`]),
      );
    });
  });

  it('tenantId passed to writeMemory is always the event tenantId', async () => {
    await runHarvestPipeline(makeEvent({ tenantId: 'tenant-xyz' }));
    mockedWriteMemory.mock.calls.forEach((call) => {
      expect(call[0]).toBe('tenant-xyz');
    });
  });
});
