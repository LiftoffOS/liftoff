// The authored prose is the person's layer and stays in the person's terms.
//
// A team's brief told its owner to "use the direct web-reading tool, not an
// interactive browser session" — a distinction the platform already makes on
// its own for a scheduled run, written into the one text a person reads and
// edits. The two tools that write the prose refuse execution mechanics, naming
// the field and phrase, so the next draft is the fix.

jest.mock('../workforce-plans/service.js', () => ({
  workforcePlanService: { createDraft: jest.fn(), updateDraft: jest.fn(), getPlan: jest.fn() },
}));
const linkWorkforcePlan = jest.fn();
jest.mock('../workforce-plans/chat-repository.js', () => ({ linkWorkforcePlan: (...a: unknown[]) => linkWorkforcePlan(...a) }));
jest.mock('../workforce-plans/tenant-agents.js', () => ({
  listTenantAgents: jest.fn().mockResolvedValue({ ok: true, agents: [] }),
}));
jest.mock('../infrastructure/logging.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { findExecutionMechanics, refuseExecutionMechanics } from '../workforce-plans/prose-for-the-person.js';
import { workforcePlanDraftTool } from '../workforce-plans/tools/workforce-plan-draft.js';
import { teamProposeUpdateTool } from '../workforce-plans/tools/team-propose-update.js';
import { workforcePlanService } from '../workforce-plans/service.js';
import { resetConfigForTests } from '../infrastructure/config.js';
import type { WorkforcePlanToolContext } from '../workforce-plans/tools/types.js';

const ctx: WorkforcePlanToolContext = {
  tenantId: 'tenant-123',
  accountId: 'acct-1',
  threadId: null,
  workforcePlanId: null,
} as unknown as WorkforcePlanToolContext;

describe('findExecutionMechanics', () => {
  it('finds the sentence that reached a person', () => {
    const findings = findExecutionMechanics({
      anythingToAvoid: 'Do not rely on an interactive browser session for the weekly run since nobody will be watching live; use the direct web-reading tool instead.',
      workflows: '1. Read shopify.com directly using the web-reading tool (not an interactive browser) and capture the live positioning language verbatim.',
    });
    expect(findings).toEqual(expect.arrayContaining([
      { field: 'anythingToAvoid', phrase: 'interactive browser' },
      { field: 'anythingToAvoid', phrase: 'web-reading tool' },
      { field: 'workflows', phrase: 'web-reading tool' },
      { field: 'workflows', phrase: 'interactive browser' },
    ]));
  });

  it('finds tool names as whole words, in the person\'s fields', () => {
    expect(findExecutionMechanics({ instructions: 'Call web_fetch_advanced with the URL.' }))
      .toEqual([{ field: 'instructions', phrase: 'web_fetch_advanced' }]);
    expect(findExecutionMechanics({ rules: 'Never run_capability twice.' }))
      .toEqual([{ field: 'rules', phrase: 'run_capability' }]);
  });

  it('leaves the person\'s own detail alone: URLs, field names, business vocabulary', () => {
    expect(findExecutionMechanics({
      workflows: '1. Read https://www.shopify.com and capture the hero headline verbatim. 2. Note one differentiator each for BigCommerce, WooCommerce and Salesforce Commerce Cloud. 3. Email the brief to person@example.com.',
      instructions: 'Map customer_id to the CRM\'s account field. Use the sales team\'s reporting tool names as they appear in the sheet.',
      constraints: 'Keep the brief to one page. Search no more than eight sources.',
      edgeCases: 'If the site cannot be read this week, say so in the email rather than filling the gap from memory.',
    })).toEqual([]);
  });

  it('refuses with the field, the phrase, and what to write instead', () => {
    const msg = refuseExecutionMechanics({ anythingToAvoid: 'Never open a browser session.' });
    expect(msg).toContain('anythingToAvoid: "browser session"');
    expect(msg).toContain('person\'s terms');
    expect(refuseExecutionMechanics({ goals: 'A current brief every Monday.' })).toBeNull();
  });
});

describe('workforce_plan__draft', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetConfigForTests();
  });

  it('refuses a spec whose brief names a mechanic, before anything is written', async () => {
    const result = await workforcePlanDraftTool.execute({
      agents: [{
        specId: 'brief-01', name: 'Shopify Competitive Brief', agentType: 'workflow', roleSummary: 'Weekly brief.',
        prose: {
          responsibilities: 'Owns the weekly brief.',
          anythingToAvoid: 'Do not rely on an interactive browser session; use the direct web-reading tool instead.',
        },
      }],
    }, ctx) as { ok?: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Shopify Competitive Brief: ');
    expect(result.error).toContain('anythingToAvoid: "interactive browser');
    expect(workforcePlanService.createDraft).not.toHaveBeenCalled();
    expect(workforcePlanService.updateDraft).not.toHaveBeenCalled();
  });

  it('writes a brief in the person\'s terms', async () => {
    (workforcePlanService.createDraft as jest.Mock).mockResolvedValue({
      id: 'plan-1', status: 'draft', title: null, agents: [{}], revision: 1,
    });
    const result = await workforcePlanDraftTool.execute({
      agents: [{
        specId: 'brief-01', name: 'Shopify Competitive Brief', agentType: 'workflow', roleSummary: 'Weekly brief.',
        prose: {
          responsibilities: 'Owns the weekly Shopify competitive brief end to end.',
          workflows: '1. Read https://www.shopify.com and capture the live positioning copy verbatim. 2. Note one differentiator each for the three fixed competitors. 3. Find this week\'s Shopify headline with its source and date. 4. Email the one-page brief to person@example.com every Monday morning.',
          edgeCases: 'If the site cannot be read this week, say so in the email; never fill the gap from memory.',
        },
      }],
    }, ctx) as { planId?: string };
    expect(result.planId).toBe('plan-1');
    expect(workforcePlanService.createDraft).toHaveBeenCalledTimes(1);
  });
});

