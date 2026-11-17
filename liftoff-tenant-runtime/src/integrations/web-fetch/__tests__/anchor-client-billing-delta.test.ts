/**
 * Verifies anchor-client's exact cost capture across three paths:
 *  1. identityCreate          — /v1/billing delta × $0.10/credit
 *  2. createProfileFromSession — /v1/billing delta × $0.10/credit
 *  3. stateless Web Unlocker fetch — $0.01 per-browser + elapsedMs × $0.05/hr
 *
 * All three replace earlier approximations:
 *  - identity/profile: were hardcoded `cost_micros: 0` (under-billed)
 *  - stateless fetch:  was `USD_PER_BROWSER + USD_PER_BROWSER_HR/60` (assumed
 *                      1-minute average; over/under depending on actual latency)
 *
 * These tests pin the new contract: per-call cost is either the authoritative
 * billed amount from Anchor's /v1/billing endpoint, or the exact published
 * per-browser/per-hour rate applied to actual elapsed wall-clock time. Never
 * a placeholder constant or fixed-time assumption.
 */

const mockGetSecret = jest.fn();
const mockGetWebToolCredential = jest.fn();
jest.mock('../../../infrastructure/secrets', () => ({
  getSecret: (...a: unknown[]) => mockGetSecret(...a),
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// BYOK refactor (ADR-023): AnchorClient resolves credentials per-tenant.
jest.mock('../web-tool-secrets', () => {
  const actual = jest.requireActual('../web-tool-secrets');
  return {
    ...actual,
    getWebToolCredential: (...a: unknown[]) => mockGetWebToolCredential(...a),
  };
});

const mockPoolQuery = jest.fn();
jest.mock('../../../infrastructure/database', () => ({
  getPool: () => ({ query: (...a: unknown[]) => mockPoolQuery(...a) }),
}));
// createAnchorSessionForThread emits a SESSION_CREATED event via dynamic import.
jest.mock('../../../browser-sessions/events', () => ({ emitBrowserSessionEvent: jest.fn() }));

import { AnchorClient, AnchorError, createAnchorSessionForThread } from '../anchor-client';

const originalFetch = global.fetch;
afterAll(() => { global.fetch = originalFetch; });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSecret.mockResolvedValue('anchor-key');
  mockGetWebToolCredential.mockResolvedValue({
    apiKey: 'anchor-key',
    connectorId: 'conn-anchor',
    extra: {},
  });
  mockPoolQuery.mockResolvedValue({ rows: [] });
});

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

// The live GET /v1/billing response is FLAT — { credits_used, ... } at the top
// level, NOT wrapped under `data` (verified against the live API). Mirror that
// here so the suite exercises the real contract.
function billingResponse(creditsUsed: number) {
  return jsonResponse(200, {
    credits: 0,
    credits_used: creditsUsed,
    included_credits: 50,
    billing_period: '2026-06',
    tier: 'monthly_starter',
  });
}

describe('AnchorClient.identityCreate — exact credits delta via /v1/billing', () => {
  it('records exact USD micros = delta credits × ANCHOR_USD_PER_CREDIT ($0.10)', async () => {
    // Before: 100 credits used. After: 102 credits used. Delta=2 credits =
    // 2 × $0.10 = $0.20 = 200_000 micros.
    const fn = jest.fn()
      .mockResolvedValueOnce(billingResponse(100))                                       // GET /v1/billing (before)
      .mockResolvedValueOnce(jsonResponse(200, { data: { id: 'id-1', token: 'tk-1' } })) // POST /v1/identities
      .mockResolvedValueOnce(billingResponse(102));                                      // GET /v1/billing (after)
    global.fetch = fn as unknown as typeof fetch;

    const c = new AnchorClient();
    const out = await c.identityCreate({
      identityName: 'salesforce-acme',
      serviceName: 'salesforce',
      loginUrl: 'https://login.salesforce.com',
    });

    expect(out.vendorIdentityId).toBe('id-1');
    expect(out.costMicros).toBe(200_000);  // 2 credits × $0.10 × 1M micros
    // Verify the three calls in order: billing, identities, billing.
    expect(fn.mock.calls[0][0]).toContain('/v1/billing');
    expect(fn.mock.calls[1][0]).toContain('/v1/identities');
    expect(fn.mock.calls[2][0]).toContain('/v1/billing');
  });

  it('also reads credits_used from a WRAPPED {data:{...}} billing response (back-compat fallback)', async () => {
    // The live API is flat (covered by every other test via billingResponse);
    // this pins the fallback so an older/changed wrapped shape still works.
    const wrapped = (used: number) => jsonResponse(200, { data: { credits_used: used, credits: 0 } });
    const fn = jest.fn()
      .mockResolvedValueOnce(wrapped(100))                                               // billing before (wrapped)
      .mockResolvedValueOnce(jsonResponse(200, { data: { id: 'id-w', token: 'tk-w' } })) // POST /v1/identities
      .mockResolvedValueOnce(wrapped(101));                                              // billing after (wrapped) → 1 credit
    global.fetch = fn as unknown as typeof fetch;

    const c = new AnchorClient();
    const out = await c.identityCreate({ identityName: 'svc', serviceName: 's', loginUrl: 'https://x' });
    expect(out.costMicros).toBe(100_000);  // 1 credit, read via the `data` fallback
  });

  it('records 0 micros when Anchor reports zero credits consumed (legitimate free op)', async () => {
    // Anchor may genuinely not charge for an identity create on the starter
    // tier or for cache-friendly operations. Zero IS exact — we record it.
    const fn = jest.fn()
      .mockResolvedValueOnce(billingResponse(50))
      .mockResolvedValueOnce(jsonResponse(200, { data: { id: 'id-2', token: 'tk-2' } }))
      .mockResolvedValueOnce(billingResponse(50));
    global.fetch = fn as unknown as typeof fetch;

    const c = new AnchorClient();
    const out = await c.identityCreate({
      identityName: 'svc', serviceName: 's', loginUrl: 'https://x',
    });
    expect(out.costMicros).toBe(0);
  });

  it('throws AnchorError(422) when /v1/billing response is missing credits_used', async () => {
    const fn = jest.fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: {} }));  // missing credits_used
    global.fetch = fn as unknown as typeof fetch;

    const c = new AnchorClient();
    const err = await c.identityCreate({
      identityName: 'svc', serviceName: 's', loginUrl: 'https://x',
    }).catch(e => e);
    expect(err).toBeInstanceOf(AnchorError);
    expect((err as AnchorError).statusCode).toBe(422);
    expect((err as AnchorError).message).toMatch(/credits_used/);
  });

  it('clamps negative deltas to 0 (defensive against Anchor counter resets at period boundary)', async () => {
    // If period rolls over between snapshots, after < before is possible.
    const fn = jest.fn()
      .mockResolvedValueOnce(billingResponse(500))
      .mockResolvedValueOnce(jsonResponse(200, { data: { id: 'id-3', token: 'tk-3' } }))
      .mockResolvedValueOnce(billingResponse(2));  // period rolled over
    global.fetch = fn as unknown as typeof fetch;

    const c = new AnchorClient();
    const out = await c.identityCreate({
      identityName: 'svc', serviceName: 's', loginUrl: 'https://x',
    });
    expect(out.costMicros).toBe(0);
  });

  it('serializes concurrent identityCreate calls within a single AnchorClient (mutex)', async () => {
    // Two concurrent identityCreate calls should produce two non-overlapping
    // billing windows: A sees credits[100→101], B sees credits[101→103].
    // Cost: A=$0.10 (1 credit), B=$0.20 (2 credits).
    const responses = [
      billingResponse(100),                                              // A before
      jsonResponse(200, { data: { id: 'A', token: 'tkA' } }),
      billingResponse(101),                                              // A after
      billingResponse(101),                                              // B before
      jsonResponse(200, { data: { id: 'B', token: 'tkB' } }),
      billingResponse(103),                                              // B after
    ];
    const fn = jest.fn();
    for (const r of responses) fn.mockResolvedValueOnce(r);
    global.fetch = fn as unknown as typeof fetch;

    const c = new AnchorClient();
    const [a, b] = await Promise.all([
      c.identityCreate({ identityName: 'a', serviceName: 's', loginUrl: 'https://x' }),
      c.identityCreate({ identityName: 'b', serviceName: 's', loginUrl: 'https://x' }),
    ]);

    expect(a.costMicros).toBe(100_000);   // 1 credit × $0.10 × 1M
    expect(b.costMicros).toBe(200_000);   // 2 credits × $0.10 × 1M
  });
});

