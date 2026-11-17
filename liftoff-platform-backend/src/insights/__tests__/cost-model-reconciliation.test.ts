// The cards and the table are the same numbers.
//
// This is the check that was missing, and it is missing-shaped: nothing here is
// about a particular provider, and every defect it would have caught looked
// like a change to somewhere else.
//
//   Web-tool spend was added to the Total Cost card and pooled into one
//   anonymous group in the table, so no team's line included its own browsing.
//
//   `runWork` (4f857030) was added to the card's MONEY and the table's
//   Operating Units and to neither the card's Operating Units nor the table's
//   money-per-source. Half a fix passes every test that looks at one surface.
//
//   Agentless platform spend was added to the card with no table row at all,
//   under a comment asserting it would always be zero. It stopped being zero
//   the day the platform assistants got a browser, and nothing noticed.
//
//   Sandbox and connector spend reached neither, for months, while
//   `event-type-coverage.test.ts` passed with a frozen wrong reason.
//
// One property covers all four: every dollar and every Operating Unit in a
// card is in a group, and every one in a group is in a card. `buildCostModel`
// is the only thing that computes either, so the property is structural — but
// it is asserted rather than assumed, because the last version of this claim
// was a comment saying "reconcile by construction" over two separate sums.

import {
  buildCostModel,
  sumModelUsd,
  sumModelOus,
  sumLineAcrossModel,
  formatCostUsd,
  type CostModelInput,
} from '../report-service';

const RANGE_AGENT = 'a1111111-1111-4111-8111-111111111111';
const GONE_AGENT  = 'a2222222-2222-4222-8222-222222222222';
const STRANGER    = 'a9999999-9999-4999-8999-999999999999';

const NO_BUCKETS = { creation: 0, updates: 0, discovery: 0, discoveryUpdates: 0, interactions: 0, runWork: 0, other: 0 };

function input(over: Partial<CostModelInput> = {}): CostModelInput {
  return {
    agents: [],
    externalAgentStats: [],
    agentInvocationCosts: {},
    agentLLMMap: {},
    agentLLMMapOus: {},
    agentlessLLMCosts: [],
    claudeCodeProxyCosts: [],
    webToolCosts: [],
    sandboxCosts: [],
    dataSourceCosts: [],
    voiceCosts: [],
    ...over,
  };
}

const team = (id: string, name: string, deletedAt: Date | null = null) =>
  ({ id, name, role: name, status: 'active', deletedAt });

/** Everything at once: a live team, a removed team, all three tool kinds, an
 *  assistant, voice, and spend belonging to nobody. */
function fullModel() {
  return buildCostModel(input({
    agents: [team(RANGE_AGENT, 'Research Team'), team(GONE_AGENT, 'Old Team', new Date())],
    agentInvocationCosts: {
      [RANGE_AGENT]: { totalCostUsd: 10, rawModelCostUsd: 9, ouConsumed: 500, invocationCount: 4,
        totalInputTokens: 0, totalOutputTokens: 0, totalCachedTokens: 0 } as never,
      [GONE_AGENT]: { totalCostUsd: 3, rawModelCostUsd: 3, ouConsumed: 150, invocationCount: 1,
        totalInputTokens: 0, totalOutputTokens: 0, totalCachedTokens: 0 } as never,
    },
    agentLLMMap:    { [RANGE_AGENT]: { ...NO_BUCKETS, creation: 2, interactions: 1, runWork: 0.5 } },
    agentLLMMapOus: { [RANGE_AGENT]: { ...NO_BUCKETS, creation: 100, interactions: 50, runWork: 25 } },
    agentlessLLMCosts: [
      { purpose: 'liftoff_chat', totalInputTokens: 0, totalOutputTokens: 0,
        estimatedCostUsd: 1.5, rawModelCostUsd: 1.4, ouConsumed: 75 },
      { purpose: 'caio_workforce_planning', totalInputTokens: 0, totalOutputTokens: 0,
        estimatedCostUsd: 0.8, rawModelCostUsd: 0.7, ouConsumed: 40 },
      // A charged purpose nobody has mapped to a surface yet.
      { purpose: 'some_future_purpose', totalInputTokens: 0, totalOutputTokens: 0,
        estimatedCostUsd: 0.25, rawModelCostUsd: 0.2, ouConsumed: 12 },
    ],
    webToolCosts: [
      { agentId: RANGE_AGENT, surface: null, toolName: 'web_research', callCount: 3, totalCostUsd: 0.6, ouConsumed: 30 },
      { agentId: null, surface: 'liftoff', toolName: 'browser_session', callCount: 1, totalCostUsd: 0.2, ouConsumed: 10 },
      { agentId: null, surface: 'team_plan', toolName: 'browser_session', callCount: 1, totalCostUsd: 0.4, ouConsumed: 20 },
      // An agent id the runtime never mapped.
      { agentId: STRANGER, surface: null, toolName: 'web_fetch_advanced', callCount: 2, totalCostUsd: 0.1, ouConsumed: 5 },
    ],
    sandboxCosts: [
      { agentId: RANGE_AGENT, runCount: 40, totalCostUsd: 5, ouConsumed: 250 },
      { agentId: GONE_AGENT,  runCount: 10, totalCostUsd: 1, ouConsumed: 50 },
    ],
    dataSourceCosts: [
      { agentId: RANGE_AGENT, surface: null, connector: 'apify', callCount: 6, totalCostUsd: 7, ouConsumed: 350 },
      { agentId: null, surface: 'team_plan', connector: 'locus', callCount: 1, totalCostUsd: 0.3, ouConsumed: 15 },
      { agentId: null, surface: null, connector: 'google_sheets', callCount: 9, totalCostUsd: 0.05, ouConsumed: 3 },
    ],
    voiceCosts: [{ agentId: RANGE_AGENT, totalCostUsd: 0.4, ouConsumed: 20 }],
  }));
}

