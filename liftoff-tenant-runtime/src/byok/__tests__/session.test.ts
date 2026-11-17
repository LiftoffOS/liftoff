// What the runtime asks the control plane, and what it does with every answer.
//
// The property that matters most is the one that is easiest to lose: EVERY
// failure answers "managed". A control-plane problem must not stop a customer's
// agent from working, and the cost of getting it wrong is that Liftoff pays for
// one turn.

const fetchMock = jest.fn();
jest.mock('../../platform-callback/client', () => ({
  getPlatformCallbackClient: () => ({ fetch: fetchMock }),
}));

const resolveInternalAgentId = jest.fn();
jest.mock('../../agent-lifecycle/resolve-runtime-agent-id', () => ({
  resolveInternalAgentId: (t: string, a: string, c?: string) => resolveInternalAgentId(t, a, c),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { _resetByokSessionMemoForTests, closeByokSession, openByokSession } from '../session';

const TENANT = '11111111-1111-4111-8111-111111111111';
const RUNTIME_AGENT = '33333333-3333-4333-8333-333333333333';
const INTERNAL_AGENT = '22222222-2222-4222-8222-222222222222';

function jsonResponse(body: unknown, ok = true): unknown {
  return { ok, json: async () => body };
}

const INPUT = {
  tenantId: TENANT,
  invocationId: 'inv-1',
  resolvedProvider: 'anthropic',
  resolvedModelId: 'claude-sonnet-5',
  call: { callKind: 'agent_invocation' as const },
  runtimeAgentId: RUNTIME_AGENT,
};

beforeEach(() => {
  jest.clearAllMocks();
  _resetByokSessionMemoForTests();
  resolveInternalAgentId.mockResolvedValue(INTERNAL_AGENT);
});

describe('openByokSession', () => {
  it('returns the credential when the control plane says the customer key funds this run', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      mode: 'byok',
      vendor: 'anthropic',
      baseUrl: 'https://api-dev.example.com/byok/anthropic',
      token: 'liftoff_byok_x_y',
      rerouteToVendorApi: false,
    }));

    expect(await openByokSession(INPUT)).toEqual({
      mode: 'byok',
      vendor: 'anthropic',
      baseUrl: 'https://api-dev.example.com/byok/anthropic',
      token: 'liftoff_byok_x_y',
      rerouteToVendorApi: false,
    });
  });

  it('bounds the call, because every run waits for the answer', async () => {
    // The platform-callback client is built without a CallPolicy, so `timeoutMs`
    // does not apply and only the breaker holds this — which opens after failures
    // and does nothing about a single request that hangs. Omitting a timeout is
    // free on a path whose failure is free; this one is on the critical path of
    // every turn, where a hung control plane would STALL runs rather than degrade
    // them. Degrading is the whole design.
    fetchMock.mockResolvedValue(jsonResponse({ mode: 'managed', reason: 'no_key' }));
    await openByokSession(INPUT);
    expect(fetchMock.mock.calls[0][2].signal).toBeInstanceOf(AbortSignal);
  });

  it('sends the CONTROL-PLANE agent id, never the runtime one', async () => {
    // The two id spaces are disjoint and a wrong-space id matches zero rows
    // with no error, so the translation happens here rather than at each caller.
    fetchMock.mockResolvedValue(jsonResponse({ mode: 'managed', reason: 'no_key' }));
    await openByokSession(INPUT);

    const body = JSON.parse(fetchMock.mock.calls[0][2].body as string);
    expect(body.agentId).toBe(INTERNAL_AGENT);
    expect(body.agentId).not.toBe(RUNTIME_AGENT);
    expect(body.source).toBe('tenant_runtime');
    // A closed vocabulary the control plane validates, never a purpose string
    // the two repos have to keep identical by hand.
    expect(body.callKind).toBe('agent_invocation');
    expect(body).not.toHaveProperty('purpose');
  });

  it('still opens the session when the agent id cannot be translated', async () => {
    // A mapping miss costs a reporting label. Losing the run's funding over it
    // would be a much worse trade.
    resolveInternalAgentId.mockResolvedValue(null);
    fetchMock.mockResolvedValue(jsonResponse({
      mode: 'byok', vendor: 'anthropic', baseUrl: 'https://x/byok/anthropic', token: 't',
    }));
    expect(await openByokSession(INPUT)).not.toBeNull();
  });

  it('answers managed when the control plane says so', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ mode: 'managed', reason: 'purpose_not_eligible' }));
    expect(await openByokSession(INPUT)).toBeNull();
  });

  it('answers managed on a non-OK response', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });
    expect(await openByokSession(INPUT)).toBeNull();
  });

  it('answers managed when the callback throws', async () => {
    fetchMock.mockRejectedValue(new Error('breaker open'));
    expect(await openByokSession(INPUT)).toBeNull();
  });

  it('answers managed on a byok response missing any of the three fields', async () => {
    // A partial credential is not a credential. Using one would fail the turn
    // rather than fund it.
    const partials = [
      { mode: 'byok', baseUrl: 'https://x', token: 't' },
      { mode: 'byok', vendor: 'anthropic', token: 't' },
      { mode: 'byok', vendor: 'anthropic', baseUrl: 'https://x' },
    ];
    for (const [i, partial] of partials.entries()) {
      fetchMock.mockResolvedValue(jsonResponse(partial));
      // A distinct run per case: a partial answer is NOT memoized (it is a
      // malformed response, not a decision), but sharing a run would let the
      // previous case's memo answer this one and hide that.
      expect(await openByokSession({ ...INPUT, invocationId: `inv-partial-${i}` })).toBeNull();
    }
  });

  it('carries the reroute flag through, because it changes which adapter runs', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      mode: 'byok', vendor: 'xai', baseUrl: 'https://x/byok/xai', token: 't',
      rerouteToVendorApi: true,
    }));
    const session = await openByokSession({ ...INPUT, resolvedProvider: 'openrouter' });
    expect(session?.rerouteToVendorApi).toBe(true);
  });
});

