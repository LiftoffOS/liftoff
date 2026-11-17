import {
  buildPreferenceContractSection,
  selectInjectablePreferences,
  PREFERENCE_MIN_RECURRENCE,
  type RecurringPreference,
} from '../distill-preference-injection';

const pref = (over: Partial<RecurringPreference>): RecurringPreference => ({
  preferred: 'do X', rejected: 'do Y', reason: 'humans corrected this', recurrence: 5, ...over,
});

describe('distill preference injection (D2)', () => {
  it('returns empty when no preference recurs enough', () => {
    expect(buildPreferenceContractSection([])).toBe('');
    expect(buildPreferenceContractSection([pref({ recurrence: PREFERENCE_MIN_RECURRENCE - 1 })])).toBe('');
  });

  it('injects a contrastive section for sufficiently-recurrent preferences', () => {
    const s = buildPreferenceContractSection([pref({ preferred: 'cite sources', rejected: 'assert without citation' })]);
    expect(s).toContain('LEARNED PREFERENCES');
    expect(s).toContain('Prefer: cite sources');
    expect(s).toContain('Avoid: assert without citation');
  });

  it('selects only recurrent preferences, most-recurrent first, capped', () => {
    const prefs = Array.from({ length: 12 }, (_, i) => pref({ preferred: `p${i}`, recurrence: i }));
    const sel = selectInjectablePreferences(prefs);
    expect(sel.length).toBeLessThanOrEqual(8);
    expect(sel.every((p) => p.recurrence >= PREFERENCE_MIN_RECURRENCE)).toBe(true);
    // sorted descending by recurrence
    expect(sel[0].recurrence).toBeGreaterThanOrEqual(sel[sel.length - 1].recurrence);
  });
});
