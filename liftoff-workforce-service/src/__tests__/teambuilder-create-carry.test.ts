// What the distiller produced must reach the agent, and the bindings must be
// resolved rather than guessed.
//
// Both failures have one shape: the model asked to carry data it cannot know or
// cannot fully name. It cannot see which connectors are connected, so bindings
// it supplies are guesses. And retyping the distill result into create's
// arguments can only carry the fields create's schema names, so workflowSteps,
// skills, instructionsMd and capabilityTier silently do not arrive.

const resolveSpecIntegrations = jest.fn();
jest.mock('../platform-agent/hrbp/spec-integrations.js', () => ({ resolveSpecIntegrations }));
jest.mock('../infrastructure/service-auth.js', () => ({
  getServiceAuthHeaders: jest.fn().mockResolvedValue({ 'X-Service-Auth': 'tok' }),
}));
jest.mock('../infrastructure/logging.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { resetConfigForTests } from '../infrastructure/config.js';
import { handleTeambuilderCreate } from '../platform-agent/hrbp/tools/teambuilder-create.js';
import type { HrbpToolContext } from '../platform-agent/hrbp/types.js';

const TENANT = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';
const SHEETS = { id: 'conn-1', type: 'google_sheets', name: 'Google Sheets', selectedObjects: [] };

function ctx(over: Partial<HrbpToolContext> = {}): HrbpToolContext {
  return {
    tenantId: TENANT,
    planId: 'plan-1',
    runId: 'run-1',
    specId: 'campaign-tracker',
    approverAccountId: 'acct-1',
    spec: {
      specId: 'campaign-tracker',
      name: 'Campaign Tracker',
      agentType: 'workflow',
      roleSummary: 'tracks campaigns',
      responsibilities: 'THE FULL APPROVED BRIEF: fetch pages 0-9, map every field, dedup by campaign_url, handle key rotation.',
      connectors: ['google_sheets'],
    },
    ...over,
  } as HrbpToolContext;
}

let fetchSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  resetConfigForTests();
  process.env['PLATFORM_BACKEND_URL'] = 'http://pb.local';
  process.env['GCP_PROJECT_ID'] = 'test';
  process.env['DB_INSTANCE_CONNECTION_NAME'] = 'test:us-west1:db';
  process.env['WORKFORCE_SERVICE_TOKEN'] = 'tok';
  resolveSpecIntegrations.mockResolvedValue({
    integrations: [SHEETS],
    pendingConnectorTypes: [],
    lookupSucceeded: true,
  });
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ agent: { id: 'agent-1' } }),
  } as unknown as Response);
});

afterEach(() => {
  fetchSpy.mockRestore();
  resetConfigForTests();
});

const sentBody = () => JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);