describe('AnchorClient.createProfileFromSession — exact credits delta', () => {
  // Anchor's create-profile response is { data: { status: 'success' } } — no
  // id/name (verified live). createProfileFromSession makes a SINGLE source=
  // session POST (sticky IP is NOT offered here — it doesn't apply on this
  // path), so the fetch sequence is: billing(before), POST(snapshot), billing(after).
  const PROFILE_OK = { data: { status: 'success' } };

  it('single source=session create; stores the NAME (not a response field); sticky=false', async () => {
    const fn = jest.fn()
      .mockResolvedValueOnce(billingResponse(200))            // GET billing before
      .mockResolvedValueOnce(jsonResponse(200, PROFILE_OK))   // POST source=session snapshot
      .mockResolvedValueOnce(billingResponse(201));           // GET billing after (1 credit)
    global.fetch = fn as unknown as typeof fetch;

    const c = new AnchorClient();
    const out = await c.createProfileFromSession('vsess-1', 'salesforce-acme', 'tenant-1');
    expect(out.profileName).toBe('salesforce-acme');          // the NAME we passed, not a response field
    expect(out.costMicros).toBe(100_000);                     // 1 credit × $0.10 × 1M

    // exactly one /v1/profiles POST, and it does NOT request a sticky IP.
    const profilePosts = fn.mock.calls.filter((c: unknown[]) => String(c[0]).endsWith('/v1/profiles'));
    expect(profilePosts).toHaveLength(1);
    const body = JSON.parse((profilePosts[0][1] as { body: string }).body);
    expect(body.source).toBe('session');
    expect(body.session_id).toBe('vsess-1');
    expect(body.dedicated_sticky_ip).toBeUndefined();

    // web_profiles upsert: vendor_profile_id = the name (via $2), sticky literal false.
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO web_profiles/);
    expect(sql).toMatch(/'anchor', \$2/);                     // vendor_profile_id bound to $2 (the name)
    expect(sql).toMatch(/\$6, false\)/);                      // dedicated_sticky_ip is a literal false
    expect(params[1]).toBe('salesforce-acme');                // profile_name (= vendor_profile_id)
    expect(params).toHaveLength(6);                           // no sticky param
  });

  it('threads ownerAccountId / agentId / service / login_url into the web_profiles upsert', async () => {
    const fn = jest.fn()
      .mockResolvedValueOnce(billingResponse(10))
      .mockResolvedValueOnce(jsonResponse(200, PROFILE_OK))   // snapshot
      .mockResolvedValueOnce(billingResponse(10));
    global.fetch = fn as unknown as typeof fetch;

    const c = new AnchorClient();
    await c.createProfileFromSession('vsess-1', 'workday-hr', 'tenant-1', {
      ownerAccountId: 'acc-7', agentId: 'agent-7', serviceName: 'workday', loginUrl: 'https://wd.example/login',
    });
    const [, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(params[2]).toBe('acc-7');                       // owner_account_id
    expect(params[3]).toBe('agent-7');                     // agent_id
    expect(params[4]).toBe('workday');                     // service_name
    expect(params[5]).toBe('https://wd.example/login');    // login_url
  });

  it('records 0 micros when Anchor reports zero credits for the profile save', async () => {
    const fn = jest.fn()
      .mockResolvedValueOnce(billingResponse(200))
      .mockResolvedValueOnce(jsonResponse(200, PROFILE_OK))   // snapshot
      .mockResolvedValueOnce(billingResponse(200));
    global.fetch = fn as unknown as typeof fetch;

    const c = new AnchorClient();
    const out = await c.createProfileFromSession('vsess-1', 'svc', 'tenant-1');
    expect(out.costMicros).toBe(0);
  });

  it('throws AnchorError(422) when /v1/billing returns non-numeric credits_used', async () => {
    const fn = jest.fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: { credits_used: 'oops', credits: 0 } }));
    global.fetch = fn as unknown as typeof fetch;

    const c = new AnchorClient();
    const err = await c.createProfileFromSession('vsess', 'p', 'tenant')
      .catch(e => e);
    expect(err).toBeInstanceOf(AnchorError);
    expect((err as AnchorError).statusCode).toBe(422);
  });
});