describe('a managed session is only given to a caller that asked for one', () => {
  // A MANAGED SESSION IS NOT ABOUT WHO PAYS — Liftoff pays either way. It is
  // about what can be seen: two of the engines here publish a summary that cannot
  // be priced from.
  //
  // The opt-in exists because a managed session is also the one way this could
  // COST a customer money. A run holds more than one session under one invocation
  // id, and the ledger reads "was this run customer-funded?" off the gateway's
  // rows, so only the paths that need the capture ask for one.
  const MANAGED_GATEWAY = {
    mode: 'managed_gateway',
    vendor: 'anthropic',
    baseUrl: 'https://api-dev.example.com/byok/anthropic',
    token: 'liftoff_byok_managed',
    rerouteToVendorApi: false,
    reason: 'purpose_not_eligible',
  };

  it('says so ON THE WIRE, so the control plane mints nothing nobody will use', async () => {
    // A token is a row. Letting the control plane decide for every caller would
    // put an insert on the hot path of every LLM call this runtime makes.
    //
    // The field's DEFAULT is the safety: absent means false on both sides, so a
    // rename drifts toward "no capture" rather than toward a managed credential
    // reaching a path that must not have one.
    fetchMock.mockResolvedValue(jsonResponse({ mode: 'managed', reason: 'no_key' }));
    await openByokSession(INPUT);
    expect(JSON.parse(fetchMock.mock.calls[0][2].body as string).acceptManagedGateway).toBe(false);

    fetchMock.mockClear();
    _resetByokSessionMemoForTests();
    await openByokSession({ ...INPUT, acceptManagedGateway: true });
    expect(JSON.parse(fetchMock.mock.calls[0][2].body as string).acceptManagedGateway).toBe(true);
  });

  it('is a credential for a caller that opted in', async () => {
    fetchMock.mockResolvedValue(jsonResponse(MANAGED_GATEWAY));
    expect(await openByokSession({ ...INPUT, acceptManagedGateway: true })).toEqual({
      mode: 'managed_gateway',
      vendor: 'anthropic',
      baseUrl: 'https://api-dev.example.com/byok/anthropic',
      token: 'liftoff_byok_managed',
      rerouteToVendorApi: false,
    });
  });

  it('is NULL for a caller that did not', async () => {
    // Every existing caller. An in-process SDK call already reads the vendor's
    // own response correctly, so routing it through an extra HTTP hop would buy
    // latency and a failure mode; and a coding session's rows landing under the
    // outer run's id is how the outer run's funding answer flips.
    fetchMock.mockResolvedValue(jsonResponse(MANAGED_GATEWAY));
    expect(await openByokSession(INPUT)).toBeNull();
  });

  it('does not let one caller memo answer the other', async () => {
    // Both callers can agree on tenant, run, provider, model and purpose and
    // disagree on the opt-in. Keyed without it, whichever ran first would decide
    // for both — either handing a managed credential to a path that must not have
    // one, or denying the turn the capture it asked for.
    fetchMock.mockResolvedValue(jsonResponse(MANAGED_GATEWAY));
    expect(await openByokSession(INPUT)).toBeNull();
    expect(await openByokSession({ ...INPUT, acceptManagedGateway: true })).not.toBeNull();
  });

  it('still answers null when the control plane says plain managed', async () => {
    // No token, no base URL: the door could not open (no managed substitution for
    // that vendor) and the run keeps its direct path.
    fetchMock.mockResolvedValue(jsonResponse({ mode: 'managed', reason: 'no_key' }));
    expect(await openByokSession({ ...INPUT, acceptManagedGateway: true })).toBeNull();
  });

  it('carries the openrouter vendor, which no customer key can fund', async () => {
    // The door with no customer-funded side at all. It exists so the open-weights
    // families have somewhere for their reasoning tokens to be read off the wire.
    fetchMock.mockResolvedValue(jsonResponse({
      mode: 'managed_gateway',
      vendor: 'openrouter',
      baseUrl: 'https://api-dev.example.com/byok/openrouter',
      token: 't',
      rerouteToVendorApi: false,
    }));
    const session = await openByokSession({
      ...INPUT, resolvedProvider: 'glm', resolvedModelId: 'z-ai/glm-5.3',
      acceptManagedGateway: true,
    });
    expect(session).toMatchObject({ mode: 'managed_gateway', vendor: 'openrouter' });
  });
});

