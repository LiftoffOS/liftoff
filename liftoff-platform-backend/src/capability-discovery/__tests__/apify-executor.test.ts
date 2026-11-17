const prepaidMock = jest.fn();
const refreshMock = jest.fn(async (_id: string) => ({ balanceUsd: null as number | null, retired: false }));
const ensureMock = jest.fn(async () => ({ purchased: false }));
jest.mock('../../billing/apify-prepaid-token-service', () => ({
  getLiveApifyPrepaidToken: (...a: unknown[]) => prepaidMock(...a),
  refreshApifyPrepaidBalance: (id: string) => refreshMock(id),
  ensureApifyPrepaidToken: (...a: unknown[]) => ensureMock(...a),
  apifyPrepaidMinBalanceUsd: () => 0.1,
}));

interface BalanceAnswer { balanceUsd: number | null; retired: boolean }

/** What the vendor says about each token's balance, in call order.
 *
 *  The run path reads a token's balance TWICE on the refusal path — once
 *  when it selects the token, and again when the vendor refuses the start —
 *  so a token that is healthy at selection and spent by the refusal has two
 *  answers. The last answer repeats. */
function refreshAnswers(script: Record<string, BalanceAnswer[]>): void {
  const seen: Record<string, number> = {};
  refreshMock.mockImplementation(async (id: string) => {
    const queue = script[id] ?? [];
    const i = seen[id] ?? 0;
    seen[id] = i + 1;
    return queue[Math.min(i, queue.length - 1)] ?? { balanceUsd: null, retired: false };
  });
}

/** The cooldown table, in memory: what was parked and until when. */
const parkedCredentials = new Map<string, number>();
const parkMock = jest.fn(async (input: { credentialRef: string; durationMs: number }) => {
  parkedCredentials.set(input.credentialRef, Date.now() + input.durationMs);
});
jest.mock('../vendor-gate', () => ({
  platformVendorSwitchedOffSync: () => false,
  isCooling: (ref: string) => (parkedCredentials.get(ref) ?? 0) > Date.now(),
  parkCredential: (input: { credentialRef: string; durationMs: number }) => parkMock(input),
}));

import {
  _resetApifyPurchaseBackoff,
  apifyPlatformConfigured,
  runApifyActor,
  fetchApifyActorInputFields,
  fetchApifyActorInputSchema,
  resolveApifyCredential,
} from '../apify-executor';

beforeEach(() => {
  prepaidMock.mockReset();
  prepaidMock.mockResolvedValue(null);
  refreshMock.mockClear();
  // The vendor cannot be reached by default, so every test's arithmetic is
  // the balance its own token carries.
  refreshMock.mockImplementation(async () => ({ balanceUsd: null, retired: false }));
  ensureMock.mockClear();
  ensureMock.mockResolvedValue({ purchased: false });
  parkMock.mockClear();
  parkedCredentials.clear();
  // The run path's purchase backoff is process state; a test that expects a
  // purchase must not be answering the previous test's clock.
  _resetApifyPurchaseBackoff();
});

describe('apify-executor (platform-funded actor runs)', () => {
  const saved = process.env.APIFY_PLATFORM_TOKEN;
  afterEach(() => {
    if (saved === undefined) delete process.env.APIFY_PLATFORM_TOKEN;
    else process.env.APIFY_PLATFORM_TOKEN = saved;
  });

  it('is inert without a platform token — configured() is false and a run refuses cleanly', async () => {
    delete process.env.APIFY_PLATFORM_TOKEN;
    expect(apifyPlatformConfigured()).toBe(false);

    // No token → no network call, a typed refusal (never a fabricated success).
    const run = await runApifyActor('someuser/some-actor', { search: 'x' });
    expect(run.success).toBe(false);
    expect(run.error).toBeTruthy();

    // And no arg hint rather than a throw.
    await expect(fetchApifyActorInputFields('someuser/some-actor')).resolves.toEqual([]);
  });

  it('reports configured when a non-empty token is present', () => {
    process.env.APIFY_PLATFORM_TOKEN = 'apify_api_test';
    expect(apifyPlatformConfigured()).toBe(true);
  });

  it('refuses a run with no actor reference', async () => {
    process.env.APIFY_PLATFORM_TOKEN = 'apify_api_test';
    const run = await runApifyActor('   ', {});
    expect(run.success).toBe(false);
  });

  describe('with the source answering', () => {
    const realFetch = global.fetch;
    afterEach(() => {
      global.fetch = realFetch;
    });

    it('reports an input the source rejected as an argument rejection, with its account of it', async () => {
      process.env.APIFY_PLATFORM_TOKEN = 'apify_api_test';
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { type: 'invalid-input', message: 'Input is not valid: Field input.searchTerms must be array' } }),
      }) as unknown as typeof fetch;
      const run = await runApifyActor('someuser/some-actor', { searchTerms: 'x' });
      expect(run).toEqual({ success: false, argumentsRejected: true, error: 'Input is not valid: Field input.searchTerms must be array' });
    });

    it('reports any other source error as a plain failure naming the status', async () => {
      process.env.APIFY_PLATFORM_TOKEN = 'apify_api_test';
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { type: 'run-failed', message: 'Actor run did not succeed' } }),
      }) as unknown as typeof fetch;
      const run = await runApifyActor('someuser/some-actor', {});
      expect(run.success).toBe(false);
      expect(run.argumentsRejected).toBeUndefined();
      expect(run.error).toMatch(/^the source returned an error \(400\)/);
    });

    it('reads each input field with its type and whether it is required', async () => {
      process.env.APIFY_PLATFORM_TOKEN = 'apify_api_test';
      const inputSchema = JSON.stringify({
        properties: { searchTerms: { type: 'array', items: { type: 'string' } }, sort: { type: 'string' } },
        required: ['searchTerms'],
      });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { inputSchema } }),
      }) as unknown as typeof fetch;
      await expect(fetchApifyActorInputFields('someuser/typed-actor')).resolves.toEqual([
        { name: 'searchTerms', type: 'array of string', required: true },
        { name: 'sort', type: 'string', required: false },
      ]);
    });
  });
});