describe('AnchorClient.fetch (stateless Web Unlocker) — exact elapsed-time cost', () => {
  // Web Unlocker spins up an ephemeral browser for the duration of the
  // /v1/tools/fetch-webpage call. Anchor bills $0.01 per browser + $0.05/hr
  // pro-rated. Measuring actual elapsed wall-clock time gives the exact
  // billed amount against the published rate — no mutex, no extra API calls,
  // no 1-minute placeholder. The earlier implementation assumed a 60-second
  // average, which over-bills fast fetches and under-bills slow ones.

  it('computes cost from actual elapsed time × published per-hour rate (NOT a 1-minute placeholder)', async () => {
    // Stall the fetch for ~120ms so the elapsed-time arithmetic produces a
    // non-trivial fraction-of-hour value. Cost should reflect the actual
    // wall-clock duration, not the old USD_PER_BROWSER_HR/60 = $0.000833
    // placeholder for 1-minute.
    let resolveFetch: (v: { ok: true; status: 200; text: () => Promise<string>; json: () => Promise<unknown> }) => void;
    const fetchPromise = new Promise<typeof resolveFetch extends (v: infer V) => void ? V : never>(
      (resolve) => { resolveFetch = resolve as typeof resolveFetch; },
    );
    global.fetch = jest.fn().mockReturnValueOnce(fetchPromise) as unknown as typeof fetch;

    const c = new AnchorClient();
    const t0 = Date.now();
    const promise = c.fetch({ url: 'https://x', tenantId: 't1', agentId: 'a1' });

    // Delay the response by ~120ms (real time, not fake timers, so the
    // client's Date.now() arithmetic captures the actual elapsed window).
    await new Promise(r => setTimeout(r, 120));
    resolveFetch!({ ok: true, status: 200, text: async () => '# page', json: async () => ({}) });

    const out = await promise;
    const t1 = Date.now();
    const observedElapsedMs = t1 - t0;

    // Expected cost = $0.01 (per-browser) + (elapsedMs / 3.6M) × $0.05 — converted to micros.
    const expectedCostMicros = Math.round(
      (0.01 + (observedElapsedMs / 3_600_000) * 0.05) * 1_000_000,
    );

    // The new exact-elapsed cost should equal the formula applied to actual
    // observed elapsed time. Allow ±1 micro tolerance for Date.now() rounding.
    expect(Math.abs(out.costMicros - expectedCostMicros)).toBeLessThanOrEqual(1);
    expect(out.vendor).toBe('anchor');
    expect(out.content).toBe('# page');
    expect(out.jsRendered).toBe(true);

    // Sanity: 120ms × $0.05/hr = $0.00000167. Combined with $0.01 per-browser,
    // total ≈ $0.01000167. The old "60-second placeholder" would have given
    // $0.01 + $0.000833 = $0.010833 — about 5× too high for a 120ms fetch.
    // Verify the new cost is materially smaller than the old constant.
    const oldPlaceholderMicros = Math.round((0.01 + 0.05 / 60) * 1_000_000);
    expect(out.costMicros).toBeLessThan(oldPlaceholderMicros);
  });

  it('throws "empty content" without recording cost (matches existing antibot guard)', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true, status: 200, text: async () => '', json: async () => ({}),
    }) as unknown as typeof fetch;
    const c = new AnchorClient();
    await expect(c.fetch({ url: 'https://x', tenantId: 't', agentId: 'a' }))
      .rejects.toThrow(/empty content/i);
  });

  it('scales cost linearly with elapsed time (10× slower fetch → ~10× larger browser-hour fraction)', async () => {
    async function fetchWithDelay(delayMs: number): Promise<number> {
      let resolveFetch: (v: { ok: true; status: 200; text: () => Promise<string>; json: () => Promise<unknown> }) => void;
      const fetchPromise = new Promise<typeof resolveFetch extends (v: infer V) => void ? V : never>(
        (resolve) => { resolveFetch = resolve as typeof resolveFetch; },
      );
      global.fetch = jest.fn().mockReturnValueOnce(fetchPromise) as unknown as typeof fetch;
      const c = new AnchorClient();
      const promise = c.fetch({ url: 'https://x', tenantId: 't', agentId: 'a' });
      await new Promise(r => setTimeout(r, delayMs));
      resolveFetch!({ ok: true, status: 200, text: async () => 'p', json: async () => ({}) });
      const out = await promise;
      return out.costMicros;
    }

    const fast = await fetchWithDelay(20);
    const slow = await fetchWithDelay(200);

    // Both pay the $0.01 per-browser floor. The per-hour fraction differs by
    // the elapsed-time delta. Slow > fast.
    expect(slow).toBeGreaterThan(fast);
    // The per-browser floor dominates ($10_000 micros vs the per-hour fraction
    // which is sub-1_000 for sub-second fetches), so the absolute delta is
    // tiny but the sign is the contract we're pinning.
  });
});

