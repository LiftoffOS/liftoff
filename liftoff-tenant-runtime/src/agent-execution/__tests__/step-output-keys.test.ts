// What a step must actually put in its recorded output.
//
// The failure this closes was silent in the worst way: record_step_output WAS
// called, extraction of the declared field SUCCEEDED, and only the readers
// downstream discovered the value was a bare string. So these lean on the
// reads being the contract — a key something reads is required, a key nothing
// reads is not invented.
//
// The loop half is the same property with a sharper edge: a template read that
// finds nothing throws, while a LOOP read that finds nothing iterates zero
// times and reports success. So these also assert the third reader form is
// collected, and that an iterated key is told to be an array — because the
// general instruction for a key with no value is "set to null", and null is the
// one thing a loop cannot iterate.

import { readsFromStep, describeRequiredStepOutput, describeIteratedKeys } from '../step-output-keys';

const GRAPH = [
  { stepId: 's1' },
  { stepId: 's2', condition: '$.steps.s1.blocker is not null' },
  {
    stepId: 's3',
    toolInputTemplate: '{"command":"echo {{steps.s1.task_summary}} repo={{steps.s1.repo}}"}',
  },
  { stepId: 's4', toolInputTemplate: '{"command":"cd {{steps.s1.repo}}; {{steps.s5.install_cmd}}"}' },
];

/** The graph shape this module was extended for: the Competitive Intelligence
 *  Analyst's battle-card step, which iterates a key of s7's recorded output. */
const LOOP_GRAPH = [
  { stepId: 's7' },
  { stepId: 's9', loop: { over: 'steps.s7.cards_to_refresh' } },
];

const keys = (g: typeof GRAPH, id: string): string[] => readsFromStep(g, id).map((r) => r.key);

describe('readsFromStep', () => {
  it('collects every key read off the step, from templates and conditions alike', () => {
    expect(keys(GRAPH, 's1').sort()).toEqual(['blocker', 'repo', 'task_summary']);
  });

  it('deduplicates a key read by more than one step', () => {
    // `repo` appears in s3 and again in s4.
    expect(keys(GRAPH, 's1').filter((k) => k === 'repo')).toHaveLength(1);
  });

  it('does not attribute another step\'s reads to this one', () => {
    expect(keys(GRAPH, 's5')).toEqual(['install_cmd']);
  });

  it('returns nothing when the step is read by nobody — a real answer, not a failure', () => {
    expect(readsFromStep(GRAPH, 's3')).toEqual([]);
    expect(readsFromStep(GRAPH, 'sX')).toEqual([]);
  });

  it('ignores a step reading itself, which proves nothing about its own shape', () => {
    expect(readsFromStep(
      [{ stepId: 's1', toolInputTemplate: '{{steps.s1.echo}}' }], 's1',
    )).toEqual([]);
  });

  it('survives an empty or absent graph', () => {
    expect(readsFromStep(undefined, 's1')).toEqual([]);
    expect(readsFromStep([], 's1')).toEqual([]);
  });

  // The module-level regexes are `g`-flagged; sharing lastIndex between scans
  // would make the second call skip what the first consumed.
  it('is stable across repeated calls', () => {
    const a = readsFromStep(GRAPH, 's1');
    const b = readsFromStep(GRAPH, 's1');
    expect(b).toEqual(a);
  });

  it('marks a plain template or condition read as not iterated', () => {
    expect(readsFromStep(GRAPH, 's1').every((r) => r.iterated === false)).toBe(true);
  });

  // THE DEFECT. `loop.over` was the third reader form and it was collected
  // nowhere, so the contract named no keys at all and the producing step was
  // never told the one key a loop would iterate.
  describe('a loop.over read', () => {
    it('is collected, and marked iterated', () => {
      expect(readsFromStep(LOOP_GRAPH, 's7')).toEqual([
        { key: 'cards_to_refresh', iterated: true },
      ]);
    });

    it('is read through the executor\'s own parser, so every authored form counts', () => {
      for (const over of ['steps.s7.cards_to_refresh', '{{steps.s7.cards_to_refresh}}']) {
        expect(readsFromStep([{ stepId: 's7' }, { stepId: 's9', loop: { over } }], 's7'))
          .toEqual([{ key: 'cards_to_refresh', iterated: true }]);
      }
    });

    it('attributes a DEEPER path to the key, not the leaf, and does not call it iterated', () => {
      // `steps.s7.analysis.cards` requires `analysis`; what a loop iterates is a
      // path inside it, so the array requirement does not belong to `analysis`.
      expect(readsFromStep(
        [{ stepId: 's7' }, { stepId: 's9', loop: { over: 'steps.s7.analysis.cards' } }], 's7',
      )).toEqual([{ key: 'analysis', iterated: false }]);
    });

    it('ignores a bare or non-step collection, which names no step', () => {
      for (const over of ['items', 'output.plan.channels', 'input.names', '']) {
        expect(readsFromStep([{ stepId: 's7' }, { stepId: 's9', loop: { over } }], 's7')).toEqual([]);
      }
    });

    it('does not attribute another step\'s loop to this one', () => {
      expect(readsFromStep(LOOP_GRAPH, 's9')).toEqual([]);
    });

    it('stays iterated when a template reads the same key as well', () => {
      // A template that interpolates the key does not relax the array
      // requirement the loop puts on it.
      const g = [
        { stepId: 's7' },
        { stepId: 's8', toolInputTemplate: '{"n":"{{steps.s7.cards_to_refresh}}"}' },
        { stepId: 's9', loop: { over: 'steps.s7.cards_to_refresh' } },
      ];
      expect(readsFromStep(g, 's7')).toEqual([{ key: 'cards_to_refresh', iterated: true }]);
    });
  });
});