describe('a managed Gemini session is refused on an endpoint we do not price', () => {
  // Google charges about 10% more for the GA Gemini 3 families outside the global
  // endpoint, and this repo's rate table is written for global. The gateway
  // resolves its own managed location from the CONTROL PLANE's environment, so a
  // variable set over there moves the endpoint while the table keeps pricing it
  // here — a silent under-charge on every Gemini turn, discoverable only by
  // reconciling an invoice by hand.
  //
  // Declining costs the capture on those turns and nothing else: the run keeps the
  // ADC path it has always used.
  const GOOGLE = {
    mode: 'managed_gateway',
    vendor: 'google',
    baseUrl: 'https://api-dev.example.com/byok/google',
    token: 'liftoff_byok_managed',
    rerouteToVendorApi: false,
  };
  const INPUT_GOOGLE = {
    ...INPUT,
    resolvedProvider: 'google',
    resolvedModelId: 'gemini-3.5-flash',
    acceptManagedGateway: true,
  };

  it('accepts the global endpoint, which is what the table prices', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      ...GOOGLE, vertex: { project: 'YOUR_CONTROL_PROJECT_STAGING', location: 'global' },
    }));
    expect(await openByokSession(INPUT_GOOGLE)).toMatchObject({
      vendor: 'google', mode: 'managed_gateway',
    });
  });

  it('REFUSES a regional endpoint, whose rates this table does not describe', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      ...GOOGLE, vertex: { project: 'YOUR_CONTROL_PROJECT_STAGING', location: 'us-west1' },
    }));
    expect(await openByokSession(INPUT_GOOGLE)).toBeNull();
  });

  it('REFUSES a session that names no location at all', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ...GOOGLE, vertex: { project: 'p', location: '' } }));
    expect(await openByokSession(INPUT_GOOGLE)).toBeNull();
  });

  it('leaves a CUSTOMER-funded google session alone, wherever their Vertex is', async () => {
    // Their location is theirs to choose, and their calls are zero-rated: the
    // rate table is not what bills them.
    fetchMock.mockResolvedValue(jsonResponse({
      mode: 'byok',
      vendor: 'google',
      baseUrl: 'https://api-dev.example.com/byok/google',
      token: 't',
      rerouteToVendorApi: false,
      vertex: { project: 'customer-prod-1234', location: 'europe-west4' },
    }));
    const session = await openByokSession({ ...INPUT_GOOGLE, acceptManagedGateway: false });
    expect(session).toMatchObject({ mode: 'byok', vertex: { location: 'europe-west4' } });
  });

  it('does not constrain any other vendor', async () => {
    // The guard is about one rate table's one endpoint claim. Anthropic, OpenAI,
    // xAI and OpenRouter carry no location at all.
    fetchMock.mockResolvedValue(jsonResponse({
      mode: 'managed_gateway',
      vendor: 'anthropic',
      baseUrl: 'https://api-dev.example.com/byok/anthropic',
      token: 't',
      rerouteToVendorApi: false,
    }));
    expect(await openByokSession({ ...INPUT, acceptManagedGateway: true })).not.toBeNull();
  });
});

describe('the memo', () => {
  it('asks the control plane once per run, provider and purpose', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ mode: 'managed', reason: 'no_key' }));
    await openByokSession(INPUT);
    await openByokSession(INPUT);
    await openByokSession(INPUT);
    // The negative answer is the one worth caching: it is what a workspace with
    // no keys gets on every LLM call it makes, forever.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks again for a different call kind or purpose, which can change the answer', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ mode: 'managed', reason: 'purpose_not_eligible' }));
    await openByokSession(INPUT);
    await openByokSession({ ...INPUT, call: { callKind: 'llm_call', purpose: 'history-compaction' } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('forgets a run when its session is closed, so a revoked token is not reused', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      mode: 'byok', vendor: 'anthropic', baseUrl: 'https://x/byok/anthropic', token: 't',
    }));
    await openByokSession(INPUT);
    await closeByokSession(TENANT, INPUT.invocationId);
    await openByokSession(INPUT);
    // Two opens, plus the close.
    expect(fetchMock.mock.calls.filter((c) => c[1] === '/api/internal/byok/session')).toHaveLength(2);
  });
});

describe('closeByokSession', () => {
  it('asks the control plane to revoke the run tokens', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ revoked: 1 }));
    await closeByokSession(TENANT, 'inv-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'platform',
      '/api/internal/byok/session/close',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('never throws — the token expires on its own', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    await expect(closeByokSession(TENANT, 'inv-1')).resolves.toBeUndefined();
  });
});
