// Blast-radius gating: mode switch, accumulation, and what reaches the card.

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../infrastructure/logging', () => ({ logger: mockLog }));

// The persisted counter, standing in for the table. Keyed the same way the row
// is, so the "another pod already counted this" cases are real rather than
// simulated with a mock return value.
const store = new Map<string, { entitiesTouched: number; destructiveOps: number; clearedFields: number }>();
const mockRead = jest.fn(async (tenantId: string, invocationId: string) =>
  store.get(`${tenantId}:${invocationId}`) ?? { entitiesTouched: 0, destructiveOps: 0, clearedFields: 0 });
const mockIncrement = jest.fn(async (
  tenantId: string,
  invocationId: string,
  batch: { entitiesTouched: number; destructiveOps: number; clearedFields: number },
) => {
  const key = `${tenantId}:${invocationId}`;
  const cur = store.get(key) ?? { entitiesTouched: 0, destructiveOps: 0, clearedFields: 0 };
  const next = {
    entitiesTouched: cur.entitiesTouched + batch.entitiesTouched,
    destructiveOps: cur.destructiveOps + batch.destructiveOps,
    clearedFields: cur.clearedFields + batch.clearedFields,
  };
  store.set(key, next);
  return next;
});
jest.mock('../blast-radius-store', () => ({
  readRunTotals: (...a: [string, string]) => mockRead(...a),
  incrementRunTotals: (...a: [string, string, { entitiesTouched: number; destructiveOps: number; clearedFields: number }]) => mockIncrement(...a),
}));

import {
  BLAST_RADIUS_GATE_REASON,
  commitBlastRadius,
  evaluateBlastRadius,
  quantifierMode,
  quantifierThresholds,
  type BlastRadiusRunState,
} from '../blast-radius-gate';

const ENV_KEYS = [
  'QUANTIFIER_MODE',
  'QUANTIFIER_MAX_ENTITIES',
  'QUANTIFIER_MAX_DESTRUCTIVE',
  'QUANTIFIER_MAX_CLEARED_FIELDS',
  'QUANTIFIER_MAX_PER_BATCH',
] as const;

function newState(invocationId = 'inv-1'): BlastRadiusRunState {
  return { context: { tenantId: 't1', agentId: 'a1', invocationId } };
}

const bulkDelete = (n: number) => [{
  name: 'crm__delete_record',
  input: { ids: Array.from({ length: n }, (_, i) => `id-${i}`) },
}];

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('mode switch', () => {
  it('defaults to off', () => {
    expect(quantifierMode()).toBe('off');
  });

  it('treats an unrecognised value as off rather than guessing', () => {
    process.env.QUANTIFIER_MODE = 'yes-please';
    expect(quantifierMode()).toBe('off');
  });

  it('does nothing at all when off — no measurement, no database write', async () => {
    const state = newState();
    expect(await evaluateBlastRadius(state, bulkDelete(5000), 'test')).toBeNull();
    await commitBlastRadius(state, bulkDelete(5000));
    expect(state.blastRadiusTotals).toBeUndefined();
    expect(mockLog.info).not.toHaveBeenCalled();
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockIncrement).not.toHaveBeenCalled();
  });
});

describe('shadow mode', () => {
  beforeEach(() => {
    process.env.QUANTIFIER_MODE = 'shadow';
    process.env.QUANTIFIER_MAX_PER_BATCH = '10';
  });

  it('measures and reports without gating anything', async () => {
    const decision = await evaluateBlastRadius(newState(), bulkDelete(400), 'test');
    expect(decision).not.toBeNull();
    expect(decision!.shouldGate).toBe(false);
    expect(decision!.reasons.length).toBeGreaterThan(0);
    expect(decision!.quantification.decision).toBe('confirm_required');
  });

  it('logs what it would have done, marked as not enforced', async () => {
    await evaluateBlastRadius(newState(), bulkDelete(400), 'test');
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'shadow', enforced: false }),
      expect.stringMatching(/would have paused/i),
    );
  });

  it('also observes the batches that stay under the bound', async () => {
    // Calibration needs the whole distribution, not only its tail.
    await evaluateBlastRadius(newState(), bulkDelete(2), 'test');
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'blast_radius.observed' }),
      expect.any(String),
    );
  });

  it('emits those observations at a level the deployment actually writes', async () => {
    // The deployment's level is `info`. A debug line is written nowhere, so
    // the calibration window would produce a distribution consisting only of
    // its own tail — and a threshold fitted to that can only get looser.
    await evaluateBlastRadius(newState(), bulkDelete(2), 'test');
    expect(mockLog.debug).not.toHaveBeenCalled();
  });
});

