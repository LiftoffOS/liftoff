// Blast-radius quantifier — pure measurement.

import {
  DEFAULT_QUANTIFIER_THRESHOLDS,
  actionPortion,
  countClearedFields,
  countEntities,
  isDestructiveAction,
  quantifyPlan,
  type QuantifierThresholds,
  type RunningTotals,
} from '../plan-quantifier';

const ZERO: RunningTotals = { entitiesTouched: 0, destructiveOps: 0, clearedFields: 0 };

const TIGHT: QuantifierThresholds = {
  maxEntitiesTouched: 5,
  maxDestructiveOps: 3,
  maxClearedFields: 2,
  maxEntitiesPerBatch: 4,
};

describe('name resolution', () => {
  it('strips the SDK prefix so a connector tool is not invisible to the match', () => {
    expect(actionPortion('mcp__github-a1b2c3d4__delete_issue')).toBe('delete_issue');
  });

  it('strips a connector alias', () => {
    expect(actionPortion('crm__archive_deal')).toBe('archive_deal');
  });

  it('leaves a bare name alone', () => {
    expect(actionPortion('delete_record')).toBe('delete_record');
  });

  it.each([
    ['delete_record', true],
    ['crm__archive_deal', true],
    ['mcp__slack-99__remove_user', true],
    ['deactivate_account', true],
    ['update_contact', false],
    ['create_issue', false],
    ['list_messages', false],
  ])('classifies %s as destructive=%s', (name, expected) => {
    expect(isDestructiveAction(name)).toBe(expected);
  });

  it('strips an external-agent name prefix', () => {
    expect(actionPortion('partner:delete_thing')).toBe('delete_thing');
  });

  it.each([
    // Every separator this platform puts in front of an action. A prefix left
    // in the string is how an agent or alias whose NAME contains a destructive
    // verb turns all of its reads into destructive operations.
    ['archive_bot__list_messages', false],
    ['archive-bot:list_items', false],
    ['removal-service:get_status', false],
    ['mcp__archive-svc-a1b2__list_items', false],
    // …and the prefix must not hide a genuinely destructive action either.
    ['partner:delete_thing', true],
    ['mcp__github-a1b2__delete_branch', true],
  ])('classifies %s as destructive=%s whatever the prefix says', (name, expected) => {
    expect(isDestructiveAction(name)).toBe(expected);
  });
});

describe('entity counting', () => {
  it('counts an id array', () => {
    expect(countEntities({ ids: ['a', 'b', 'c'] })).toBe(3);
  });

  it('counts a single id', () => {
    expect(countEntities({ id: 'a' })).toBe(1);
  });

  it('sums across several identifier keys', () => {
    expect(countEntities({ record_ids: ['a', 'b'], message_id: 'm' })).toBe(3);
  });

  it('floors at one so an unrecognised call is never invisible to a cumulative bound', () => {
    expect(countEntities({ query: 'everything' })).toBe(1);
    expect(countEntities({})).toBe(1);
  });

  it('is case-insensitive on keys', () => {
    expect(countEntities({ EntityIds: ['a', 'b'] })).toBe(2);
  });
});

describe('cleared fields', () => {
  it('counts a field emptied where the snapshot had content', () => {
    expect(countClearedFields({ notes: '', owner: null }, { notes: 'important', owner: 'alice' })).toBe(2);
  });

  it('ignores a field that was already empty', () => {
    expect(countClearedFields({ notes: '' }, { notes: '' })).toBe(0);
  });

  it('ignores a field being SET rather than cleared', () => {
    expect(countClearedFields({ notes: 'new value' }, { notes: '' })).toBe(0);
  });

  it('counts an emptied array', () => {
    expect(countClearedFields({ tags: [] }, { tags: ['a'] })).toBe(1);
  });

  it('returns zero with no snapshot rather than guessing', () => {
    expect(countClearedFields({ notes: '' }, null)).toBe(0);
    expect(countClearedFields({ notes: '' }, undefined)).toBe(0);
  });
});