// Two boundaries. Before a run exists, a failure is definite: a 401 or 402 is
// the ACCOUNT's and parks it, anything else is this call's, and either way a
// caller may go on to another source. Once the vendor may have started a run
// — a start call that never answered, an acknowledgement with no id, or a run
// this call started and could not finish — cost may have been incurred and
// the answer is unknown, so the result says not to start another.
describe('apify-executor — account failures and the ambiguity boundary', () => {
  const realFetch = global.fetch;
  beforeEach(() => { process.env.APIFY_PLATFORM_TOKEN = 'apify_api_test'; });
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.APIFY_PLATFORM_TOKEN;
  });

  const startFails = (status: number, body = '') => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status, text: async () => body }) as unknown as typeof fetch;
  };

  it('a 401 on the start call is an auth account failure, definite and safe to fail over from', async () => {
    startFails(401, JSON.stringify({ error: { type: 'token-not-valid', message: 'Authentication token is not valid' } }));
    const run = await runApifyActor('someuser/some-actor', {});
    expect(run).toMatchObject({ success: false, accountFailure: 'auth' });
    expect(run.autoFailoverSafe).toBeUndefined();
    expect(run.argumentsRejected).toBeUndefined();
    expect(run.runId).toBeUndefined();
  });

  it('a 402 on the start call is a payment account failure', async () => {
    startFails(402, JSON.stringify({ error: { type: 'payment-required', message: 'Your account has run out of credit' } }));
    expect(await runApifyActor('someuser/some-actor', {})).toMatchObject({ success: false, accountFailure: 'payment' });
  });

  it.each([403, 404, 429])('a %s on the start call is a plain, definite failure — no park, safe to fail over', async (status) => {
    startFails(status, JSON.stringify({ error: { type: 'some-type', message: 'refused' } }));
    const run = await runApifyActor('someuser/some-actor', {});
    expect(run.success).toBe(false);
    expect(run.accountFailure).toBeUndefined();
    expect(run.autoFailoverSafe).toBeUndefined();
    expect(run.error).toContain(`(${status})`);
  });

  it.each([500, 502, 503, 504])('a %s on the start call is ambiguous: a gateway may have forwarded the request', async (status) => {
    startFails(status, 'upstream error');
    const run = await runApifyActor('someuser/some-actor', {});
    expect(run).toEqual({ success: false, error: `the source returned an error (${status}): upstream error`, autoFailoverSafe: false });
  });

  it('a start call that times out is ambiguous: the actor may have started', async () => {
    global.fetch = jest.fn().mockRejectedValue(Object.assign(new Error('timeout'), { name: 'TimeoutError' })) as unknown as typeof fetch;
    const run = await runApifyActor('someuser/some-actor', {});
    expect(run).toEqual({ success: false, error: 'the source timed out', autoFailoverSafe: false });
  });

  it('an acknowledgement with no run id is ambiguous', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ data: {} }) }) as unknown as typeof fetch;
    const run = await runApifyActor('someuser/some-actor', {});
    expect(run).toEqual({ success: false, error: 'the source did not acknowledge the run', autoFailoverSafe: false });
  });

  it('a run that started and then FAILED carries its id and the charge the vendor reported, and is not safe to fail over from', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true, status: 201,
        json: async () => ({ data: { id: 'run-1', status: 'FAILED', statusMessage: 'Actor crashed', usageTotalUsd: 0.0007 } }),
      }) as unknown as typeof fetch;
    const run = await runApifyActor('someuser/some-actor', {});
    expect(run).toEqual({
      success: false,
      error: 'the source returned an error (run FAILED): Actor crashed',
      runId: 'run-1',
      autoFailoverSafe: false,
      costUsd: 0.0007,
      fundingSource: 'platform_key',
    });
  });

  it('a run that succeeded but would not give up its dataset is likewise ambiguous, with its id', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ data: { id: 'run-2', status: 'SUCCEEDED' } }) })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => '' }) as unknown as typeof fetch;
    const run = await runApifyActor('someuser/some-actor', {});
    expect(run).toEqual({ success: false, error: 'the source returned an error (503)', runId: 'run-2', autoFailoverSafe: false, fundingSource: 'platform_key' });
  });
});

