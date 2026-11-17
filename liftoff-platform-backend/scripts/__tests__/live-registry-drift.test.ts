// The rule that decides whether a deploy is blocked.
//
// `check-live-registry-drift.cjs` runs inside the migrate Cloud Run job, which
// is the only place in the pipeline that can reach a live database. That makes
// its decision expensive to exercise end to end and easy to get wrong in the
// direction that matters: a gate that never fires costs nothing to run and
// protects nothing, and it looks exactly like a gate that is passing.
//
// So the comparison is a pure function and this is the suite that holds it to
// its contract. The worked example throughout is drift of the kind it exists
// to catch — grok-4.20-0309-non-reasoning recorded at 2,000,000 against the
// 1,000,000 the migration chain produces, which parks the turn guard at
// 1,400,000 tokens, above the model's real window, where it can never fire.

// The gate is a .cjs script, because it runs inside the migrate image where
// there is no TypeScript and no build step — only node and the deps the
// migration runner already carries. Requiring it here is what makes the test
// exercise the SAME file the deploy runs, rather than a copy of its logic.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { compareRegistry } = require('../ci/check-live-registry-drift.cjs') as {
  compareRegistry: (
    baseline: { models: Want[] },
    liveRows: Array<{ provider: string; model_id: string; context_window: number | string | null }>,
  ) => { drifted: Array<{ want: Want; recorded: number | null }>; absent: Want[] };
};

interface Want {
  provider: string;
  modelId: string;
  status: string;
  contextWindow: number;
}

const baselineOf = (models: Want[]): { models: Want[] } => ({ models });

const GROK: Want = {
  provider: 'xai',
  modelId: 'grok-4.20-0309-non-reasoning',
  status: 'approved',
  contextWindow: 1_000_000,
};

describe('a migration-owned window the live database disagrees with', () => {
  it('is drift, and names both answers', () => {
    const { drifted } = compareRegistry(baselineOf([GROK]), [
      { provider: 'xai', model_id: 'grok-4.20-0309-non-reasoning', context_window: 2_000_000 },
    ]);
    expect(drifted).toEqual([{ want: GROK, recorded: 2_000_000 }]);
  });

  it('is drift when the live value is NULL, and says NULL rather than 0', () => {
    // The window a consumer falls back on is 128,000, so a NULL where the chain
    // records 1,000,000 is the original defect, not a neutral absence. Coercing
    // it to 0 would report the wrong number in the failure.
    const { drifted } = compareRegistry(baselineOf([GROK]), [
      { provider: 'xai', model_id: 'grok-4.20-0309-non-reasoning', context_window: null },
    ]);
    expect(drifted).toEqual([{ want: GROK, recorded: null }]);
  });

  it('is NOT drift when the two agree', () => {
    const { drifted, absent } = compareRegistry(baselineOf([GROK]), [
      { provider: 'xai', model_id: 'grok-4.20-0309-non-reasoning', context_window: 1_000_000 },
    ]);
    expect(drifted).toEqual([]);
    expect(absent).toEqual([]);
  });

  it('is NOT drift when the driver hands the column back as a string', () => {
    // pg returns some numeric columns as strings depending on the type and the
    // driver's parser settings. A string/number comparison would report drift
    // on every row of every deploy, which is the fastest way to have a gate
    // switched off.
    const { drifted } = compareRegistry(baselineOf([GROK]), [
      { provider: 'xai', model_id: 'grok-4.20-0309-non-reasoning', context_window: '1000000' },
    ]);
    expect(drifted).toEqual([]);
  });
});

describe('what it deliberately does not call drift', () => {
  it('ignores a live model the chain never sized', () => {
    // A row created through the registry API, or one belonging to a provider
    // the pricing sync owns. The baseline excludes those at generation time;
    // anything else live is simply not this check's business.
    const { drifted, absent } = compareRegistry(baselineOf([GROK]), [
      { provider: 'xai', model_id: 'grok-4.20-0309-non-reasoning', context_window: 1_000_000 },
      { provider: 'glm', model_id: 'glm-5', context_window: 204_800 },
      { provider: 'anthropic', model_id: 'some-model-added-live', context_window: 7 },
    ]);
    expect(drifted).toEqual([]);
    expect(absent).toEqual([]);
  });

  it('reports a sized model with no live row as absent, NOT as drift', () => {
    // A different question — does the row exist — with different causes. It is
    // printed and does not fail: a gate that blocks every deploy on its own
    // edges gets removed rather than fixed.
    const { drifted, absent } = compareRegistry(baselineOf([GROK]), []);
    expect(drifted).toEqual([]);
    expect(absent).toEqual([GROK]);
  });

  it('matches on provider AND id, so the same id under another provider is not the same row', () => {
    // Grok's rows moved provider key twice (migrations 417 and 450). Matching
    // on the id alone would have compared a row against its own predecessor.
    const { drifted, absent } = compareRegistry(baselineOf([GROK]), [
      { provider: 'grok', model_id: 'grok-4.20-0309-non-reasoning', context_window: 2_000_000 },
    ]);
    expect(drifted).toEqual([]);
    expect(absent).toEqual([GROK]);
  });
});

describe('the whole registry at once', () => {
  it('reports every disagreement, not just the first', () => {
    const models: Want[] = [
      GROK,
      { provider: 'anthropic', modelId: 'claude-sonnet-5', status: 'approved', contextWindow: 1_000_000 },
      { provider: 'google', modelId: 'gemini-3.5-flash', status: 'approved', contextWindow: 1_048_576 },
    ];
    const { drifted } = compareRegistry(baselineOf(models), [
      { provider: 'xai', model_id: 'grok-4.20-0309-non-reasoning', context_window: 2_000_000 },
      { provider: 'anthropic', model_id: 'claude-sonnet-5', context_window: 1_000_000 },
      { provider: 'google', model_id: 'gemini-3.5-flash', context_window: 128_000 },
    ]);
    expect(drifted.map((d: { want: Want }) => d.want.modelId)).toEqual([
      'grok-4.20-0309-non-reasoning',
      'gemini-3.5-flash',
    ]);
  });

  it('passes an environment that matches the chain exactly', () => {
    const models: Want[] = [
      GROK,
      { provider: 'xai', modelId: 'grok-4.3', status: 'approved', contextWindow: 1_000_000 },
      { provider: 'xai', modelId: 'grok-4.6', status: 'approved', contextWindow: 500_000 },
    ];
    const { drifted, absent } = compareRegistry(baselineOf(models), [
      { provider: 'xai', model_id: 'grok-4.20-0309-non-reasoning', context_window: 1_000_000 },
      { provider: 'xai', model_id: 'grok-4.3', context_window: 1_000_000 },
      { provider: 'xai', model_id: 'grok-4.6', context_window: 500_000 },
    ]);
    expect(drifted).toEqual([]);
    expect(absent).toEqual([]);
  });
});