describe('the total is the sum of what the table shows', () => {
  it('every group total is its own lines', () => {
    for (const group of fullModel()) {
      if (group.lines.length === 0) continue;   // flat rows carry no breakdown
      const lineUsd = group.lines.reduce((s, l) => s + l.usd, 0);
      const lineOus = group.lines.reduce((s, l) => s + (l.ous ?? 0), 0);
      expect(lineUsd).toBeCloseTo(group.usd, 10);
      expect(lineOus).toBeCloseTo(group.ous ?? 0, 10);
    }
  });

  it('the money card equals the sum of every rendered group', () => {
    const model = fullModel();
    const byHand = model.reduce((s, g) => s + g.usd, 0);
    expect(sumModelUsd(model)).toBeCloseTo(byHand, 10);
    // 13 invocation + 3.5 llm + 1.3 web + 6 sandbox + 7.35 data + 0.4 voice
    // + 2.3 assistants + 0.25 unattributed llm
    expect(sumModelUsd(model)).toBeCloseTo(34.1, 6);
  });

  it('the Operating Units card equals the sum of every rendered group', () => {
    const model = fullModel();
    expect(sumModelOus(model)).toBeCloseTo(model.reduce((s, g) => s + (g.ous ?? 0), 0), 10);
  });
});

describe('no charged input is dropped', () => {
  // The real defect was never a wrong sum — it was an input that reached no
  // group at all. So each source is asserted to MOVE the total.
  const sources: Array<[string, Partial<CostModelInput>]> = [
    ['web tools',    { webToolCosts: [{ agentId: null, surface: null, toolName: 'web_search', callCount: 1, totalCostUsd: 2, ouConsumed: 9 }] }],
    ['sandbox',      { sandboxCosts: [{ agentId: null, runCount: 1, totalCostUsd: 2, ouConsumed: 9 }] }],
    ['data sources', { dataSourceCosts: [{ agentId: null, surface: null, connector: 'apify', callCount: 1, totalCostUsd: 2, ouConsumed: 9 }] }],
    ['voice',        { voiceCosts: [{ agentId: null, totalCostUsd: 2, ouConsumed: 9 }] }],
    ['assistants',   { agentlessLLMCosts: [{ purpose: 'liftoff_chat', totalInputTokens: 0, totalOutputTokens: 0, estimatedCostUsd: 2, rawModelCostUsd: 1, ouConsumed: 9 }] }],
  ];

  it.each(sources)('%s reaches both cards', (_name, over) => {
    const model = buildCostModel(input(over));
    expect(sumModelUsd(model)).toBeCloseTo(2, 10);
    expect(sumModelOus(model)).toBeCloseTo(9, 10);
  });

  it("a removed agent's spend stays on the page", () => {
    const withTeam = buildCostModel(input({
      agents: [team(GONE_AGENT, 'Old Team', new Date())],
      sandboxCosts: [{ agentId: GONE_AGENT, runCount: 2, totalCostUsd: 4, ouConsumed: 20 }],
    }));
    expect(sumModelUsd(withTeam)).toBeCloseTo(4, 10);
    expect(withTeam[0].label).toBe('Old Team (removed)');
  });

  it('spend for an agent nobody can name is reported, not dropped', () => {
    const model = buildCostModel(input({
      webToolCosts: [{ agentId: STRANGER, surface: null, toolName: 'web_search', callCount: 1, totalCostUsd: 3, ouConsumed: 11 }],
    }));
    expect(sumModelUsd(model)).toBeCloseTo(3, 10);
    expect(model.map(g => g.kind)).toContain('unattributed');
  });
});