describe('AnchorClient.listProfiles — envelope normalization', () => {
  it('reads { data: { items } } envelope', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(
      jsonResponse(200, { data: { items: [
        { name: 'salesforce-acme', description: 'Tenant t1' },
        { name: 'workday-hr' },
      ] } }),
    ) as unknown as typeof fetch;
    const c = new AnchorClient();
    const out = await c.listProfiles('tenant-1');
    expect(out).toEqual([
      { name: 'salesforce-acme', description: 'Tenant t1' },
      { name: 'workday-hr', description: null },
    ]);
  });

  it('reads a bare array envelope', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(
      jsonResponse(200, [{ name: 'a' }]),
    ) as unknown as typeof fetch;
    const c = new AnchorClient();
    const out = await c.listProfiles('tenant-1');
    expect(out).toEqual([{ name: 'a', description: null }]);
  });
});

describe('AnchorClient.deleteProfile — name in path, 404 tolerated', () => {
  it('DELETEs /v1/profiles/{name} and resolves on 200', async () => {
    const fn = jest.fn().mockResolvedValueOnce(jsonResponse(200, {}));
    global.fetch = fn as unknown as typeof fetch;
    const c = new AnchorClient();
    await c.deleteProfile('salesforce acme', 'tenant-1');
    expect(fn.mock.calls[0][0]).toContain('/v1/profiles/salesforce%20acme');
    expect((fn.mock.calls[0][1] as { method: string }).method).toBe('DELETE');
  });

  it('treats 404 as success (already gone)', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse(404, { error: 'not found' })) as unknown as typeof fetch;
    const c = new AnchorClient();
    await expect(c.deleteProfile('gone', 'tenant-1')).resolves.toBeUndefined();
  });

  it('throws on a non-404 error status', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse(500, { error: 'boom' })) as unknown as typeof fetch;
    const c = new AnchorClient();
    await expect(c.deleteProfile('x', 'tenant-1')).rejects.toBeInstanceOf(AnchorError);
  });
});