describe('teambuilder__create', () => {
  it('binds the connectors the workspace actually has, ignoring the model', async () => {
    await handleTeambuilderCreate(
      // What the model guessed: nothing bound, everything pending.
      { role: 'X', systemPrompt: 'sp', integrations: [], pendingIntegrations: ['google_sheets'] },
      ctx(),
    );

    const body = sentBody();
    expect(body.integrations).toEqual([SHEETS]);
    expect(body.pendingIntegrations).toEqual([]);
  });

  it('carries the whole distill result, including the fields create never had a slot for', async () => {
    const distillResult = {
      summary: 's',
      systemPrompt: 'distilled prompt',
      userInstructions: 'ui',
      instructionsMd: '# md',
      triggerConfig: { type: 'cron', cronExpr: '0 12 * * *' },
      skills: [{ name: 'fetch-page' }],
      workflowSteps: [{ id: 'step-1', type: 'llm_reason' }],
      capabilityTier: 'connector_only',
    };

    await handleTeambuilderCreate(
      // The model carried only what it could name, and got the prompt wrong.
      { role: 'X', systemPrompt: 'the model retyped this badly' },
      ctx({ distillResult }),
    );

    const body = sentBody();
    expect(body.workflowSteps).toEqual(distillResult.workflowSteps);
    expect(body.skills).toEqual(distillResult.skills);
    expect(body.instructionsMd).toBe('# md');
    expect(body.capabilityTier).toBe('connector_only');
    expect(body.triggerConfig).toEqual(distillResult.triggerConfig);
    // The distilled prompt wins over the model's copy of it.
    expect(body.systemPrompt).toBe('distilled prompt');
  });

  it('keeps the spec agentType, which distill always reports as "agent"', async () => {
    await handleTeambuilderCreate(
      { role: 'X', systemPrompt: 'sp' },
      ctx({ distillResult: { agentType: 'agent', systemPrompt: 'sp' } }),
    );

    // ADR-022 collapsed distill's output to a single agentType; letting it
    // through would silently demote a workflow spec.
    expect(sentBody().agentType).toBe('workflow');
  });

  it('never forwards modelConfig or distill-only fields platform-backend rejects', async () => {
    await handleTeambuilderCreate(
      { role: 'X', systemPrompt: 'sp', modelConfig: { tier: 'large' } },
      ctx({ distillResult: { absorption: [{ x: 1 }], integrationConfigs: { a: 1 }, systemPrompt: 'sp' } }),
    );

    const body = sentBody();
    expect(body.modelConfig).toBeUndefined();
    expect(body.absorption).toBeUndefined();
    expect(body.integrationConfigs).toBeUndefined();
  });

  it('stores the approved brief, not the paraphrase the model wrote', async () => {
    await handleTeambuilderCreate(
      // What the model wrote: a one-line summary of a multi-paragraph brief.
      { role: 'X', systemPrompt: 'sp', responsibilities: 'Tracks campaigns daily.' },
      ctx(),
    );

    const body = sentBody();
    // platform-backend's redistill feeds the STORED responsibilities back into
    // the distiller, so a paraphrase here becomes the entire input to every
    // future rebuild of this agent.
    expect(body.responsibilities).toContain('THE FULL APPROVED BRIEF');
    expect(body.responsibilities).not.toBe('Tracks campaigns daily.');
    expect(body.role).toBe('Campaign Tracker');
  });

  it('falls back to the roleSummary when a spec carries no responsibilities', async () => {
    const spec = { ...ctx().spec } as Record<string, unknown>;
    delete spec.responsibilities;
    await handleTeambuilderCreate(
      { role: 'X', systemPrompt: 'sp' },
      ctx({ spec: spec as never }),
    );
    expect(sentBody().responsibilities).toBe('tracks campaigns');
  });

  it('scopes the idempotency key to the run so a compensated spec can be rebuilt', async () => {
    await handleTeambuilderCreate({ role: 'X', systemPrompt: 'sp' }, ctx({ runId: 'run-A' }));
    await handleTeambuilderCreate({ role: 'X', systemPrompt: 'sp' }, ctx({ runId: 'run-B' }));

    const keys = fetchSpy.mock.calls.map(
      c => (c[1] as RequestInit & { headers: Record<string, string> }).headers['Idempotency-Key'],
    );
    // platform-backend replays the cached body for a repeated key, and
    // provisioning__compensate deletes the agent that body names. Keyed to the
    // plan, a later attempt is answered with a 201 for an agent that no longer
    // exists and creates nothing.
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toContain('run-A');
    expect(keys[1]).toContain('run-B');
  });

  it('reuses the key within one run, so a Cloud Tasks retry cannot double-create', async () => {
    await handleTeambuilderCreate({ role: 'X', systemPrompt: 'sp' }, ctx({ runId: 'run-A' }));
    await handleTeambuilderCreate({ role: 'X', systemPrompt: 'sp' }, ctx({ runId: 'run-A' }));

    const keys = fetchSpy.mock.calls.map(
      c => (c[1] as RequestInit & { headers: Record<string, string> }).headers['Idempotency-Key'],
    );
    expect(keys[0]).toBe(keys[1]);
  });

  it('still creates, and says so, when the distill result is missing', async () => {
    const result = await handleTeambuilderCreate({ role: 'X', systemPrompt: 'sp' }, ctx());
    expect(result.ok).toBe(true);
  });
});