describe('enforce mode', () => {
  beforeEach(() => {
    process.env.QUANTIFIER_MODE = 'enforce';
    process.env.QUANTIFIER_MAX_PER_BATCH = '10';
  });

  it('gates a plan over the bound', async () => {
    const decision = await evaluateBlastRadius(newState(), bulkDelete(400), 'test');
    expect(decision!.shouldGate).toBe(true);
    expect(decision!.reasons[0]).toContain('400 items');
  });

  it('leaves a routine plan alone', async () => {
    const decision = await evaluateBlastRadius(newState(), bulkDelete(2), 'test');
    expect(decision!.shouldGate).toBe(false);
    expect(decision!.reasons).toEqual([]);
  });

  it('uses a reason the review queue can label', () => {
    expect(BLAST_RADIUS_GATE_REASON).toBe('blast_radius');
  });

  it('drops back to debug once the distribution is no longer being gathered', async () => {
    await evaluateBlastRadius(newState(), bulkDelete(2), 'test');
    expect(mockLog.debug).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'blast_radius.observed' }),
      expect.any(String),
    );
  });
});

describe('accumulation across a run', () => {
  beforeEach(() => {
    process.env.QUANTIFIER_MODE = 'enforce';
    process.env.QUANTIFIER_MAX_DESTRUCTIVE = '5';
    process.env.QUANTIFIER_MAX_PER_BATCH = '1000';
    process.env.QUANTIFIER_MAX_ENTITIES = '1000';
  });

  it('catches deletes issued one at a time, which per-call inspection cannot', async () => {
    const state = newState();
    const gated: number[] = [];
    for (let i = 0; i < 10; i++) {
      const call = [{ name: 'crm__delete_record', input: { id: `d${i}` } }];
      const decision = await evaluateBlastRadius(state, call, 'test');
      if (decision!.shouldGate) gated.push(i);
      else await commitBlastRadius(state, call);
    }
    // Five singles commit, the sixth crosses the bound.
    expect(gated[0]).toBe(5);
    expect(state.blastRadiusTotals!.destructiveOps).toBe(5);
  });

  it('does not charge a run for a batch that gated and never ran', async () => {
    const state = newState();
    const decision = await evaluateBlastRadius(state, bulkDelete(50), 'test');
    expect(decision!.shouldGate).toBe(true);
    // The caller commits only on the dispatch path.
    expect(mockIncrement).not.toHaveBeenCalled();
  });

  it('charges a run for a batch that was dispatched', async () => {
    const state = newState();
    await commitBlastRadius(state, [{ name: 'crm__update_deal', input: { ids: ['a', 'b'] } }]);
    expect(state.blastRadiusTotals).toEqual({
      entitiesTouched: 2,
      destructiveOps: 0,
      clearedFields: 0,
    });
  });
});

