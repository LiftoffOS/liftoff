// Reading back what the gateway saw, and the one asymmetry that matters.
//
// A FAILED READ MUST NEVER ZERO A COUNT. The whole point of this path is that two
// engines under-report their own spend, and replacing a real count with a failed
// read's zeroes would be the same defect introduced by the cure. So every failure
// answers null, and null means "keep the engine's numbers" — which is exactly
// what the invocation recorded before any of this existed.

const fetchMock = jest.fn();
jest.mock('../../platform-callback/client', () => ({
  getPlatformCallbackClient: () => fetchMock.mock.calls !== undefined ? { fetch: fetchMock } : null,
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { readGatewayRunUsage } from '../gateway-usage';

const TENANT = '11111111-1111-4111-8111-111111111111';
const RUN = 'f399e6ff-f11b-4b94-ad8e-9c23ca936a7e';

const FULL = {
  requests: 5,
  incomplete: 0,
  inputTokens: 1_200,
  outputTokens: 6_231,
  cacheReadTokens: 28_015,
  cacheWriteTokens: 31_300,
  reasoningTokens: 6_028,
  vendorCostUsd: 0.01853990,
  vendorCostRequests: 5,
};
const HALF_STARTED = new Date('2026-09-26T18:00:00.000Z');

function ok(body: unknown): unknown {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('readGatewayRunUsage', () => {
  it('returns the totals the control plane reports', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => FULL });
    await expect(readGatewayRunUsage(TENANT, RUN)).resolves.toEqual(FULL);
  });

  it('asks under the tenant AND the run, because the rows are tenant-scoped', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => FULL });
    await readGatewayRunUsage(TENANT, RUN);
    const [, path, opts] = fetchMock.mock.calls[0];
    expect(path).toContain('/api/internal/byok/session/usage?');
    expect(path).toContain(`tenantId=${TENANT}`);
    expect(path).toContain(`invocationId=${RUN}`);
    expect(opts.method).toBe('GET');
    // Bounded: the turn is over and the engine's own counts are the fallback, so
    // waiting indefinitely for a better answer buys nothing.
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('answers null on a non-OK response, keeping the engine counts', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    await expect(readGatewayRunUsage(TENANT, RUN)).resolves.toBeNull();
  });

  it('answers null when the call throws', async () => {
    fetchMock.mockRejectedValue(new Error('breaker open'));
    await expect(readGatewayRunUsage(TENANT, RUN)).resolves.toBeNull();
  });

  it('answers null for a body with no request count', async () => {
    // `requests` is what tells "the gateway saw nothing" from "the gateway saw a
    // run that spent nothing". A body without it cannot be used for either.
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ outputTokens: 10 }) });
    await expect(readGatewayRunUsage(TENANT, RUN)).resolves.toBeNull();
  });

  it('never asks without both ids', async () => {
    await expect(readGatewayRunUsage('', RUN)).resolves.toBeNull();
    await expect(readGatewayRunUsage(TENANT, '')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('coerces a missing or nonsensical field to zero rather than NaN', async () => {
    // A NaN reaching the shortfall arithmetic would make every comparison false
    // and the charge NaN, which persists as a broken number rather than as a
    // missing one.
    fetchMock.mockResolvedValue(ok({ requests: 2, outputTokens: 'lots', cacheWriteTokens: -5 }));
    await expect(readGatewayRunUsage(TENANT, RUN)).resolves.toEqual({
      requests: 2,
      incomplete: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      vendorCostUsd: null,
      vendorCostRequests: 0,
    });
  });

  it('carries the charge and its request count through JSON intact', async () => {
    // A cost that arrived as a string would compare false against every number and
    // silently disable the preference, which is exactly the failure this whole
    // change exists to end.
    fetchMock.mockResolvedValue(ok(FULL));
    const usage = await readGatewayRunUsage(TENANT, RUN);
    expect(usage!.vendorCostUsd).toBe(0.01853990);
    expect(usage!.vendorCostRequests).toBe(5);
  });

  it('refuses a zero or a non-number as a charge', async () => {
    for (const c of [0, -1, '0.02', null]) {
      fetchMock.mockResolvedValue(ok({ ...FULL, vendorCostUsd: c }));
      expect((await readGatewayRunUsage(TENANT, RUN))!.vendorCostUsd).toBeNull();
    }
  });
});

describe('the half, not the whole run', () => {
  // A RUN CAN BILL MORE THAN ONCE. A turn that pauses for a person bills the
  // paused half and then bills its continuation separately, while the gateway
  // wrote every row for both halves under the run's own id. An unbounded sum
  // handed to the continuation contains requests the paused half was already
  // charged for, and the difference it would then be asked to explain is tokens
  // it never spent — the run billed twice for them.
  it('bounds the read to the instant this half started', async () => {
    fetchMock.mockResolvedValue(ok(FULL));
    await readGatewayRunUsage(TENANT, RUN, HALF_STARTED);
    expect(fetchMock.mock.calls[0][1]).toContain(
      `since=${encodeURIComponent(HALF_STARTED.toISOString())}`,
    );
  });

  it('asks for the whole run when no bound is given', async () => {
    // Correct for a run that bills once, which is nearly all of them.
    fetchMock.mockResolvedValue(ok(FULL));
    await readGatewayRunUsage(TENANT, RUN);
    expect(fetchMock.mock.calls[0][1]).not.toContain('since=');
  });
});

describe('a request the gateway had not finished writing', () => {
  // The gateway opens a row BEFORE forwarding the response and fills its counts
  // in afterwards — deliberately, because the ledger's funding question is a
  // count over these rows and has to be answerable before the run settles. The
  // consequence here is a race: a turn ending the instant its last response
  // completes can read that row's zeroes, which under-reports the run by exactly
  // one request, every time, in the direction this whole change corrects.
  it('waits once and takes the completed answer', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ ...FULL, requests: 5, incomplete: 1, cacheWriteTokens: 0 }))
      .mockResolvedValueOnce(ok({ ...FULL, requests: 5, incomplete: 0, cacheWriteTokens: 31_300 }));
    const usage = await readGatewayRunUsage(TENANT, RUN, HALF_STARTED);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(usage!.cacheWriteTokens).toBe(31_300);
    expect(usage!.incomplete).toBe(0);
  });

  it('does not read twice when nothing is pending', async () => {
    // The common case, and it must cost nothing: one read per turn.
    fetchMock.mockResolvedValue(ok(FULL));
    await readGatewayRunUsage(TENANT, RUN, HALF_STARTED);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('takes what is there rather than spinning when the row never lands', async () => {
    // A row still unwritten after the grace is a FAILED write, which the gateway
    // reports on its own side. Waiting longer would trade a one-request
    // under-count for a stalled turn.
    fetchMock.mockResolvedValue(ok({ ...FULL, incomplete: 1 }));
    const usage = await readGatewayRunUsage(TENANT, RUN, HALF_STARTED);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(usage!.incomplete).toBe(1);
    // And the counts it DID read are still used: a short answer beats no answer.
    expect(usage!.cacheWriteTokens).toBe(31_300);
  });

  it('keeps the first answer when the retry fails outright', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ ...FULL, incomplete: 1 }))
      .mockRejectedValueOnce(new Error('breaker opened between the two reads'));
    const usage = await readGatewayRunUsage(TENANT, RUN, HALF_STARTED);
    expect(usage!.cacheWriteTokens).toBe(31_300);
  });
});
