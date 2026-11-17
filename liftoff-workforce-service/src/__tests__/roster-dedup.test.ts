// Roster dedup detection — the structural guard that stops the CAIO drafting a
// team the workspace already runs. Pure function, no I/O to mock.

import {
  detectRosterDuplicates,
  renderDuplicateGuidance,
} from '../workforce-plans/roster-dedup.js';
import type { RawAgent } from '../workforce-plans/tenant-agents.js';
import type { WorkforcePlanAgentSpec } from '../workforce-plans/types.js';

function spec(partial: Partial<WorkforcePlanAgentSpec> & { specId: string; name: string }): WorkforcePlanAgentSpec {
  return {
    agentType: 'agent',
    roleSummary: '',
    ...partial,
  } as WorkforcePlanAgentSpec;
}

function agent(partial: Partial<RawAgent> & { id: string }): RawAgent {
  return { status: 'active', ...partial };
}

describe('detectRosterDuplicates', () => {
  it('flags an identical-name team as a duplicate', () => {
    const specs = [spec({ specId: 's1', name: 'Sales Development Team', roleSummary: 'books demos' })];
    const roster = [agent({ id: 'a1', role: 'Sales Development Team', responsibilities: 'books demos' })];

    const matches = detectRosterDuplicates(specs, roster);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      specId: 's1',
      existingAgentId: 'a1',
      kind: 'duplicate',
    });
  });

  it('flags a subsuming-name team as a duplicate (name is a subset)', () => {
    // "Sales Development" ⊆ "Sales Development Representatives" on meaningful tokens.
    const specs = [spec({ specId: 's1', name: 'Sales Development' })];
    const roster = [agent({ id: 'a1', role: 'Sales Development Representatives' })];

    const matches = detectRosterDuplicates(specs, roster);
    expect(matches[0]?.kind).toBe('duplicate');
  });

  it('flags scope overlap (divergent names, high token jaccard) as overlap', () => {
    const specs = [
      spec({ specId: 's1', name: 'Pipeline Builder', roleSummary: 'outbound prospecting and lead enrichment' }),
    ];
    const roster = [
      agent({ id: 'a1', role: 'Prospecting Bot', responsibilities: 'outbound prospecting and lead enrichment' }),
    ];

    const matches = detectRosterDuplicates(specs, roster);
    expect(matches[0]?.kind).toBe('overlap');
  });

  it('does NOT flag same-department but distinct roles', () => {
    // {sales, manager} vs {sales, specialist} -> jaccard 1/3, below threshold,
    // and neither name subsumes the other.
    const specs = [spec({ specId: 's1', name: 'Sales Manager' })];
    const roster = [agent({ id: 'a1', role: 'Sales Specialist' })];

    expect(detectRosterDuplicates(specs, roster)).toHaveLength(0);
  });

  it('returns nothing for an empty roster', () => {
    const specs = [spec({ specId: 's1', name: 'Sales Development Team' })];
    expect(detectRosterDuplicates(specs, [])).toHaveLength(0);
  });

  it('counts paused teams — a paused team is still provisioned', () => {
    const specs = [spec({ specId: 's1', name: 'Finance Reconciler' })];
    const roster = [agent({ id: 'a1', role: 'Finance Reconciler', status: 'paused' })];

    const matches = detectRosterDuplicates(specs, roster);
    expect(matches[0]).toMatchObject({ kind: 'duplicate', existingStatus: 'paused' });
  });

  it('excludes the plan\'s own already-provisioned teams (amendment redraft)', () => {
    const specs = [spec({ specId: 's1', name: 'Finance Reconciler' })];
    const roster = [
      agent({ id: 'a1', role: 'Finance Reconciler', workforcePlanId: 'plan-1' }),
    ];

    // Redrafting plan-1 must not flag the team plan-1 itself created.
    expect(detectRosterDuplicates(specs, roster, 'plan-1')).toHaveLength(0);
    // A different plan still sees it as a duplicate.
    expect(detectRosterDuplicates(specs, roster, 'plan-2')).toHaveLength(1);
  });

  it('keeps only the strongest match per spec (duplicate beats overlap)', () => {
    const specs = [
      spec({ specId: 's1', name: 'Support Team', roleSummary: 'answers customer tickets fast' }),
    ];
    const roster = [
      agent({ id: 'a1', role: 'Help Desk', responsibilities: 'answers customer tickets fast' }), // overlap
      agent({ id: 'a2', role: 'Support Team', responsibilities: 'triages email' }), // duplicate by name
    ];

    const matches = detectRosterDuplicates(specs, roster);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ existingAgentId: 'a2', kind: 'duplicate' });
  });
});

describe('renderDuplicateGuidance', () => {
  it('is empty when there are no matches', () => {
    expect(renderDuplicateGuidance([])).toBe('');
  });

  it('is directive for a duplicate and names the existing team id', () => {
    const note = renderDuplicateGuidance([
      { specId: 's1', specName: 'Sales Team', existingAgentId: 'a1', existingAgentName: 'Sales Team', existingStatus: 'active', kind: 'duplicate', score: 1 },
    ]);
    expect(note).toContain('Do NOT provision a duplicate');
    expect(note).toContain('a1');
    expect(note).toContain('team__propose_update');
  });

  it('asks for confirmation on a lighter overlap', () => {
    const note = renderDuplicateGuidance([
      { specId: 's1', specName: 'Pipeline Builder', existingAgentId: 'a1', existingAgentName: 'Prospecting Bot', existingStatus: 'active', kind: 'overlap', score: 0.6 },
    ]);
    expect(note).toContain('overlaps in scope');
    expect(note).toContain('confirm with the user');
  });
});
