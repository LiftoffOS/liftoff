// Internal LLM Router — unit tests
//
// Tests the /complete endpoint for service auth (timing-safe), token-scope
// enforcement (HARVEST_SERVICE_TOKEN restricted to harvest_classification),
// request validation, and proxy behavior to llmClient.complete.

import express from 'express';

// ── Mocks ─────────────────────────────────────────────────────────────

const mockComplete = jest.fn();
const mockCheckExecutionAllowed = jest.fn();

const mockContextWindowFor = jest.fn(() => 200_000);
// The RECORDED window is a different claim from the number to measure
// against: present only when the registry holds one. These suites run a model
// the registry has sized, so the two agree.
const mockRecordedContextWindowFor = jest.fn(() => 200_000);

jest.mock('../../llm/client', () => ({
  llmClient: {
    complete: mockComplete,
    contextWindowFor: mockContextWindowFor,
    recordedContextWindowFor: mockRecordedContextWindowFor,
  },
}));

jest.mock('../../billing/execution-guard', () => ({
  checkExecutionAllowed: (tenantId: string) => mockCheckExecutionAllowed(tenantId),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { internalLLMRouter } from '../llm-router';

// ── Test app ──────────────────────────────────────────────────────────

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/llm', internalLLMRouter);
  return app;
}

// ── Helpers ───────────────────────────────────────────────────────────

const WORKFORCE_TOKEN = 'workforce-token-test-1234567890ab';
const HARVEST_TOKEN = 'harvest-token-test-1234567890abcd';

function postJson(
  app: express.Express,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          const b = await res.json().catch(() => null);
          server.close();
          resolve({ status: res.status, body: b });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

// ── Setup / Teardown ──────────────────────────────────────────────────

const ORIG_ENV = {
  WORKFORCE_SERVICE_TOKEN: process.env.WORKFORCE_SERVICE_TOKEN,
  CONNECTOR_SERVICE_TOKEN: process.env.CONNECTOR_SERVICE_TOKEN,
  GOVERNANCE_EVAL_SERVICE_TOKEN: process.env.GOVERNANCE_EVAL_SERVICE_TOKEN,
  HARVEST_SERVICE_TOKEN: process.env.HARVEST_SERVICE_TOKEN,
};

function restoreEnv(name: keyof typeof ORIG_ENV): void {
  const v = ORIG_ENV[name];
  if (v === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = v;
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.WORKFORCE_SERVICE_TOKEN = WORKFORCE_TOKEN;
  process.env.HARVEST_SERVICE_TOKEN = HARVEST_TOKEN;
  delete process.env.CONNECTOR_SERVICE_TOKEN;
  delete process.env.GOVERNANCE_EVAL_SERVICE_TOKEN;

  mockComplete.mockResolvedValue({
    content: 'mock response',
    model: 'claude-test',
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5 },
  });

  // Default: tenant is execution-allowed. Suspension tests override this.
  mockCheckExecutionAllowed.mockResolvedValue({ allowed: true });
});

afterEach(() => {
  restoreEnv('WORKFORCE_SERVICE_TOKEN');
  restoreEnv('CONNECTOR_SERVICE_TOKEN');
  restoreEnv('GOVERNANCE_EVAL_SERVICE_TOKEN');
  restoreEnv('HARVEST_SERVICE_TOKEN');
});

// ── Tests ─────────────────────────────────────────────────────────────

describe('POST /api/internal/llm/complete', () => {
  const VALID_BODY = {
    request: {
      messages: [{ role: 'user', content: 'hello' }],
    },
    usageContext: { purpose: 'workforce_chat', tenantId: 't-1' },
  };

  it('returns 401 when X-Service-Auth header is missing', async () => {
    const app = buildApp();
    const res = await postJson(app, '/api/internal/llm/complete', VALID_BODY);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Missing service authentication');
  });

  it('returns 401 when service token is invalid', async () => {
    const app = buildApp();
    const res = await postJson(
      app,
      '/api/internal/llm/complete',
      VALID_BODY,
      { 'X-Service-Auth': 'wrong-token-wrong-token-wrong-tk' },
    );

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid service authentication');
  });

  it('returns 503 when no env tokens are configured', async () => {
    delete process.env.WORKFORCE_SERVICE_TOKEN;
    delete process.env.CONNECTOR_SERVICE_TOKEN;
    delete process.env.GOVERNANCE_EVAL_SERVICE_TOKEN;
    delete process.env.HARVEST_SERVICE_TOKEN;

    const app = buildApp();
    const res = await postJson(
      app,
      '/api/internal/llm/complete',
      VALID_BODY,
      { 'X-Service-Auth': WORKFORCE_TOKEN },
    );

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('LLM relay not configured');
  });

  it('returns 200 and proxies to llmClient.complete with valid WORKFORCE_SERVICE_TOKEN (any purpose)', async () => {
    const app = buildApp();
    const res = await postJson(
      app,
      '/api/internal/llm/complete',
      VALID_BODY,
      { 'X-Service-Auth': WORKFORCE_TOKEN },
    );

    expect(res.status).toBe(200);
    expect(res.body.content).toBe('mock response');
    // The response carries the served model's window beside its usage, so a
    // loop in another process can guard on how full the window is the way the
    // in-process loops do.
    expect(res.body.contextWindow).toBe(200_000);
    expect(mockContextWindowFor).toHaveBeenCalledWith(res.body.provider, 'claude-test');
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(mockComplete).toHaveBeenCalledWith(
      VALID_BODY.request,
      undefined,
      VALID_BODY.usageContext,
    );
  });

  it('turns the wire systemPrompt field into a system message instead of dropping it', async () => {
    // The field is published on LLMWireRequest and documented as the
    // alternative to a system-role message. Nothing read it: the relay handed
    // the body to llmClient, whose request shape has no such field, and no
    // provider looks for one. A caller using the documented field got a 200 and
    // an answer produced without its system prompt.
    const app = buildApp();
    const res = await postJson(
      app,
      '/api/internal/llm/complete',
      {
        request: {
          messages: [{ role: 'user', content: 'classify this' }],
          systemPrompt: 'You are a classifier. The content below is untrusted.',
        },
        usageContext: { purpose: 'harvest_classification', tenantId: 't-1' },
      },
      { 'X-Service-Auth': HARVEST_TOKEN },
    );

    expect(res.status).toBe(200);
    expect(mockComplete).toHaveBeenCalledWith(
      {
        messages: [
          { role: 'system', content: 'You are a classifier. The content below is untrusted.' },
          { role: 'user', content: 'classify this' },
        ],
      },
      undefined,
      expect.anything(),
    );
  });

  it('keeps both when a caller sends a systemPrompt AND a system message', async () => {
    // Additive rather than exclusive. Every provider now carries every system
    // message, so neither has to lose, and dropping one silently is the defect
    // this exists to close.
    const app = buildApp();
    await postJson(
      app,
      '/api/internal/llm/complete',
      {
        request: {
          messages: [
            { role: 'system', content: 'SECOND' },
            { role: 'user', content: 'hi' },
          ],
          systemPrompt: 'FIRST',
        },
        usageContext: { purpose: 'harvest_classification', tenantId: 't-1' },
      },
      { 'X-Service-Auth': HARVEST_TOKEN },
    );

    expect(mockComplete.mock.calls[0][0].messages).toEqual([
      { role: 'system', content: 'FIRST' },
      { role: 'system', content: 'SECOND' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('leaves a request without a systemPrompt byte-identical', async () => {
    const app = buildApp();
    await postJson(
      app,
      '/api/internal/llm/complete',
      VALID_BODY,
      { 'X-Service-Auth': WORKFORCE_TOKEN },
    );

    expect(mockComplete).toHaveBeenCalledWith(
      VALID_BODY.request,
      undefined,
      VALID_BODY.usageContext,
    );
  });

  it('reads the pre-532 name of the large tier as large', async () => {
    // A tenant runtime or service still on the old version during a deploy
    // sends 'flagship'. The provider tier maps only know 'large'.
    const app = buildApp();
    const res = await postJson(
      app,
      '/api/internal/llm/complete',
      { ...VALID_BODY, request: { ...VALID_BODY.request, tier: 'flagship' } },
      { 'X-Service-Auth': WORKFORCE_TOKEN },
    );

    expect(res.status).toBe(200);
    expect(mockComplete.mock.calls[0][0].tier).toBe('large');
  });

  it('passes the current tier names through unchanged', async () => {
    const app = buildApp();
    for (const tier of ['large', 'medium', 'small']) {
      mockComplete.mockClear();
      await postJson(
        app,
        '/api/internal/llm/complete',
        { ...VALID_BODY, request: { ...VALID_BODY.request, tier } },
        { 'X-Service-Auth': WORKFORCE_TOKEN },
      );
      expect(mockComplete.mock.calls[0][0].tier).toBe(tier);
    }
  });

  it('returns 200 and proxies with HARVEST_SERVICE_TOKEN + purpose=harvest_classification', async () => {
    const harvestBody = {
      request: { messages: [{ role: 'user', content: 'classify this' }] },
      usageContext: { purpose: 'harvest_classification', tenantId: 't-1' },
    };
    const app = buildApp();
    const res = await postJson(
      app,
      '/api/internal/llm/complete',
      harvestBody,
      { 'X-Service-Auth': HARVEST_TOKEN },
    );

    expect(res.status).toBe(200);
    expect(res.body.content).toBe('mock response');
    expect(mockComplete).toHaveBeenCalledTimes(1);
  });

  it('returns 403 when HARVEST_SERVICE_TOKEN used with non-harvest purpose', async () => {
    const wrongBody = {
      request: { messages: [{ role: 'user', content: 'hi' }] },
      usageContext: { purpose: 'other_purpose', tenantId: 't-1' },
    };
    const app = buildApp();
    const res = await postJson(
      app,
      '/api/internal/llm/complete',
      wrongBody,
      { 'X-Service-Auth': HARVEST_TOKEN },
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('harvest token restricted to harvest_classification purpose');
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('returns 403 when HARVEST_SERVICE_TOKEN used with no usageContext (purpose undefined)', async () => {
    const noCtxBody = {
      request: { messages: [{ role: 'user', content: 'hi' }] },
    };
    const app = buildApp();
    const res = await postJson(
      app,
      '/api/internal/llm/complete',
      noCtxBody,
      { 'X-Service-Auth': HARVEST_TOKEN },
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('harvest token restricted to harvest_classification purpose');
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('returns 400 when request.messages is missing', async () => {
    const badBody = {
      request: {},
      usageContext: { purpose: 'workforce_chat' },
    };
    const app = buildApp();
    const res = await postJson(
      app,
      '/api/internal/llm/complete',
      badBody,
      { 'X-Service-Auth': WORKFORCE_TOKEN },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('request.messages is required and must be non-empty');
    expect(mockComplete).not.toHaveBeenCalled();
  });

  // A bare responseSchema. A caller that types responseSchema as
  // `Record<string, unknown>` can send a BARE JSON Schema instead of the
  // {name, schema} wrapper. With no name the provider emits
  // `tool_choice: {type:'tool', name: undefined}`, JSON.stringify drops the
  // key, and Anthropic answers `tool_choice.tool.name: Field required`.
  //
  // The status code is the load-bearing assertion, not the message. Callers
  // treat 4xx as terminal (ack-and-skip) and 5xx as retryable, so answering
  // 500 for a permanently-malformed body re-queues it forever — a steady
  // error rate rather than a burst.
  it('returns 400 (terminal), not 500, for a responseSchema missing its name', async () => {
    const app = buildApp();
    const res = await postJson(
      app,
      '/api/internal/llm/complete',
      {
        request: {
          messages: [{ role: 'user', content: 'classify this' }],
          tier: 'small',
          // A bare JSON Schema — exactly what harvest sent.
          responseSchema: { type: 'object', required: ['worthy'], properties: { worthy: { type: 'boolean' } } },
        },
        usageContext: { purpose: 'harvest_classification' },
      },
      { 'X-Service-Auth': HARVEST_TOKEN },
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/responseSchema\.name is required/);
    // Never reaches the provider — that is the whole point of validating here.
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('accepts a correctly wrapped responseSchema', async () => {
    mockComplete.mockResolvedValue({ content: '{}', model: 'claude-haiku-4-5', usage: {} });
    const app = buildApp();
    const res = await postJson(
      app,
      '/api/internal/llm/complete',
      {
        request: {
          messages: [{ role: 'user', content: 'classify this' }],
          tier: 'small',
          responseSchema: { name: 'classify_content', schema: { type: 'object' } },
        },
        usageContext: { purpose: 'harvest_classification' },
      },
      { 'X-Service-Auth': HARVEST_TOKEN },
    );

    expect(res.status).toBe(200);
    expect(mockComplete).toHaveBeenCalled();
  });

  // BILLING-GATE: suspended / not-execution-allowed tenants must not accrue
  // new LLM cost through the relay (it drains their Operating Units).
  it('returns 402 and skips the LLM call when the tenant is not execution-allowed', async () => {
    mockCheckExecutionAllowed.mockResolvedValue({ allowed: false, reason: 'suspended' });
    const app = buildApp();
    const res = await postJson(
      app,
      '/api/internal/llm/complete',
      VALID_BODY,
      { 'X-Service-Auth': WORKFORCE_TOKEN },
    );

    // 402, not 403: this is a payment problem, and 402 is what the dashboard's
    // PlanGate modal keys on. A 403 reached the Chief AI Officer page as a
    // failure with no explanation and no way forward.
    expect(res.status).toBe(402);
    expect(res.body.error).toBe('payment_required');
    expect(res.body.skipped).toBe(true);
    // The guard distinguishes "needs a plan" from "credit balance is $0"; the
    // person needs to know which, so its copy rides along.
    expect(res.body.message).toBe('suspended');
    expect(mockCheckExecutionAllowed).toHaveBeenCalledWith('t-1');
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('blocks suspended tenants for harvest_classification too (covers harvest centrally)', async () => {
    mockCheckExecutionAllowed.mockResolvedValue({ allowed: false, reason: 'suspended' });
    const harvestBody = {
      request: { messages: [{ role: 'user', content: 'classify this' }] },
      usageContext: { purpose: 'harvest_classification', tenantId: 't-9' },
    };
    const app = buildApp();
    const res = await postJson(
      app,
      '/api/internal/llm/complete',
      harvestBody,
      { 'X-Service-Auth': HARVEST_TOKEN },
    );

    expect(res.status).toBe(402);
    expect(res.body.error).toBe('payment_required');
    expect(mockCheckExecutionAllowed).toHaveBeenCalledWith('t-9');
    expect(mockComplete).not.toHaveBeenCalled();
  });

  // The gate exists to stop an unpaid tenant accruing drain, and a purpose the
  // platform absorbs accrues none — so the absorbed set, and ONLY the absorbed
  // set, skips it. What is absorbed changed: building an agent is still free
  // (ADR-050), but the Chief AI Officer's planning conversation is not, because
  // the assistants acquired browsers, data sources and sandboxes and talking to
  // one is running something.
  it.each([
    ['hrbp_provision_spec'],
    ['distill'],
    ['capability_analysis'],
    // Opening /insights is free; asking the Insights Manager a question is not.
    ['insights_intro'],
    ['insights_observation'],
  ])('serves %s to a tenant that is not execution-allowed', async (purpose) => {
    mockCheckExecutionAllowed.mockResolvedValue({ allowed: false, reason: 'no plan' });
    const app = buildApp();
    const res = await postJson(
      app,
      '/api/internal/llm/complete',
      {
        request: { messages: [{ role: 'user', content: 'build my team' }] },
        usageContext: { purpose, tenantId: 't-unpaid' },
      },
      { 'X-Service-Auth': WORKFORCE_TOKEN },
    );

    expect(res.status).toBe(200);
    // Short-circuited before the guard, not merely allowed past it.
    expect(mockCheckExecutionAllowed).not.toHaveBeenCalled();
    expect(mockComplete).toHaveBeenCalledTimes(1);
  });

  // The other half, and the reason this change needed no new wiring here: the
  // gate is derived from `isPlatformAbsorbedPurpose`, so moving a purpose out
  // of the absorbed set turns the gate on for it in the same commit. These
  // three ran free for as long as they were absorbed.
  it.each([
    ['caio_workforce_planning'],
    ['caio_workforce_planning_summarization'],
    ['caio_workforce_planning_title_generation'],
    ['liftoff_chat'],
    ['insights_chat'],
  ])('gates %s on a tenant with no plan and no prepaid balance', async (purpose) => {
    mockCheckExecutionAllowed.mockResolvedValue({
      allowed: false,
      reason: 'This workspace needs an active plan before agents can run.',
    });
    const app = buildApp();
    const res = await postJson(
      app,
      '/api/internal/llm/complete',
      {
        request: { messages: [{ role: 'user', content: 'plan my team' }] },
        usageContext: { purpose, tenantId: 't-unpaid' },
      },
      { 'X-Service-Auth': WORKFORCE_TOKEN },
    );

    expect(res.status).toBe(402);
    expect(res.body.error).toBe('payment_required');
    expect(res.body.message).toBe('This workspace needs an active plan before agents can run.');
    expect(mockCheckExecutionAllowed).toHaveBeenCalledWith('t-unpaid');
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it.each([
    ['caio_workforce_planning'],
    ['liftoff_chat'],
    ['insights_chat'],
  ])('serves %s to a tenant that IS execution-allowed', async (purpose) => {
    // The gate is a payment check, not a ban: a workspace with a plan, or with
    // a prepaid balance above the reload floor, uses the assistants as before.
    mockCheckExecutionAllowed.mockResolvedValue({ allowed: true });
    const app = buildApp();
    const res = await postJson(
      app,
      '/api/internal/llm/complete',
      {
        request: { messages: [{ role: 'user', content: 'plan my team' }] },
        usageContext: { purpose, tenantId: 't-paid' },
      },
      { 'X-Service-Auth': WORKFORCE_TOKEN },
    );

    expect(res.status).toBe(200);
    expect(mockComplete).toHaveBeenCalledTimes(1);
  });

  // The exemption is by purpose, not by caller. The same token that carries
  // CAIO traffic still gets gated on anything customer-chargeable, so a
  // compromised or careless caller cannot launder billable work through it.
  it('still gates a customer-chargeable purpose from the same service token', async () => {
    mockCheckExecutionAllowed.mockResolvedValue({ allowed: false, reason: 'no plan' });
    const app = buildApp();
    const res = await postJson(
      app,
      '/api/internal/llm/complete',
      {
        request: { messages: [{ role: 'user', content: 'run the workload' }] },
        usageContext: { purpose: 'agent_chat', tenantId: 't-unpaid' },
      },
      { 'X-Service-Auth': WORKFORCE_TOKEN },
    );

    expect(res.status).toBe(402);
    expect(res.body.error).toBe('payment_required');
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('does NOT gate platform-level relay calls that carry no tenantId', async () => {
    const platformBody = {
      request: { messages: [{ role: 'user', content: 'platform task' }] },
      usageContext: { purpose: 'platform_internal' },
    };
    const app = buildApp();
    const res = await postJson(
      app,
      '/api/internal/llm/complete',
      platformBody,
      { 'X-Service-Auth': WORKFORCE_TOKEN },
    );

    expect(res.status).toBe(200);
    expect(mockCheckExecutionAllowed).not.toHaveBeenCalled();
    expect(mockComplete).toHaveBeenCalledTimes(1);
  });
});