describe('a row that spent nothing is not a row', () => {
  // The Cost Breakdown answers where the money went, and a row of zeroes is
  // not an answer. It mattered the moment removed agents started rendering:
  // including them was right (a team deleted mid-period still spent money) but
  // it gave every team ever removed a row. A workspace with a long history
  // renders mostly lines of "$0.00 / 0.0% / —" with the real spend buried
  // inside them.

  it('drops an agent that did nothing this period', () => {
    const model = buildCostModel(input({
      agents: [team(RANGE_AGENT, 'Busy'), team(GONE_AGENT, 'Idle')],
      agentInvocationCosts: {
        [RANGE_AGENT]: { totalCostUsd: 5, ouConsumed: 20, invocationCount: 1 } as never,
      },
    }));
    expect(model.map(g => g.label)).toEqual(['Busy']);
  });

  it('drops a removed team that spent nothing, and keeps one that did', () => {
    const model = buildCostModel(input({
      agents: [team(RANGE_AGENT, 'Spent', new Date()), team(GONE_AGENT, 'Silent', new Date())],
      sandboxCosts: [{ agentId: RANGE_AGENT, runCount: 1, totalCostUsd: 2, ouConsumed: 9 }],
    }));
    expect(model.map(g => g.label)).toEqual(['Spent (removed)']);
  });

  it('keeps a row that consumed Operating Units at no charge', () => {
    // BYOK and absorbed buckets meter real usage at zero dollars. Those are
    // the rows a reader least expects and most needs: work that happened and
    // cost nothing. Dollars alone would hide them.
    const model = buildCostModel(input({
      agents: [team(RANGE_AGENT, 'Free but busy')],
      webToolCosts: [{ agentId: RANGE_AGENT, surface: null, toolName: 'web_search', callCount: 4, totalCostUsd: 0, ouConsumed: 12 }],
    }));
    expect(model.map(g => g.label)).toEqual(['Free but busy']);
    expect(model[0].ous).toBe(12);
  });

  it('drops an external agent with nothing in the window', () => {
    const model = buildCostModel(input({
      externalAgentStats: [{
        agentId: 'e1', agentName: 'Quiet Vendor', costType: 'per_month' as const,
        costAmount: 0, taskCount: 0, computedCostUsd: 0,
      }],
    }));
    expect(model).toHaveLength(0);
  });

  it('still totals what it keeps', () => {
    // Dropping empty rows must not change the answer — the cards are summed
    // over this model, so a filter that removed anything real would silently
    // understate the page all over again.
    const full = fullModel();
    expect(full.every(g => g.usd !== 0 || (g.ous ?? 0) !== 0)).toBe(true);
    expect(sumModelUsd(full)).toBeCloseTo(34.1, 6);
  });
});

describe('a sub-row that spent nothing is not a sub-row either', () => {
  // Dropping empty GROUPS left every kept group still listing all eight of its
  // lines, so a team that did no browsing, held no conversation and ran no
  // sandbox this week still showed "Voice — $0.00", "Sandbox — $0.00",
  // "Data Sources — $0.00". The fix stopped one level short of the thing it
  // was fixing, which is exactly the shape of defect this file exists for.

  it('a team that only ran work shows only the lines it used', () => {
    const model = buildCostModel(input({
      agents: [team(RANGE_AGENT, 'Runs things')],
      agentInvocationCosts: {
        [RANGE_AGENT]: { totalCostUsd: 9, ouConsumed: 450, invocationCount: 3 } as never,
      },
    }));
    expect(model[0].lines.map(l => l.label)).toEqual(['Invocations']);
  });

  it('keeps every line that has either money or Operating Units', () => {
    const model = buildCostModel(input({
      agents: [team(RANGE_AGENT, 'Busy')],
      agentInvocationCosts: {
        [RANGE_AGENT]: { totalCostUsd: 9, ouConsumed: 450, invocationCount: 3 } as never,
      },
      sandboxCosts: [{ agentId: RANGE_AGENT, runCount: 1, totalCostUsd: 4, ouConsumed: 20 }],
      // Metered, charged nothing — BYOK or an absorbed bucket. This is a fact
      // about the period, not an absence, so it stays.
      webToolCosts: [{ agentId: RANGE_AGENT, surface: null, toolName: 'web_search', callCount: 2, totalCostUsd: 0, ouConsumed: 7 }],
    }));
    expect(model[0].lines.map(l => l.label).sort()).toEqual(['Invocations', 'Sandbox', 'Web & browser']);
  });

  it('a group total is still the sum of the lines that remain', () => {
    // Dropping lines must not change what the group says, or the table stops
    // adding up and the cards stop matching it.
    for (const group of fullModel()) {
      if (group.lines.length === 0) continue;
      expect(group.lines.reduce((s, l) => s + l.usd, 0)).toBeCloseTo(group.usd, 10);
      expect(group.lines.reduce((s, l) => s + (l.ous ?? 0), 0)).toBeCloseTo(group.ous ?? 0, 10);
    }
  });

  it('no rendered line anywhere is empty', () => {
    for (const group of fullModel()) {
      for (const line of group.lines) {
        expect(line.usd !== 0 || (line.ous ?? 0) !== 0).toBe(true);
      }
    }
  });
});

