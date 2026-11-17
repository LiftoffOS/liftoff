// A managed session is a first-class session, and what it buys is the wire.
//
// The gateway was built for the one case where the credential is the customer's,
// which is a small minority of runs. Nothing Liftoff funds has ever passed a
// component that reads the vendor's own response — and for two engines that
// response carries the only figure that can be priced from.
//
// So what is asserted here is not "BYOK also works managed". It is the three
// decisions that make a managed session safe, each of which fails silently and
// expensively if it goes the other way:
//
//   1. A managed session NEVER looks for a customer key. Re-deciding whose key
//      pays at request time would start spending a customer's account the moment
//      a workspace on Liftoff's key happened to hold one for the same vendor.
//   2. A managed session is never offered where the substitution cannot be made.
//      Handing the runtime a base URL that 502s turns a working turn into a
//      failed one for the sake of bookkeeping.
//   3. `served_by` says 'managed' from the first byte. The ledger counts these
//      rows to pick the run's cost bucket, so a managed session recorded as
//      'byok' would zero-rate a turn Liftoff paid for.

const queryMock = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: (_t: string, fn: (c: { query: jest.Mock }) => Promise<unknown>) =>
    fn({ query: queryMock }),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getAccessToken: jest.fn().mockResolvedValue('adc-token'),
  })),
  JWT: jest.fn(),
}));
jest.mock('../../llm/client', () => ({ purposeToGroup: () => 'agent-execution' }));

const getAnthropicApiKeyForGroup = jest.fn();
const getOpenAIApiKeyForGroup = jest.fn();
const getOpenRouterApiKey = jest.fn();
jest.mock('../../infrastructure/secrets', () => ({
  getAnthropicApiKeyForGroup: (...a: unknown[]) => getAnthropicApiKeyForGroup(...a),
  getOpenAIApiKeyForGroup: (...a: unknown[]) => getOpenAIApiKeyForGroup(...a),
  getOpenRouterApiKey: (...a: unknown[]) => getOpenRouterApiKey(...a),
}));

import { canSubstituteManaged, getManagedSubstitution } from '../managed-fallback';
import { mintGatewayToken, verifyGatewayToken } from '../token-store';
import { sumGatewayUsageForRun } from '../usage-recorder';
import { EMPTY_USAGE } from '../vendor-adapters';

const TENANT = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';
const RUN = 'f399e6ff-f11b-4b94-ad8e-9c23ca936a7e';
const PAUSE = '5e250fbf-00cf-4c9a-bf57-143566d80699';
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
  getAnthropicApiKeyForGroup.mockReset().mockResolvedValue('sk-ant-pool');
  getOpenAIApiKeyForGroup.mockReset().mockResolvedValue('sk-openai-pool');
  getOpenRouterApiKey.mockReset().mockResolvedValue('sk-or-liftoff');
  process.env = { ...ORIGINAL_ENV, GCP_PROJECT_ID: 'example-control-staging' };
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('the mode travels on the token', () => {
  it('is written at mint time', async () => {
    await mintGatewayToken({
      tenantId: TENANT,
      invocationId: RUN,
      vendor: 'anthropic',
      agentId: null,
      purpose: 'agent_invocation',
      mode: 'managed',
    });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('mode');
    expect(params).toContain('managed');
  });

  it('comes back on the session the gateway verifies', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        token_hash: 'aa',
        tenant_id: TENANT,
        invocation_id: RUN,
        vendor: 'openrouter',
        agent_id: null,
        purpose: 'agent_invocation',
        mode: 'managed',
      }],
    });
    // The hash lookup already matched, so the constant-time comparison is fed a
    // real digest of the presented token.
    const token = `liftoff_byok_${TENANT}_secret`;
    const { createHash } = await import('crypto');
    const digest = createHash('sha256').update(token).digest('hex');
    queryMock.mockReset();
    queryMock.mockResolvedValue({
      rows: [{
        token_hash: digest,
        tenant_id: TENANT,
        invocation_id: RUN,
        vendor: 'openrouter',
        agent_id: null,
        purpose: 'agent_invocation',
        mode: 'managed',
      }],
    });
    const session = await verifyGatewayToken(token);
    expect(session).toMatchObject({ vendor: 'openrouter', mode: 'managed' });
  });

  it('reads anything but the one other value as byok', async () => {
    // A row written before the column existed was a BYOK session by
    // construction, and failing toward 'byok' fails toward looking for the
    // customer's key first — which costs a lookup rather than spending
    // Liftoff's key on a session the customer was funding.
    const token = `liftoff_byok_${TENANT}_secret`;
    const { createHash } = await import('crypto');
    const digest = createHash('sha256').update(token).digest('hex');
    for (const stored of ['byok', '', 'MANAGED', 'nonsense']) {
      queryMock.mockReset();
      queryMock.mockResolvedValue({
        rows: [{
          token_hash: digest,
          tenant_id: TENANT,
          invocation_id: RUN,
          vendor: 'anthropic',
          agent_id: null,
          purpose: 'agent_invocation',
          mode: stored,
        }],
      });
      expect((await verifyGatewayToken(token))?.mode).toBe('byok');
    }
  });
});