// A DM with the Chief AI Officer is one conversation for as long as the
// workspace exists. Its first plan finishing must not make it a dead end.
describe('a thread whose plan has finished takes a new one', () => {
  const SPEC = {
    specId: 'check-01', name: 'Launch Check Two', agentType: 'workflow', roleSummary: 'Weekly summary.',
    prose: { responsibilities: 'Summarises the homepage weekly.', workflows: '1. Read the homepage. 2. Write one line.', edgeCases: 'Say so when the page cannot be read.' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (workforcePlanService.createDraft as jest.Mock).mockResolvedValue({ id: 'plan-2', status: 'draft', title: null, agents: [{}], revision: 1 });
    (workforcePlanService.updateDraft as jest.Mock).mockResolvedValue({ id: 'plan-1', status: 'draft', title: null, agents: [{}], revision: 2 });
  });

  it('creates a fresh plan and re-links the thread when the attached plan completed', async () => {
    (workforcePlanService.getPlan as jest.Mock).mockResolvedValue({ id: 'plan-1', status: 'completed' });
    const result = await workforcePlanDraftTool.execute(
      { agents: [SPEC] },
      { ...ctx, threadId: 'thread-1', workforcePlanId: 'plan-1' } as unknown as WorkforcePlanToolContext,
    ) as { planId?: string };
    expect(result.planId).toBe('plan-2');
    expect(workforcePlanService.updateDraft).not.toHaveBeenCalled();
    expect(linkWorkforcePlan).toHaveBeenCalledWith('thread-1', 'tenant-123', 'plan-2');
  });

  it('still updates in place while the attached plan is being shaped', async () => {
    (workforcePlanService.getPlan as jest.Mock).mockResolvedValue({ id: 'plan-1', status: 'draft' });
    const result = await workforcePlanDraftTool.execute(
      { agents: [SPEC] },
      { ...ctx, threadId: 'thread-1', workforcePlanId: 'plan-1' } as unknown as WorkforcePlanToolContext,
    ) as { planId?: string };
    expect(result.planId).toBe('plan-1');
    expect(workforcePlanService.createDraft).not.toHaveBeenCalled();
  });
});

describe('team__propose_update', () => {
  it('refuses an edit that names a mechanic, before calling the control plane', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const result = await teamProposeUpdateTool.execute({
      internalAgentId: '3f376756-f08b-426d-8eec-b7257971fdae',
      additionalContext: 'Use web_search for the headline.',
    }, ctx) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('additionalContext: "web_search"');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