describe('apify-executor — the complete input schema for validation', () => {
  const realFetch = global.fetch;
  beforeEach(() => { process.env.APIFY_PLATFORM_TOKEN = 'apify_api_test'; });
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.APIFY_PLATFORM_TOKEN;
  });

  it('returns the whole parsed schema, nested requirements included, and null when the build has none', async () => {
    const schema = {
      type: 'object',
      properties: {
        searchTerms: { type: 'array', items: { type: 'string' }, minItems: 1 },
        filters: { type: 'object', properties: { since: { type: 'string' } }, required: ['since'] },
      },
      required: ['searchTerms'],
      additionalProperties: false,
    };
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { inputSchema: JSON.stringify(schema) } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: {} }) }) as unknown as typeof fetch;
    await expect(fetchApifyActorInputSchema('someuser/full-schema-actor')).resolves.toEqual(schema);
    await expect(fetchApifyActorInputSchema('someuser/no-schema-actor')).resolves.toBeNull();
    // The display hint is derived from the same document.
    await expect(fetchApifyActorInputFields('someuser/full-schema-actor')).resolves.toEqual([
      { name: 'searchTerms', type: 'array of string', required: true },
      { name: 'filters', type: 'object', required: false },
    ]);
  });
});

describe('apify-executor — which bearer pays', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.APIFY_PLATFORM_TOKEN;
  });

  const PREPAID = { id: 'purchase-1', token: 'apify_api_prepaid', balanceUsd: 8, expiresAt: new Date(Date.now() + 86_400_000) };

  function actorRecord(pricingModel: string) {
    return { ok: true, status: 200, json: async () => ({ data: { pricingInfos: [{ pricingModel, startedAt: '2026-01-01T00:00:00Z' }] } }) };
  }

  it('runs a pay-per-event actor on the prepaid token and says the wallet paid', async () => {
    process.env.APIFY_PLATFORM_TOKEN = 'apify_api_account';
    prepaidMock.mockResolvedValue(PREPAID);
    const calls: Array<{ url: string; auth?: string }> = [];
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
      if (url.endsWith('/acts/someuser~ppe-actor')) return actorRecord('PAY_PER_EVENT');
      if (url.includes('/runs?')) return { ok: true, status: 201, json: async () => ({ data: { id: 'run-ppe', status: 'SUCCEEDED', usageTotalUsd: 0.02 } }) };
      if (url.includes('/dataset/items')) return { ok: true, status: 200, json: async () => [{ a: 1 }] };
      return { ok: true, status: 200, json: async () => ({ data: { id: 'run-ppe', status: 'SUCCEEDED', usageTotalUsd: 0.02 } }) };
    }) as unknown as typeof fetch;

    const run = await runApifyActor('someuser/ppe-actor', {});
    expect(run).toMatchObject({ success: true, runId: 'run-ppe', fundingSource: 'x402_wallet' });
    const start = calls.find((c) => c.url.includes('/runs?'));
    expect(start?.auth).toBe('Bearer apify_api_prepaid');
    expect(prepaidMock).toHaveBeenCalledTimes(1);
  });

  it('runs anything not pay-per-event on the account, even with a live prepaid token', async () => {
    process.env.APIFY_PLATFORM_TOKEN = 'apify_api_account';
    prepaidMock.mockResolvedValue(PREPAID);
    global.fetch = jest.fn(async (url: string) => {
      if (url.endsWith('/acts/someuser~rental-actor')) return actorRecord('FLAT_PRICE_PER_MONTH');
      return { ok: false, status: 404, text: async () => '' };
    }) as unknown as typeof fetch;
    expect(await resolveApifyCredential('someuser/rental-actor')).toEqual({ token: 'apify_api_account', funding: 'platform_key', bearer: 'account' });
  });

  it('runs on the account when the pricing cannot be read, and on the prepaid token when there is no account at all', async () => {
    process.env.APIFY_PLATFORM_TOKEN = 'apify_api_account';
    prepaidMock.mockResolvedValue(PREPAID);
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' })) as unknown as typeof fetch;
    expect(await resolveApifyCredential('someuser/unknown-pricing')).toEqual({ token: 'apify_api_account', funding: 'platform_key', bearer: 'account' });

    delete process.env.APIFY_PLATFORM_TOKEN;
    global.fetch = jest.fn(async () => actorRecord('PAY_PER_EVENT')) as unknown as typeof fetch;
    expect(await resolveApifyCredential('someuser/ppe-only')).toEqual({
      token: 'apify_api_prepaid', funding: 'x402_wallet', bearer: 'prepaid', purchaseId: 'purchase-1', balanceUsd: 8,
    });
  });

  it('falls back to the account once when the vendor refuses a HEALTHY prepaid token before a run exists', async () => {
    process.env.APIFY_PLATFORM_TOKEN = 'apify_api_account';
    prepaidMock.mockResolvedValue(PREPAID);
    const starts: string[] = [];
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
      if (url.endsWith('/acts/someuser~fussy-actor')) return actorRecord('PAY_PER_EVENT');
      if (url.includes('/runs?')) {
        starts.push(auth);
        if (auth.includes('prepaid')) return { ok: false, status: 403, text: async () => JSON.stringify({ error: { type: 'not-eligible', message: 'Actor is not available for prepaid tokens' } }) };
        return { ok: true, status: 201, json: async () => ({ data: { id: 'run-acct', status: 'SUCCEEDED', usageTotalUsd: 0.01 } }) };
      }
      if (url.includes('/dataset/items')) return { ok: true, status: 200, json: async () => [] };
      return { ok: true, status: 200, json: async () => ({ data: { id: 'run-acct', status: 'SUCCEEDED', usageTotalUsd: 0.01 } }) };
    }) as unknown as typeof fetch;

    const run = await runApifyActor('someuser/fussy-actor', {});
    expect(run).toMatchObject({ success: true, runId: 'run-acct', fundingSource: 'platform_key' });
    expect(starts).toEqual(['Bearer apify_api_prepaid', 'Bearer apify_api_account']);
  });

  it('does not fall back on a refusal that is not about the bearer, and never without an account', async () => {
    delete process.env.APIFY_PLATFORM_TOKEN;
    prepaidMock.mockResolvedValue(PREPAID);
    global.fetch = jest.fn(async (url: string) => {
      if (url.endsWith('/acts/someuser~ppe-actor')) return actorRecord('PAY_PER_EVENT');
      return { ok: false, status: 402, text: async () => JSON.stringify({ error: { type: 'payment-required', message: 'balance exhausted' } }) };
    }) as unknown as typeof fetch;
    const run = await runApifyActor('someuser/ppe-actor', {});
    expect(run).toMatchObject({ success: false, accountFailure: 'payment' });
    expect((global.fetch as jest.Mock).mock.calls.filter(([u]) => String(u).includes('/runs?'))).toHaveLength(1);
  });
});