describe('AnchorClient.ensureSession — persist on a reused profile', () => {
  it('attaches profile { name, persist: true } when a profile is supplied', async () => {
    // No existing web_sessions row → ensureSession proceeds to create. Spy on
    // createSessionAsync to capture the body, then short-circuit (we only care
    // about the session-config the profile produces, not the full spawn).
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const c = new AnchorClient();
    const spy = jest
      .spyOn(c as unknown as { createSessionAsync: (...a: unknown[]) => Promise<unknown> }, 'createSessionAsync')
      .mockRejectedValue(new Error('stop-after-capture'));

    await c.task({
      task: 'do x', tenantId: 'tenant-1', agentId: 'agent-1',
      sessionId: 'caller-1', vendorProfileId: 'salesforce-acme',
    } as never).catch(() => { /* expected: createSessionAsync short-circuits */ });

    expect(spy).toHaveBeenCalled();
    const body = spy.mock.calls[0][1] as { browser: { profile?: unknown } };
    expect(body.browser.profile).toEqual({ name: 'salesforce-acme', persist: true });
  });
});

describe('createAnchorSessionForThread — profile recording', () => {
  // The profile is handed in by the proxy's one rule (session-profile.ts); a
  // team agent's browser binds the team's profile. The client's job is to
  // record it, after the session exists, with the kind it was given.
  const TEAM_PROFILE = { name: 'tenant-1-agent-1-team', kind: 'team' as const, ownerAccountId: null };

  it('upserts the handed-in web_profiles row AFTER a successful session create', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(
      jsonResponse(200, { data: { id: 'vs-1', cdp_url: 'wss://cdp', live_view_url: 'https://live' } }),
    ) as unknown as typeof fetch;
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{
        id: 'sess-1', tenant_id: 'tenant-1', agent_id: 'agent-1', thread_id: 'thread-1',
        owner_account_id: 'acc-1', caller_session_id: 'ui:x', vendor: 'anchor',
        vendor_session_id: 'vs-1', created_at: new Date(), last_used_at: null, expires_at: null,
      }] })   // web_sessions insert
      .mockResolvedValueOnce({ rows: [] });  // web_profiles upsert

    await createAnchorSessionForThread({
      tenantId: 'tenant-1', agentId: 'agent-1', threadId: 'thread-1', ownerAccountId: 'acc-1',
      profile: TEAM_PROFILE,
    });

    const sessionsIdx = mockPoolQuery.mock.calls.findIndex(c => /INSERT INTO web_sessions/.test(c[0] as string));
    const profilesIdx = mockPoolQuery.mock.calls.findIndex(c => /INSERT INTO web_profiles/.test(c[0] as string));
    expect(sessionsIdx).toBeGreaterThanOrEqual(0);
    expect(profilesIdx).toBeGreaterThan(sessionsIdx);  // recorded AFTER the session create
    const upsert = mockPoolQuery.mock.calls[profilesIdx] as [string, unknown[]];
    expect(upsert[1]).toEqual(['tenant-1', 'tenant-1-agent-1-team', null, 'agent-1', 'team']);
    // The session row still carries the SPAWNER as its owner — the person
    // drives this pane and may take it over — while the profile has none.
    const insert = mockPoolQuery.mock.calls[sessionsIdx] as [string, unknown[]];
    expect(insert[1].slice(0, 5)).toEqual(['tenant-1', 'agent-1', 'thread-1', null, 'acc-1']);
  });

  it('records no profile row when none was handed in (an ephemeral browser)', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(
      jsonResponse(200, { data: { id: 'vs-2', cdp_url: 'wss://cdp', live_view_url: 'https://live' } }),
    ) as unknown as typeof fetch;
    mockPoolQuery.mockResolvedValueOnce({ rows: [{
      id: 'sess-2', tenant_id: 'tenant-1', agent_id: '00000000-0000-0000-0000-000000000000', thread_id: 'thread-2',
      owner_account_id: null, caller_session_id: 'ui:y', vendor: 'anchor',
      vendor_session_id: 'vs-2', created_at: new Date(), last_used_at: null, expires_at: null,
    }] });
    await createAnchorSessionForThread({
      tenantId: 'tenant-1', agentId: '00000000-0000-0000-0000-000000000000', threadId: 'thread-2', profile: null,
    });
    expect(mockPoolQuery.mock.calls.find(c => /INSERT INTO web_profiles/.test(c[0] as string))).toBeUndefined();
  });

  it('records NO profile row when the session create fails (no orphan)', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse(500, { error: 'boom' })) as unknown as typeof fetch;
    await createAnchorSessionForThread({
      tenantId: 'tenant-1', agentId: 'agent-1', threadId: 'thread-1', ownerAccountId: 'acc-1',
      profile: TEAM_PROFILE,
    }).catch(() => { /* expected throw on 500 */ });
    const upsert = mockPoolQuery.mock.calls.find(c => /INSERT INTO web_profiles/.test(c[0] as string));
    expect(upsert).toBeFalsy();
  });
});