describe('an amount too small to round is not shown as zero', () => {
  // A row that survives the empty-row filter can consume a few hundredths of
  // an Operating Unit and cost a fraction of a cent. Rendered "$0.00" it says
  // "this was free", which is the same thing the empty rows said — and a
  // reader who has just been told to trust this table cannot tell the two
  // apart.
  it('a fraction of a cent reads as less than a cent', () => {
    expect(formatCostUsd(0.0004)).toBe('<$0.01');
    expect(formatCostUsd(0.00449)).toBe('<$0.01');
  });

  it('a cent is still a cent, and rounding still rounds', () => {
    expect(formatCostUsd(0.01)).toBe('$0.01');
    expect(formatCostUsd(0.005)).toBe('$0.01');
    expect(formatCostUsd(1234.5)).toBe('$1,234.50');
  });

  it('a real zero is still zero', () => {
    // A row that metered usage at no charge — BYOK, an absorbed bucket — is
    // genuinely free, and saying "less than a cent" about it would be a lie in
    // the other direction.
    expect(formatCostUsd(0)).toBe('$0.00');
  });

  it('a credit keeps its sign', () => {
    expect(formatCostUsd(-0.0004)).toBe('>-$0.01');
    expect(formatCostUsd(-2.5)).toBe('-$2.50');
  });
});

describe('each platform assistant is named', () => {
  it('splits the three apart by purpose and surface', () => {
    const byLabel = new Map(fullModel().map(g => [g.label, g]));
    // Liftoff: its own chat, plus the browser session booked under 'liftoff'.
    expect(byLabel.get('Liftoff')!.usd).toBeCloseTo(1.5 + 0.2, 10);
    // The Chief AI Officer: planning, its browser session, and its data source.
    expect(byLabel.get('Chief AI Officer')!.usd).toBeCloseTo(0.8 + 0.4 + 0.3, 10);
    // The Insights Manager spent nothing, so it gets no row of zeroes.
    expect(byLabel.has('Insights Manager')).toBe(false);
  });

  it('an assistant that spends nothing is left off entirely', () => {
    expect(buildCostModel(input())).toHaveLength(0);
  });
});

describe('a team line carries its own tools', () => {
  it("includes the team's browser, data sources and sandbox", () => {
    const team1 = fullModel().find(g => g.label === 'Research Team')!;
    const lines = new Map(team1.lines.map(l => [l.label, l]));
    expect(lines.get('Web & browser')!.usd).toBeCloseTo(0.6, 10);
    expect(lines.get('Data Sources')!.usd).toBeCloseTo(7, 10);
    expect(lines.get('Sandbox')!.usd).toBeCloseTo(5, 10);
    // And the group total is not the invocation figure alone, which is what
    // ranking teams by cost used to read.
    expect(team1.usd).toBeGreaterThan(10);
  });

  it('a category total equals the per-team lines that make it up', () => {
    const model = fullModel();
    // 0.6 team + 0.2 Liftoff + 0.4 CAIO + 0.1 unattributed
    expect(sumLineAcrossModel(model, 'Web & browser').usd).toBeCloseTo(1.3, 10);
    expect(sumLineAcrossModel(model, 'Sandbox').usd).toBeCloseTo(6, 10);
    expect(sumLineAcrossModel(model, 'Data Sources').usd).toBeCloseTo(7.35, 10);
  });
});