// The sequence a refused prepaid start goes through, in order: read the
// token's balance, and only then decide. A 403 is Apify's answer both for a
// spent token and for an actor a token is not sold for, so the status alone
// decides nothing — the night this was written, a healthy Locus-funded token
// with its whole dollar on it sat unused while an overdrawn one was handed
// run after run and every one of them 403'd.
describe('apify-executor — a refused prepaid token, resolved in order', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.APIFY_PLATFORM_TOKEN;
  });

  const SPENT = { id: 'purchase-spent', token: 'apify_api_spent', balanceUsd: 0.12, expiresAt: new Date(Date.now() + 86_400_000) };
  const FRESH = { id: 'purchase-fresh', token: 'apify_api_fresh', balanceUsd: 1, expiresAt: new Date(Date.now() + 86_400_000), fundedBy: 'locus' as const };
  const LOCUS = { id: 'purchase-locus', token: 'apify_api_locus', balanceUsd: 1, expiresAt: new Date(Date.now() + 86_400_000), fundedBy: 'locus' as const };

  function actorRecord(pricingModel: string) {
    return { ok: true, status: 200, json: async () => ({ data: { pricingInfos: [{ pricingModel, startedAt: '2026-01-01T00:00:00Z' }] } }) };
  }

  /** Every start call refuses the named bearers with `status`; anything else
   *  succeeds as a finished run. */
  function vendor(actor: string, refuses: (auth: string) => number | null, starts: string[]) {
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
      if (url.endsWith(`/acts/${actor}`)) return actorRecord('PAY_PER_EVENT');
      if (url.includes('/runs?')) {
        starts.push(`${auth}|${new URL(url).searchParams.get('maxTotalChargeUsd')}`);
        const status = refuses(auth);
        if (status !== null) {
          return { ok: false, status, text: async () => JSON.stringify({ error: { type: 'not-eligible', message: 'Actor is not available for this token' } }) };
        }
        return { ok: true, status: 201, json: async () => ({ data: { id: 'run-1', status: 'SUCCEEDED', usageTotalUsd: 0.01 } }) };
      }
      if (url.includes('/dataset/items')) return { ok: true, status: 200, json: async () => [{ a: 1 }] };
      return { ok: true, status: 200, json: async () => ({ data: { id: 'run-1', status: 'SUCCEEDED', usageTotalUsd: 0.01 } }) };
    }) as unknown as typeof fetch;
  }

  it('a spent token that is refused is refreshed, replaced by another live one, and the run retried once', async () => {
    process.env.APIFY_PLATFORM_TOKEN = 'apify_api_account';
    prepaidMock.mockResolvedValueOnce(SPENT).mockResolvedValue(FRESH);
    // Healthy when the run picked it up, overdrawn by the time the vendor
    // refused it: the refresh after the refusal retires it.
    refreshAnswers({
      'purchase-spent': [{ balanceUsd: 0.12, retired: false }, { balanceUsd: -0.2206, retired: true }],
      'purchase-fresh': [{ balanceUsd: 1, retired: false }],
    });
    const starts: string[] = [];
    vendor('someuser~ppe-actor', (auth) => (auth.includes('spent') ? 403 : null), starts);

    const run = await runApifyActor('someuser/ppe-actor', {});
    expect(refreshMock).toHaveBeenCalledWith('purchase-spent');
    expect(run).toMatchObject({ success: true, runId: 'run-1', fundingSource: 'platform_key' });
    expect(starts.map((s) => s.split('|')[0])).toEqual(['Bearer apify_api_spent', 'Bearer apify_api_fresh']);
    // Another live token was already there, so nothing was bought.
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it('a spent token with no live replacement is replaced by one bought through Locus, and the run retried once', async () => {
    process.env.APIFY_PLATFORM_TOKEN = 'apify_api_account';
    prepaidMock.mockResolvedValueOnce(SPENT).mockResolvedValueOnce(null).mockResolvedValue(LOCUS);
    refreshAnswers({
      'purchase-spent': [{ balanceUsd: 0.12, retired: false }, { balanceUsd: 0, retired: true }],
      'purchase-locus': [{ balanceUsd: 1, retired: false }],
    });
    ensureMock.mockResolvedValue({ purchased: true });
    const starts: string[] = [];
    vendor('someuser~ppe-actor', (auth) => (auth.includes('spent') ? 403 : null), starts);

    const run = await runApifyActor('someuser/ppe-actor', {});
    expect(ensureMock).toHaveBeenCalledTimes(1);
    expect(run).toMatchObject({ success: true, runId: 'run-1' });
    expect(starts.map((s) => s.split('|')[0])).toEqual(['Bearer apify_api_spent', 'Bearer apify_api_locus']);
  });

  it('a HEALTHY token refused for one actor is kept, buys nothing, and the run falls through to the account', async () => {
    process.env.APIFY_PLATFORM_TOKEN = 'apify_api_account';
    prepaidMock.mockResolvedValue(FRESH);
    refreshAnswers({ 'purchase-fresh': [{ balanceUsd: 1, retired: false }] });
    const starts: string[] = [];
    vendor('someuser~fussy-actor', (auth) => (auth.includes('fresh') ? 403 : null), starts);

    const run = await runApifyActor('someuser/fussy-actor', {});
    expect(refreshMock).toHaveBeenCalledWith('purchase-fresh');
    expect(ensureMock).not.toHaveBeenCalled();
    expect(run).toMatchObject({ success: true, fundingSource: 'platform_key' });
    expect(starts.map((s) => s.split('|')[0])).toEqual(['Bearer apify_api_fresh', 'Bearer apify_api_account']);
  });

  it('a LOCUS-funded token that is refused follows exactly the same sequence', async () => {
    // The defect: the fallback was keyed on `funding === 'x402_wallet'`, and a
    // Locus-funded token maps to `platform_key`, so a refused one got no
    // balance read, no replacement and no fallback at all.
    process.env.APIFY_PLATFORM_TOKEN = 'apify_api_account';
    prepaidMock.mockResolvedValueOnce(LOCUS).mockResolvedValue(null);
    refreshAnswers({ 'purchase-locus': [{ balanceUsd: 1, retired: false }, { balanceUsd: -0.01, retired: true }] });
    ensureMock.mockResolvedValue({ purchased: false });
    const starts: string[] = [];
    vendor('someuser~ppe-actor', (auth) => (auth.includes('locus') ? 403 : null), starts);

    const run = await runApifyActor('someuser/ppe-actor', {});
    expect(refreshMock).toHaveBeenCalledWith('purchase-locus');
    expect(ensureMock).toHaveBeenCalledTimes(1);
    expect(run).toMatchObject({ success: true });
    expect(starts.map((s) => s.split('|')[0])).toEqual(['Bearer apify_api_locus', 'Bearer apify_api_account']);
  });

  it('with no live prepaid token at all, the run buys one before it touches the platform account', async () => {
    process.env.APIFY_PLATFORM_TOKEN = 'apify_api_account';
    prepaidMock.mockResolvedValueOnce(null).mockResolvedValue(LOCUS);
    ensureMock.mockResolvedValue({ purchased: true });
    const starts: string[] = [];
    vendor('someuser~ppe-actor', () => null, starts);

    const run = await runApifyActor('someuser/ppe-actor', {});
    expect(ensureMock).toHaveBeenCalledTimes(1);
    expect(run).toMatchObject({ success: true });
    expect(starts.map((s) => s.split('|')[0])).toEqual(['Bearer apify_api_locus']);
  });

  it('does not re-attempt a purchase on every run once one has come back empty', async () => {
    // The per-day cap counts purchases MADE, so it bounds nothing when every
    // attempt is refused — and an attempt is a call to connector-service with
    // a ninety-second deadline, on the path of a run somebody is waiting for.
    process.env.APIFY_PLATFORM_TOKEN = 'apify_api_account';
    prepaidMock.mockResolvedValue(null);
    ensureMock.mockResolvedValue({ purchased: false });
    const starts: string[] = [];
    vendor('someuser~ppe-actor', () => null, starts);

    await runApifyActor('someuser/ppe-actor', {});
    await runApifyActor('someuser/ppe-actor', {});
    await runApifyActor('someuser/ppe-actor', {});
    expect(ensureMock).toHaveBeenCalledTimes(1);
    // Every run still happened, on the account.
    expect(starts.map((s) => s.split('|')[0])).toEqual(Array(3).fill('Bearer apify_api_account'));
  });

  it('reads the balance at SELECTION, and never hands a run a token the vendor says is spent', async () => {
    // The row said $0.122 while the vendor said -$0.2206. A run capped at a
    // stored figure is capped at a number nobody stands behind, so the
    // balance the cap is taken from is read before the run, not after it.
    process.env.APIFY_PLATFORM_TOKEN = 'apify_api_account';
    prepaidMock.mockResolvedValueOnce(SPENT).mockResolvedValue(FRESH);
    refreshAnswers({
      'purchase-spent': [{ balanceUsd: -0.2206, retired: true }],
      'purchase-fresh': [{ balanceUsd: 0.4, retired: false }],
    });
    const starts: string[] = [];
    vendor('someuser~ppe-actor', () => null, starts);

    const run = await runApifyActor('someuser/ppe-actor', {});
    expect(run).toMatchObject({ success: true });
    // The spent token never reached a start call, and the one that did was
    // capped at what the VENDOR just said it had left.
    expect(starts).toEqual(['Bearer apify_api_fresh|0.4']);
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it('walks past a token the vendor has just retired rather than falling to the account', async () => {
    process.env.APIFY_PLATFORM_TOKEN = 'apify_api_account';
    prepaidMock.mockResolvedValue(SPENT);
    refreshAnswers({ 'purchase-spent': [{ balanceUsd: 0, retired: true }] });
    ensureMock.mockResolvedValue({ purchased: false });
    const starts: string[] = [];
    vendor('someuser~ppe-actor', () => null, starts);

    // Every live token reads as spent, so there is none: a purchase is tried,
    // and with nothing bought the account takes the run.
    const run = await runApifyActor('someuser/ppe-actor', {});
    expect(run).toMatchObject({ success: true });
    expect(ensureMock).toHaveBeenCalledTimes(1);
    expect(starts.map((s) => s.split('|')[0])).toEqual(['Bearer apify_api_account']);
  });

  it('buys nothing for an actor a prepaid token could never run', async () => {
    // Apify honours a prepaid token for pay-per-event actors alone. Buying
    // one for a rental actor puts a dollar of Locus credit in an account this
    // run cannot use, and the run goes to the platform account regardless.
    process.env.APIFY_PLATFORM_TOKEN = 'apify_api_account';
    prepaidMock.mockResolvedValue(null);
    const starts: string[] = [];
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
      if (url.endsWith('/acts/someuser~rental-actor')) {
        return { ok: true, status: 200, json: async () => ({ data: { pricingInfos: [{ pricingModel: 'FLAT_PRICE_PER_MONTH' }] } }) };
      }
      if (url.includes('/runs?')) {
        starts.push(auth);
        return { ok: true, status: 201, json: async () => ({ data: { id: 'run-r', status: 'SUCCEEDED', usageTotalUsd: 0.01 } }) };
      }
      if (url.includes('/dataset/items')) return { ok: true, status: 200, json: async () => [{ a: 1 }] };
      return { ok: true, status: 200, json: async () => ({ data: { id: 'run-r', status: 'SUCCEEDED', usageTotalUsd: 0.01 } }) };
    }) as unknown as typeof fetch;

    const run = await runApifyActor('someuser/rental-actor', {});
    expect(run).toMatchObject({ success: true, fundingSource: 'platform_key' });
    expect(ensureMock).not.toHaveBeenCalled();
    expect(starts).toEqual(['Bearer apify_api_account']);
  });

  it('re-reads the token balance BEFORE the call returns, on the success path', async () => {
    // A `setTimeout(…, 120s).unref()` never fires on Cloud Run: CPU is
    // throttled between requests and the timer holds nothing open. The row
    // would keep the pre-run balance, with no write and no failure logged,
    // because the callback never runs.
    process.env.APIFY_PLATFORM_TOKEN = 'apify_api_account';
    prepaidMock.mockResolvedValue(FRESH);
    refreshAnswers({ 'purchase-fresh': [{ balanceUsd: 1, retired: false }, { balanceUsd: 0.63, retired: false }] });
    const starts: string[] = [];
    vendor('someuser~ppe-actor', () => null, starts);

    const run = await runApifyActor('someuser/ppe-actor', {});
    expect(run).toMatchObject({ success: true });
    // Twice: once choosing the token, once settling what the run drew — and
    // the second has already happened by the time the result is handed back.
    expect(refreshMock.mock.calls.filter(([id]) => id === 'purchase-fresh')).toHaveLength(2);
  });

  it('re-reads the token balance on a run that STARTED and then failed — it was charged too', async () => {
    process.env.APIFY_PLATFORM_TOKEN = 'apify_api_account';
    prepaidMock.mockResolvedValue(FRESH);
    refreshAnswers({ 'purchase-fresh': [{ balanceUsd: 1, retired: false }, { balanceUsd: 0.98, retired: false }] });
    global.fetch = jest.fn(async (url: string) => {
      if (url.endsWith('/acts/someuser~ppe-actor')) {
        return { ok: true, status: 200, json: async () => ({ data: { pricingInfos: [{ pricingModel: 'PAY_PER_EVENT' }] } }) };
      }
      if (url.includes('/runs?')) {
        return { ok: true, status: 201, json: async () => ({ data: { id: 'run-f', status: 'FAILED', statusMessage: 'Actor crashed', usageTotalUsd: 0.0007 } }) };
      }
      return { ok: false, status: 500, text: async () => '' };
    }) as unknown as typeof fetch;

    const run = await runApifyActor('someuser/ppe-actor', {});
    expect(run).toMatchObject({ success: false, runId: 'run-f', costUsd: 0.0007 });
    expect(refreshMock.mock.calls.filter(([id]) => id === 'purchase-fresh')).toHaveLength(2);
  });

  it('a balance read that throws on the way out never fails the run', async () => {
    process.env.APIFY_PLATFORM_TOKEN = 'apify_api_account';
    prepaidMock.mockResolvedValue(FRESH);
    let call = 0;
    refreshMock.mockImplementation(async () => {
      call += 1;
      if (call > 1) throw new Error('vendor unreachable');
      return { balanceUsd: 1, retired: false };
    });
    const starts: string[] = [];
    vendor('someuser~ppe-actor', () => null, starts);

    await expect(runApifyActor('someuser/ppe-actor', {})).resolves.toMatchObject({ success: true, runId: 'run-1' });
  });

  it('never lets a run charge more than the prepaid token has left', async () => {
    // Apify does NOT stop a run at the token's balance: token 025902aa went to
    // -0.2206 against a dollar. The per-run cap is the only thing that does.
    process.env.APIFY_PLATFORM_TOKEN = 'apify_api_account';
    prepaidMock.mockResolvedValue({ ...FRESH, balanceUsd: 0.37 });
    const starts: string[] = [];
    vendor('someuser~ppe-actor', () => null, starts);
    await runApifyActor('someuser/ppe-actor', {});
    expect(starts).toEqual(['Bearer apify_api_fresh|0.37']);

    // The per-run cap still stands over a fat token.
    starts.length = 0;
    prepaidMock.mockResolvedValue({ ...FRESH, balanceUsd: 8 });
    await runApifyActor('someuser/ppe-actor', {});
    expect(starts).toEqual(['Bearer apify_api_fresh|1']);
  });
});