describe('a door is not offered unless it can open', () => {
  it('can substitute for every vendor whose credential is configured', async () => {
    for (const vendor of ['anthropic', 'openai', 'google', 'xai', 'openrouter']) {
      expect(await canSubstituteManaged(vendor, 'agent_invocation')).toBe(true);
    }
  });

  it('REFUSES google with no project in the environment', async () => {
    // The 502 this prevents: Vertex names the project in the path, so a
    // substitution with nothing to name cannot be made, and a runtime pointed at
    // the gateway would get "could not reach the provider" for a turn that had a
    // perfectly good ADC path of its own.
    delete process.env.GCP_PROJECT_ID;
    expect(await canSubstituteManaged('google', 'agent_invocation')).toBe(false);
  });

  it('REFUSES xai with no OpenRouter key on file', async () => {
    // Managed Grok reaches us through OpenRouter, so the OpenRouter key IS the
    // xAI substitution. Without it there is nothing to attach.
    getOpenRouterApiKey.mockResolvedValue(null);
    expect(await canSubstituteManaged('xai', 'agent_invocation')).toBe(false);
  });

  it('REFUSES openrouter with no OpenRouter key on file', async () => {
    getOpenRouterApiKey.mockResolvedValue(null);
    expect(await canSubstituteManaged('openrouter', 'agent_invocation')).toBe(false);
  });

  it('REFUSES a vendor the gateway has no managed path for at all', async () => {
    expect(await canSubstituteManaged('anthropic-vertex', 'agent_invocation')).toBe(false);
  });

  it('answers "not now" rather than throwing when the credential read fails', async () => {
    // A secrets outage must not become an exception on the session-open path,
    // which degrades the run to managed anyway — but loudly, and only after the
    // stack has unwound past the branch that could have said so calmly.
    getAnthropicApiKeyForGroup.mockRejectedValue(new Error('secret manager away'));
    expect(await canSubstituteManaged('anthropic', 'agent_invocation')).toBe(false);
  });
});

describe('the openrouter substitution', () => {
  it('changes the credential and NOTHING else', async () => {
    // Unlike the xAI substitution beside it, there is no host to move and no
    // model id to translate: the adapter already points at OpenRouter and the
    // model ids already carry OpenRouter's namespace. A `rewriteModel` here
    // would prefix `x-ai/` onto a GLM id and 404.
    const substitution = await getManagedSubstitution('openrouter', 'agent_invocation');
    expect(substitution).toEqual({ apiKey: 'sk-or-liftoff' });
  });
});