describe('quantifyPlan', () => {
  it('proceeds on a routine single-entity write', () => {
    const q = quantifyPlan([{ name: 'crm__update_deal', input: { id: 'd1', stage: 'won' } }], ZERO);
    expect(q.decision).toBe('proceed');
    expect(q.reasons).toEqual([]);
    expect(q.batch.entitiesTouched).toBe(1);
  });

  it('flags one call that names more entities than a batch may touch', () => {
    const ids = Array.from({ length: 300 }, (_, i) => `id-${i}`);
    const q = quantifyPlan([{ name: 'crm__delete_record', input: { ids } }], ZERO, TIGHT);
    expect(q.decision).toBe('confirm_required');
    expect(q.reasons[0]).toContain('300 items');
  });

  it('accumulates across calls — the failure a per-call check can never see', () => {
    // Four hundred deletes ONE AT A TIME. Every individual call is routine.
    let totals = ZERO;
    let firstGate = -1;
    for (let i = 0; i < 20; i++) {
      const q = quantifyPlan(
        [{ name: 'crm__delete_record', input: { id: `d${i}` } }],
        totals,
        TIGHT,
      );
      if (q.decision === 'confirm_required' && firstGate < 0) firstGate = i;
      totals = q.cumulative;
    }
    // maxDestructiveOps is 3, so the 4th call (index 3) crosses it.
    expect(firstGate).toBe(3);
    expect(totals.destructiveOps).toBe(20);
  });

  it('counts a destructive call against N entities as N destructive operations', () => {
    const q = quantifyPlan(
      [{ name: 'crm__archive_deal', input: { ids: ['a', 'b', 'c', 'd'] } }],
      ZERO,
      TIGHT,
    );
    expect(q.batch.destructiveOps).toBe(4);
    expect(q.reasons.some((r) => /deleted or archived 4 items/.test(r))).toBe(true);
  });

  it('treats a threshold as a ceiling to exceed, not one to reach', () => {
    // Exactly at the limit still proceeds; the next one does not.
    const at = quantifyPlan(
      [{ name: 'crm__archive_deal', input: { ids: ['a', 'b', 'c'] } }],
      ZERO,
      TIGHT,
    );
    expect(at.decision).toBe('proceed');
    const over = quantifyPlan(
      [{ name: 'crm__archive_deal', input: { id: 'd' } }],
      at.cumulative,
      TIGHT,
    );
    expect(over.decision).toBe('confirm_required');
  });

  it('does not count a non-destructive call toward destructive operations', () => {
    const q = quantifyPlan([{ name: 'crm__update_deal', input: { ids: ['a', 'b'] } }], ZERO, TIGHT);
    expect(q.batch.destructiveOps).toBe(0);
  });

  it('flags emptied fields, which no name-based rule would catch', () => {
    const q = quantifyPlan(
      [
        {
          name: 'crm__update_contact',
          input: { id: 'c1', notes: '', phone: '', email: '' },
          preActionSnapshot: { notes: 'history', phone: '555', email: 'a@b.c' },
        },
      ],
      ZERO,
      TIGHT,
    );
    expect(q.decision).toBe('confirm_required');
    expect(q.batch.clearedFields).toBe(3);
    expect(q.reasons.some((r) => /emptied 3 fields/.test(r))).toBe(true);
  });

  it('says so when it could not measure emptied fields', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `id-${i}`);
    const q = quantifyPlan([{ name: 'crm__delete_record', input: { ids } }], ZERO, TIGHT);
    expect(q.snapshotUnavailable).toBe(true);
    expect(q.reasons.some((r) => /no before-state was captured/.test(r))).toBe(true);
  });

  it('does not add the snapshot caveat when nothing is being flagged', () => {
    const q = quantifyPlan([{ name: 'crm__update_deal', input: { id: 'd1' } }], ZERO);
    expect(q.snapshotUnavailable).toBe(true);
    expect(q.reasons).toEqual([]);
  });

  it('never reports a population percentage, because no census exists', () => {
    const q = quantifyPlan([{ name: 'crm__delete_record', input: { ids: ['a'] } }], ZERO);
    expect(q.populationPercent).toBeNull();
  });

  it('handles an empty batch as a no-op', () => {
    const q = quantifyPlan([], ZERO);
    expect(q.decision).toBe('proceed');
    expect(q.cumulative).toEqual(ZERO);
    expect(q.snapshotUnavailable).toBe(false);
  });

  it('measures a genuinely multi-call batch as one plan', () => {
    const q = quantifyPlan(
      [
        { name: 'crm__delete_record', input: { ids: ['a', 'b'] } },
        { name: 'crm__delete_record', input: { ids: ['c', 'd'] } },
      ],
      ZERO,
      TIGHT,
    );
    expect(q.batch.entitiesTouched).toBe(4);
    expect(q.batch.destructiveOps).toBe(4);
  });

  it('ships defaults loose enough that a routine run does not gate', () => {
    let totals = ZERO;
    for (let i = 0; i < 5; i++) {
      const q = quantifyPlan(
        [{ name: 'crm__update_deal', input: { id: `d${i}`, stage: 'won' } }],
        totals,
        DEFAULT_QUANTIFIER_THRESHOLDS,
      );
      expect(q.decision).toBe('proceed');
      totals = q.cumulative;
    }
  });
});