// The platform account's monthly hard limit is the account's alone. Parking
// `internal:apify` for it would stop every platform Apify rung — including the
// prepaid tokens, which are separate accounts with money still on them.
describe('apify-executor — the platform account parks on its own', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.APIFY_PLATFORM_TOKEN;
  });

  const MONTHLY_LIMIT = JSON.stringify({ error: { type: 'platform-feature-disabled', message: 'Monthly usage hard limit exceeded' } });
  /** The cycle end the vendor names, RELATIVE to now.
   *
   *  This was the fixed string '2026-10-01T23:59:59.999Z', which is a date that
   *  arrives. Once it passed, `untilCycleEnd` went negative, production
   *  correctly took its fallback window, and the assertion below — which
   *  expects the park to run to the cycle end — failed for everyone, blocking
   *  every deploy of this service for a reason unrelated to any change in it.
   *
   *  Six hours out keeps it comfortably inside `PLATFORM_LIMIT_PARK_MAX_MS` so
   *  the `min()` does not clamp it, which is what makes the assertion about the
   *  VENDOR'S cycle rather than about our ceiling. */
  const CYCLE_END = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

  function accountRefusesWithItsLimit(starts: string[]) {
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
      if (url.endsWith('/users/me/limits')) {
        return { ok: true, status: 200, json: async () => ({ data: { monthlyUsageCycle: { startAt: '2026-09-01T00:00:00.000Z', endAt: CYCLE_END } } }) };
      }
      if (url.includes('/acts/') && !url.includes('/runs?')) {
        return { ok: true, status: 200, json: async () => ({ data: { pricingInfos: [{ pricingModel: 'PAY_PER_EVENT' }] } }) };
      }
      if (url.includes('/runs?')) {
        starts.push(auth);
        if (auth.includes('account')) return { ok: false, status: 403, text: async () => MONTHLY_LIMIT };
        return { ok: true, status: 201, json: async () => ({ data: { id: 'run-p', status: 'SUCCEEDED', usageTotalUsd: 0.01 } }) };
      }
      if (url.includes('/dataset/items')) return { ok: true, status: 200, json: async () => [{ a: 1 }] };
      return { ok: true, status: 200, json: async () => ({ data: { id: 'run-p', status: 'SUCCEEDED', usageTotalUsd: 0.01 } }) };
    }) as unknown as typeof fetch;
  }

  it('parks the ACCOUNT under its own key until the usage cycle ends, and the next call does not try it', async () => {
    process.env.APIFY_PLATFORM_TOKEN = 'apify_api_account';
    const starts: string[] = [];
    accountRefusesWithItsLimit(starts);

    const run = await runApifyActor('someuser/any-actor', {});
    expect(run.success).toBe(false);
    // Not an account failure on the wire: that would park `internal:apify`
    // and take the prepaid tokens with it.
    expect(run.accountFailure).toBeUndefined();
    expect(parkMock).toHaveBeenCalledTimes(1);
    const parked = parkMock.mock.calls[0][0];
    expect(parked).toMatchObject({ credentialRef: 'internal:apify:platform-account', connectorType: 'apify', tenantId: null, reason: 'payment' });
    // Until the end of the cycle the vendor named, not a fixed window.
    expect(Date.now() + parked.durationMs).toBeCloseTo(Date.parse(CYCLE_END), -4);

    starts.length = 0;
    const next = await runApifyActor('someuser/any-actor', {});
    expect(next.success).toBe(false);
    expect(starts).toEqual([]);
  });

  it('does NOT park the account on a 401 or a 402 — those are the whole route\'s to park, and the executor says so on the wire', async () => {
    // The two statuses that mean the credential is dead are reported as an
    // `accountFailure` and parked by the caller under `internal:apify`. Only
    // the monthly-limit 403 parks here, and only the account's own key.
    process.env.APIFY_PLATFORM_TOKEN = 'apify_api_account';
    for (const [status, failure] of [[401, 'auth'], [402, 'payment']] as const) {
      parkMock.mockClear();
      global.fetch = jest.fn(async () => ({
        ok: false, status, text: async () => JSON.stringify({ error: { type: 'x', message: 'no' } }),
      })) as unknown as typeof fetch;
      const run = await runApifyActor('someuser/any-actor', {});
      expect(run).toMatchObject({ success: false, accountFailure: failure });
      expect(parkMock).not.toHaveBeenCalled();
    }
  });

  it('keeps using a healthy prepaid token while the account is parked', async () => {
    process.env.APIFY_PLATFORM_TOKEN = 'apify_api_account';
    const starts: string[] = [];
    accountRefusesWithItsLimit(starts);
    await runApifyActor('someuser/any-actor', {});
    expect(parkMock).toHaveBeenCalledTimes(1);

    starts.length = 0;
    prepaidMock.mockResolvedValue({ id: 'purchase-ok', token: 'apify_api_prepaid', balanceUsd: 1, expiresAt: new Date(Date.now() + 86_400_000), fundedBy: 'locus' });
    const run = await runApifyActor('someuser/ppe-actor', {});
    expect(run).toMatchObject({ success: true, runId: 'run-p' });
    expect(starts).toEqual(['Bearer apify_api_prepaid']);
  });
});