describe('what the gateway saw, read back for the run that bills', () => {
  const row = {
    requests: '3',
    incomplete: '0',
    input_tokens: '1200',
    output_tokens: '6231',
    cache_read_tokens: '28015',
    cache_write_tokens: '31300',
    reasoning_tokens: '6028',
    vendor_cost_usd: '0.0185399000',
    vendor_cost_requests: '3',
  };

  it('sums the run and reports how many requests it saw', async () => {
    queryMock.mockResolvedValue({ rows: [row] });
    await expect(sumGatewayUsageForRun(TENANT, RUN)).resolves.toEqual({
      requests: 3,
      incomplete: 0,
      inputTokens: 1200,
      outputTokens: 6231,
      cacheReadTokens: 28015,
      cacheWriteTokens: 31300,
      reasoningTokens: 6028,
      vendorCostUsd: 0.0185399,
      vendorCostRequests: 3,
    });
  });

  it('reports the charge AND how many requests reported one', async () => {
    // The count is what makes the sum usable. A sum over some of a run's requests
    // is not the run's charge, and preferring a partial sum over a complete token
    // reconstruction would under-bill by whatever the silent requests cost.
    queryMock.mockResolvedValue({
      rows: [{ ...row, requests: '3', vendor_cost_requests: '1', vendor_cost_usd: '0.0020000000' }],
    });
    const usage = await sumGatewayUsageForRun(TENANT, RUN);
    expect(usage.vendorCostUsd).toBe(0.002);
    expect(usage.vendorCostRequests).toBe(1);
    expect(usage.requests).toBe(3);
  });

  it('reports NULL, not zero, when no request reported a charge', async () => {
    // SUM over NULLs is NULL in Postgres, and that is wanted: it says the vendor
    // publishes a price list rather than a per-call charge. A zero would read as
    // "this run was free".
    queryMock.mockResolvedValue({
      rows: [{ ...row, vendor_cost_usd: null, vendor_cost_requests: '0' }],
    });
    const usage = await sumGatewayUsageForRun(TENANT, RUN);
    expect(usage.vendorCostUsd).toBeNull();
    expect(usage.vendorCostRequests).toBe(0);
  });

  it('sums the charge with the precision a sub-cent figure needs', async () => {
    // NUMERIC(18,10) in the column, because these are fractions of a cent summed
    // over millions of rows. A float would drift.
    queryMock.mockResolvedValue({
      rows: [{ ...row, vendor_cost_usd: '0.0000025200', vendor_cost_requests: '3' }],
    });
    expect((await sumGatewayUsageForRun(TENANT, RUN)).vendorCostUsd).toBeCloseTo(0.00000252, 10);
  });

  it('counts the rows whose token counts have not landed yet', async () => {
    // A row is opened BEFORE the response is forwarded and its counts arrive
    // afterwards by UPDATE. `status_code IS NULL` is exactly "opened and not yet
    // completed", because the completing statement sets the status and the counts
    // together and the single-write path always carries one. Without this count a
    // caller reading the instant its turn ends takes the last request's zeroes
    // for an answer and under-reports the run by one request, every time.
    queryMock.mockResolvedValue({ rows: [{ ...row, incomplete: '1' }] });
    const usage = await sumGatewayUsageForRun(TENANT, RUN);
    expect(usage.incomplete).toBe(1);
    expect(queryMock.mock.calls[0][0]).toContain('status_code IS NULL');
  });

  it('bounds the sum to one HALF of a run when asked', async () => {
    // A RUN CAN BILL MORE THAN ONCE. A turn that pauses for a person bills the
    // paused half and then bills its continuation separately, while every row for
    // both halves was written under the run's own id. An unbounded sum handed to
    // the continuation contains requests the paused half was already charged for.
    queryMock.mockResolvedValue({ rows: [row] });
    const since = new Date('2026-09-26T18:00:00.000Z');
    await sumGatewayUsageForRun(TENANT, RUN, since);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('occurred_at >=');
    expect(params).toEqual([TENANT, RUN, since]);
  });

  it('reads the whole run when no bound is given', async () => {
    // Correct for a run that bills once, which is nearly all of them. The
    // predicate has to be inert rather than absent, so one statement serves both.
    queryMock.mockResolvedValue({ rows: [row] });
    await sumGatewayUsageForRun(TENANT, RUN);
    expect(queryMock.mock.calls[0][1]).toEqual([TENANT, RUN, null]);
  });

  it('reads under the RUN when the continuation asks', async () => {
    // The same normalisation wasRunByokFunded does. A run that paused for a
    // person bills its continuation under `<invocation>:resume:<pause>`, and
    // every gateway row for both halves was written under the run's own id.
    queryMock.mockResolvedValue({ rows: [row] });
    await sumGatewayUsageForRun(TENANT, `${RUN}:resume:${PAUSE}`);
    expect(queryMock).toHaveBeenCalledWith(expect.any(String), [TENANT, RUN, null]);
  });

  it('reports zero REQUESTS for a run that never came through the door', async () => {
    // This is the field that matters. A caller cannot tell "the gateway saw
    // nothing" from "the gateway saw a run that spent nothing" off the token
    // counts alone, and getting it wrong means discarding an engine's own
    // numbers in favour of zeroes.
    queryMock.mockResolvedValue({
      rows: [{
        requests: '0',
        incomplete: '0',
        input_tokens: '0',
        output_tokens: '0',
        cache_read_tokens: '0',
        cache_write_tokens: '0',
        reasoning_tokens: '0',
        vendor_cost_usd: null,
        vendor_cost_requests: '0',
      }],
    });
    const usage = await sumGatewayUsageForRun(TENANT, RUN);
    expect(usage.requests).toBe(0);
  });

  it('never queries at all for an empty run id', async () => {
    await expect(sumGatewayUsageForRun(TENANT, '')).resolves.toMatchObject({ requests: 0 });
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('the empty usage record carries every field', () => {
  it('has a zero for each, so a row can never be written with NULLs by omission', () => {
    // `EMPTY_USAGE` is what a request that produced no parseable usage is
    // recorded with, and it is spread into every accumulator. A field missing
    // from it reaches the database as NULL and reads as "nobody looked" forever.
    expect(EMPTY_USAGE).toEqual({
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      // NULL rather than 0, and the distinction is the whole reason the field
      // exists: a zero booked as a charge is an unbilled call.
      vendorCostUsd: null,
    });
  });
});