describe('describeRequiredStepOutput', () => {
  const read = (key: string, iterated = false) => ({ key, iterated });

  it('names every key and says they go INSIDE the recorded value', () => {
    const t = describeRequiredStepOutput('task', [read('repo'), read('blocker')]);
    expect(t).toContain('"repo"');
    expect(t).toContain('"blocker"');
    expect(t).toMatch(/MUST be an object/);
    expect(t).toMatch(/inside "task" — not alongside it/);
  });

  it('requires an undeterminable key to be present as null, so a read still resolves', () => {
    expect(describeRequiredStepOutput('task', [read('blocker')])).toMatch(/set to null/);
  });

  it('says nothing when nothing reads the step', () => {
    expect(describeRequiredStepOutput('task', [])).toBe('');
  });

  // The null instruction above is the trap for an iterated key, so the
  // exception has to be stated in the same sentence the model reads.
  it('excepts an iterated key from the null instruction and requires an array', () => {
    const t = describeRequiredStepOutput('analysis', [
      read('has_material'), read('cards_to_refresh', true),
    ]);
    expect(t).toMatch(/set to null/);
    expect(t).toContain('"cards_to_refresh"');
    expect(t).toMatch(/MUST be a JSON array/);
    expect(t).toMatch(/empty array/);
    expect(t).toMatch(/not null/);
    // The exception names only the iterated key.
    expect(t.slice(t.indexOf('set to null'))).not.toContain('"has_material"');
  });
});

describe('describeIteratedKeys', () => {
  it('says nothing when no key is iterated', () => {
    expect(describeIteratedKeys([])).toBe('');
  });

  it('reads as one key or as several', () => {
    const one = describeIteratedKeys([{ key: 'cards', iterated: true }]);
    expect(one).toMatch(/The key "cards" is the exception/);
    const two = describeIteratedKeys([
      { key: 'cards', iterated: true }, { key: 'alerts', iterated: true },
    ]);
    expect(two).toMatch(/The keys "cards", "alerts" are the exception/);
  });
});
