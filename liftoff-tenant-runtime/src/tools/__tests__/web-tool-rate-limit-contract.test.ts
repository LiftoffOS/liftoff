/**
 * What the model is told when a vendor refuses on rate.
 *
 * Verbatim from a live run, twelve times on one step:
 *
 *   TOOL_ERROR {"error":"Finance search could not be completed.",
 *   "code":"internal_error","retryable":false,"recovery":"An internal error
 *   occurred calling this connector. Repeating the identical call is not
 *   expected to help — change the approach, or report it and move on."}
 *
 * The vendor had returned `429 request_rate_limit_exceeded` with
 * `retry-after: 1`. `classifyWebToolError` had a branch for nine error classes
 * and none for the one it arrived in, so the handler returned a bare
 * `success:false` and the gateway filled the blanks with the permanent-failure
 * envelope. The model did what the prose told it and the run produced nothing.
 *
 * Asserted across several tools, not just the one that failed: the branch is
 * shared, and the reason it was missing is that nobody was looking at any of
 * them.
 */
const mockFinance = jest.fn();
const mockPeople = jest.fn();
const mockResearch = jest.fn();
const mockRouterMethods = {
  fetch: jest.fn(), diff: jest.fn(), extract: jest.fn(), task: jest.fn(),
  research: mockResearch, search: jest.fn(), peopleSearch: mockPeople,
  financeSearch: mockFinance, deepResearch: jest.fn(),
  identityConnect: jest.fn(), sessionSave: jest.fn(),
};
jest.mock('../../integrations/web-fetch/router', () => ({
  WebFetchRouter: jest.fn(() => mockRouterMethods),
  webFetchRouter: mockRouterMethods,
}));
jest.mock('../../usage-ledger/service', () => ({
  usageLedgerService: { recordUsage: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn().mockReturnValue({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }),
  getPoolForService: jest.fn().mockReturnValue({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }),
}));

import { executeStandardTool, StandardToolContext } from '../standard-tool-handler';
import { PerplexityError } from '../../integrations/web-fetch/perplexity-client';
import { isRetryable, recoveryFor } from '@liftoffos/connector-types';

const ctx: StandardToolContext = {
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  memoryScope: { writableLayers: [], readableLayers: [] },
  traceId: 'trace-1',
};

/** The error the live run produced, to the byte. */
const LIVE_429 = () => new PerplexityError(
  'Perplexity 429: {"error":{"message":"Request rate limit exceeded, please try again later.",'
  + '"type":"request_rate_limit_exceeded","code":429}}',
  429,
  '{"error":{"code":429}}',
  1_000,
);

const TOOLS = [
  { name: 'web_finance_search', mock: mockFinance, args: { query: 'AAPL latest price' } },
  { name: 'web_people_search', mock: mockPeople, args: { query: 'Tim Cook' } },
  // `question`, not `query` — the surrounding schema-rejection suite passes
  // `{ query: '' }` for this tool and would pass with any argument at all.
  { name: 'web_research', mock: mockResearch, args: { question: 'competitor pricing' } },
] as const;

beforeEach(() => jest.clearAllMocks());

describe('a vendor rate limit is reported as a rate limit', () => {
  it.each(TOOLS)('$name', async ({ name, mock, args }) => {
    mock.mockRejectedValue(LIVE_429());
    const r = await executeStandardTool(name, args, ctx);
    expect(r?.success).toBe(false);
    expect(r?.errorCode).toBe('rate_limited');
  });

  it.each(TOOLS)('$name is retryable, and says how long to wait', async ({ name, mock, args }) => {
    mock.mockRejectedValue(LIVE_429());
    const r = await executeStandardTool(name, args, ctx);
    expect(r?.retryable).toBe(true);
    expect(r?.transient).toBe(true);
    // The vendor's own number, not one of ours.
    expect(r?.retryAfterMs).toBe(1_000);
  });

  it.each(TOOLS)('$name never reports the permanent-failure envelope', async ({ name, mock, args }) => {
    mock.mockRejectedValue(LIVE_429());
    const r = await executeStandardTool(name, args, ctx);
    expect(r?.errorCode).not.toBe('internal_error');
    expect(r?.retryable).not.toBe(false);
  });

  it('the wait reaches the model in the message, not only in a field', async () => {
    // The model reads the prose. The machine-readable field agreeing with it is
    // the point of the change, so both have to carry it.
    mockFinance.mockRejectedValue(LIVE_429());
    const r = await executeStandardTool('web_finance_search', { query: 'AAPL' }, ctx);
    expect(r?.error).toMatch(/rate limiting/i);
    expect(r?.error).toMatch(/1s/);
  });
});

describe('the code the handler now returns means what the model is told', () => {
  it('rate_limited is retryable in the shared vocabulary', () => {
    expect(isRetryable('rate_limited')).toBe(true);
  });

  it('its recovery text tells the model to retry the SAME call', () => {
    // The opposite instruction to the one the run received twelve times.
    expect(recoveryFor('rate_limited')).toMatch(/retry the same call unchanged/i);
    expect(recoveryFor('internal_error')).toMatch(/not expected to help/i);
  });
});

describe('a vendor failure that is NOT a rate limit is unchanged', () => {
  it.each([500, 503, 0, 422, 408])('status %s stays off the rate-limited path', async (status) => {
    mockFinance.mockRejectedValue(new PerplexityError(`Perplexity ${status}`, status));
    const r = await executeStandardTool('web_finance_search', { query: 'AAPL' }, ctx);
    expect(r?.success).toBe(false);
    expect(r?.errorCode).not.toBe('rate_limited');
  });

  it('a schema rejection never reaches the vendor at all', async () => {
    const r = await executeStandardTool('web_finance_search', {}, ctx);
    expect(r?.success).toBe(false);
    expect(mockFinance).not.toHaveBeenCalled();
  });
});