describe('a read has no blast radius', () => {
  beforeEach(() => {
    process.env.QUANTIFIER_MODE = 'enforce';
    process.env.QUANTIFIER_MAX_ENTITIES = '3';
    process.env.QUANTIFIER_MAX_PER_BATCH = '1000';
  });

  it('is neither measured nor charged, however many there are', async () => {
    const state = newState();
    for (let i = 0; i < 10; i++) {
      const call = [{ name: 'web_fetch_advanced', input: { url: `https://site${i}.test/` }, effect: 'read' as const }];
      const decision = await evaluateBlastRadius(state, call, 'test');
      expect(decision).toBeNull();
      await commitBlastRadius(state, call);
    }
    expect(mockIncrement).not.toHaveBeenCalled();
    expect(state.blastRadiusTotals).toBeUndefined();
  });

  it('leaves the writes beside it in a batch measured', async () => {
    const state = newState();
    const batch = [
      { name: 'web_fetch_advanced', input: { url: 'https://a.test/' }, effect: 'read' as const },
      { name: 'crm__update_deal', input: { ids: ['a', 'b', 'c', 'd'] }, effect: 'write' as const },
    ];
    const decision = await evaluateBlastRadius(state, batch, 'test');
    expect(decision!.shouldGate).toBe(true);
    expect(decision!.quantification.batch.entitiesTouched).toBe(4);
  });

  it('a call whose effect is unknown is still measured — the bound fails closed', async () => {
    const state = newState();
    const calls = Array.from({ length: 4 }, (_, i) => [{ name: 'mystery_tool', input: { id: `m${i}` } }]);
    let gated = false;
    for (const call of calls) {
      const decision = await evaluateBlastRadius(state, call, 'test');
      if (decision!.shouldGate) { gated = true; break; }
      await commitBlastRadius(state, call);
    }
    expect(gated).toBe(true);
  });
});

describe('totals are shared across processes, not held in one', () => {
  beforeEach(() => {
    process.env.QUANTIFIER_MODE = 'enforce';
    process.env.QUANTIFIER_MAX_DESTRUCTIVE = '5';
    process.env.QUANTIFIER_MAX_PER_BATCH = '1000';
    process.env.QUANTIFIER_MAX_ENTITIES = '1000';
  });

  it('a fresh state reads what another process already counted', async () => {
    // This is the sandbox case: a script dispatches over HTTP, possibly onto a
    // different pod, with no in-memory total to inherit. Without the persisted
    // row it would measure against zero and report a per-call number as a run
    // total.
    store.set('t1:inv-1', { entitiesTouched: 0, destructiveOps: 5, clearedFields: 0 });

    const elsewhere = newState();
    const decision = await evaluateBlastRadius(
      elsewhere,
      [{ name: 'crm__delete_record', input: { id: 'x' } }],
      'sandbox-dispatch',
    );
    expect(decision!.shouldGate).toBe(true);
  });

  it('two paths in one run add rather than overwrite', async () => {
    const llmLoop = newState();
    const sandbox = newState();

    await commitBlastRadius(llmLoop, [{ name: 'crm__delete_record', input: { ids: ['a', 'b'] } }]);
    await commitBlastRadius(sandbox, [{ name: 'crm__delete_record', input: { ids: ['c'] } }]);

    expect(store.get('t1:inv-1')!.destructiveOps).toBe(3);
  });

  it('keeps runs separate', async () => {
    await commitBlastRadius(newState('inv-1'), bulkDelete(3));
    const other = await evaluateBlastRadius(newState('inv-2'), bulkDelete(1), 'test');
    expect(other!.quantification.cumulative.destructiveOps).toBe(1);
  });

  it('measures against zero when there is no invocation to key on', async () => {
    // Nothing to accumulate against, so it is not guessed at.
    const stateless: BlastRadiusRunState = { context: { tenantId: 't1', agentId: 'a1' } };
    await commitBlastRadius(stateless, bulkDelete(3));
    expect(mockIncrement).not.toHaveBeenCalled();
    expect(mockRead).not.toHaveBeenCalled();
  });
});

describe('thresholds', () => {
  it('ships defaults', () => {
    expect(quantifierThresholds()).toEqual({
      maxEntitiesTouched: 25,
      maxDestructiveOps: 10,
      maxClearedFields: 20,
      maxEntitiesPerBatch: 15,
    });
  });

  it('takes calibration from configuration, not a deploy', () => {
    process.env.QUANTIFIER_MAX_ENTITIES = '150';
    expect(quantifierThresholds().maxEntitiesTouched).toBe(150);
  });

  it('ignores a nonsense override rather than disabling the bound', () => {
    process.env.QUANTIFIER_MAX_ENTITIES = 'lots';
    expect(quantifierThresholds().maxEntitiesTouched).toBe(25);
    process.env.QUANTIFIER_MAX_ENTITIES = '0';
    expect(quantifierThresholds().maxEntitiesTouched).toBe(25);
  });
});
