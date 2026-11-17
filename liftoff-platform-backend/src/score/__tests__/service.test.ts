// LiftoffScore mapping tests.
//
// These lock the two decisions that are easy to undo by accident: the
// estimator's latent parameters must not reach the response, and Teamwork must
// not ship as a graded band while turn count is the only signal behind it.

import { getLiftoffScore, conservativeEstimate, MIN_TASKS_TO_RATE } from '../service';
import type { SkillPosterior } from '../governance-client';

jest.mock('../../insights/data-providers/internal-agents-provider', () => ({
  getInternalAgents: jest.fn(async () => [
    { id: 'agent-1', name: 'Finance Agent', role: 'finance', status: 'active' },
    { id: 'agent-2', name: 'Support Agent', role: 'support', status: 'active' },
  ]),
}));

jest.mock('../../insights/data-providers/tenant-members-provider', () => ({
  getTenantMembers: jest.fn(async () => [
    { accountId: 'person-1', displayName: 'Sarah Chen', email: 'sarah@example.com', role: 'admin' },
    { accountId: 'person-2', displayName: 'Marcus Webb', email: 'marcus@example.com', role: 'member' },
  ]),
}));

jest.mock('../../insights/data-providers/corrections-provider', () => ({
  getCorrectionStats: jest.fn(async () => ({
    totalCorrections: 3,
    byAgent: [{ agentId: 'agent-2', agentName: 'Support Agent', correctionCount: 3 }],
  })),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

function posterior(over: Partial<SkillPosterior>): SkillPosterior {
  return {
    tenantId: 'tenant-1',
    entityType: 'agent',
    entityId: 'agent-1',
    scope: 'global',
    mu: 70,
    sigma: 5,
    nObservations: 30,
    lastMatchAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function serve(rows: SkillPosterior[]): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(rows), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

const OLD_URL = process.env.GOVERNANCE_SERVICE_URL;
beforeAll(() => { process.env.GOVERNANCE_SERVICE_URL = 'https://governance.test'; });
afterAll(() => { process.env.GOVERNANCE_SERVICE_URL = OLD_URL; });

describe('getLiftoffScore', () => {
  it('never puts mu, sigma or the observation count in the response', async () => {
    const res = await getLiftoffScore('tenant-1', 'this_month', {
      fetchImpl: serve([
        posterior({ entityId: 'agent-1' }),
        posterior({ entityId: 'person-1', entityType: 'human', mu: 60 }),
      ]),
    });

    const serialised = JSON.stringify(res);
    expect(serialised).not.toContain('"mu"');
    expect(serialised).not.toContain('"sigma"');
    expect(serialised).not.toContain('nObservations');
  });

  it('leaves teamworkBand null even for a fully rated row', async () => {
    const res = await getLiftoffScore('tenant-1', 'this_month', {
      fetchImpl: serve([posterior({ nObservations: 50 })]),
    });

    const row = res.entries[0];
    expect(row.rated).toBe(true);
    expect(row.resultsBand).not.toBeNull();
    expect(row.teamworkBand).toBeNull();
  });

  it('anchors the best entity in each group at 100, separately', async () => {
    const res = await getLiftoffScore('tenant-1', 'this_month', {
      fetchImpl: serve([
        posterior({ entityId: 'agent-1', mu: 80, sigma: 2 }),
        posterior({ entityId: 'agent-2', mu: 40, sigma: 2 }),
        posterior({ entityId: 'person-1', entityType: 'human', mu: 30, sigma: 2 }),
      ]),
    });

    const byKey = new Map(res.entries.map((e) => [e.entityKey, e]));
    // Top of each group reaches 100 even though the person's raw estimate is
    // far below the top team's. The groups do not share a scale.
    expect(byKey.get('ai_team:agent-1')!.score).toBe(100);
    expect(byKey.get('person:person-1')!.score).toBe(100);
    expect(byKey.get('ai_team:agent-2')!.score).toBeLessThan(100);
  });

  it('withholds a score below the task floor and says how many are missing', async () => {
    const res = await getLiftoffScore('tenant-1', 'this_month', {
      fetchImpl: serve([
        posterior({ entityId: 'agent-1', nObservations: 40 }),
        posterior({ entityId: 'agent-2', nObservations: 2 }),
      ]),
    });

    const thin = res.entries.find((e) => e.entityKey === 'ai_team:agent-2')!;
    expect(thin.rated).toBe(false);
    expect(thin.score).toBeNull();
    expect(thin.band).toBeNull();
    expect(thin.notRatedReason).toBe('too_early');
    expect(thin.tasksToRate).toBe(MIN_TASKS_TO_RATE - 2);
  });

  it('drops backbone posteriors, which are models rather than teammates', async () => {
    const res = await getLiftoffScore('tenant-1', 'this_month', {
      fetchImpl: serve([
        posterior({ entityId: 'agent-1' }),
        posterior({ entityId: 'anthropic:claude', entityType: 'backbone' }),
      ]),
    });

    expect(res.entries).toHaveLength(1);
    expect(res.entries[0].kind).toBe('ai_team');
  });

  it('turns corrections into a hurting driver in plain units', async () => {
    const res = await getLiftoffScore('tenant-1', 'this_month', {
      fetchImpl: serve([
        posterior({ entityId: 'agent-1' }),
        posterior({ entityId: 'agent-2' }),
      ]),
    });

    const support = res.entries.find((e) => e.entityKey === 'ai_team:agent-2')!;
    expect(support.drivers).toEqual([
      {
        kind: 'hurting',
        dimension: 'results',
        label: '3 pieces of work needed correcting',
        benchmark: null,
      },
    ]);
    // No fabricated action while there is no structured thing to point at.
    expect(support.action).toBeNull();
  });

  it('reports a workspace under the floor as too_early rather than ranking it', async () => {
    const res = await getLiftoffScore('tenant-1', 'this_month', {
      fetchImpl: serve([posterior({ nObservations: 6 })]),
    });

    expect(res.status).toBe('too_early');
    expect(res.entries).toHaveLength(0);
    expect(res.taskCount).toBe(6);
  });

  it('degrades to an empty panel when governance-engine is unreachable', async () => {
    const dead = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const res = await getLiftoffScore('tenant-1', 'this_month', { fetchImpl: dead });

    expect(res.status).toBe('too_early');
    expect(res.entries).toHaveLength(0);
  });

  it('resolves display names and carries accountId only for people', async () => {
    const res = await getLiftoffScore('tenant-1', 'this_month', {
      fetchImpl: serve([
        posterior({ entityId: 'agent-1' }),
        posterior({ entityId: 'person-1', entityType: 'human' }),
      ]),
    });

    const team = res.entries.find((e) => e.kind === 'ai_team')!;
    const person = res.entries.find((e) => e.kind === 'person')!;
    expect(team.displayName).toBe('Finance Agent');
    expect(team.accountId).toBeNull();
    expect(person.displayName).toBe('Sarah Chen');
    expect(person.accountId).toBe('person-1');
    expect(person.email).toBe('sarah@example.com');
  });
});

describe('conservativeEstimate', () => {
  it('is the paper\'s mu - 3*sigma', () => {
    expect(conservativeEstimate({ mu: 70, sigma: 5 })).toBe(55);
  });

  it('floors a cold-start entity at zero rather than going negative', () => {
    // Prior is mu 0, sigma 25, so the raw quantity is -75.
    expect(conservativeEstimate({ mu: 0, sigma: 25 })).toBe(0);
  });
});
