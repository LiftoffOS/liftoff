// Can the platform tell a fresh graph from a stale one?
//
// Until this existed it could not. `workflow_steps_hash` hashes the OUTPUT, so
// it catches steps being edited after review; nothing recorded what the steps
// were DERIVED from.
//
// Example: a code reviewer's responsibilities are edited to post into
// #code-reviewer and saved, which triggers a redistill. If the distiller
// regenerates `instructions_md` and returns no `workflowSteps`,
// `service.update` reads the absent `workflowSteps` as "leave unchanged" — so
// the graph keeps its Slack step hardcoding #engineering and the agent posts to
// the wrong channel. Every column is individually valid. Only the relationship
// between two of them is broken, and without a stored relationship the only
// way to find such agents is a regex over channel names — as brittle as it
// sounds, and blind to every other way a graph can go stale.
import { distillInputFingerprint, graphFreshness } from '../distill-input-fingerprint';

const base = {
  role: 'Code Reviewer',
  responsibilities: 'Review open pull requests and post to #engineering.',
  integrationTypes: ['github', 'slack'],
};

describe('distillInputFingerprint', () => {
  it('is stable for identical inputs', () => {
    expect(distillInputFingerprint(base)).toBe(distillInputFingerprint({ ...base }));
  });

  it('moves when the responsibilities change — the case that matters', () => {
    const after = { ...base, responsibilities: 'Review open pull requests and post to #code-reviewer.' };
    expect(distillInputFingerprint(after)).not.toBe(distillInputFingerprint(base));
  });

  it('moves when an integration is added', () => {
    expect(distillInputFingerprint({ ...base, integrationTypes: ['github', 'slack', 'jira'] }))
      .not.toBe(distillInputFingerprint(base));
  });

  it('ignores integration ORDER', () => {
    // Binding order is not a change in what the agent can reach.
    expect(distillInputFingerprint({ ...base, integrationTypes: ['slack', 'github'] }))
      .toBe(distillInputFingerprint(base));
  });

  it('ignores duplicate integration types', () => {
    expect(distillInputFingerprint({ ...base, integrationTypes: ['github', 'slack', 'slack'] }))
      .toBe(distillInputFingerprint(base));
  });

  it('ignores reflowed whitespace and case', () => {
    // An operator rewrapping a paragraph has not changed what they asked for.
    // A fingerprint that moves on formatting reports staleness that is not
    // there, and a sweep that cries wolf gets muted.
    expect(distillInputFingerprint({
      ...base,
      responsibilities: '  Review open pull requests\n  and post to #ENGINEERING.  ',
    })).toBe(distillInputFingerprint(base));
  });

  it('cannot be collided by moving text across the field boundary', () => {
    // The separator is a control character that cannot occur in the inputs, so
    // "ab"+"c" and "a"+"bc" stay distinct.
    const a = distillInputFingerprint({ role: 'ab', responsibilities: 'c', integrationTypes: [] });
    const b = distillInputFingerprint({ role: 'a', responsibilities: 'bc', integrationTypes: [] });
    expect(a).not.toBe(b);
  });
});

describe('graphFreshness', () => {
  const fp = distillInputFingerprint(base);

  it('reports fresh when the inputs still match', () => {
    expect(graphFreshness({ hasWorkflowSteps: true, storedFingerprint: fp, currentInputs: base }))
      .toBe('fresh');
  });

  it('reports stale when the responsibilities name a new channel', () => {
    // Graph distilled from the #engineering responsibilities; instructions now
    // say #code-reviewer.
    expect(graphFreshness({
      hasWorkflowSteps: true,
      storedFingerprint: fp,
      currentInputs: { ...base, responsibilities: 'Review open pull requests and post to #code-reviewer.' },
    })).toBe('stale');
  });

  it('reports unverifiable — NOT fresh — when nothing was recorded', () => {
    // Every pre-migration row is NULL. Folding those into "fresh" would be a
    // confident all-clear over data nobody checked, which is the same failure
    // this is meant to catch.
    expect(graphFreshness({ hasWorkflowSteps: true, storedFingerprint: null, currentInputs: base }))
      .toBe('unverifiable');
    expect(graphFreshness({ hasWorkflowSteps: true, storedFingerprint: '', currentInputs: base }))
      .toBe('unverifiable');
  });

  it('reports no_graph when there is nothing that can be stale', () => {
    // A prose-only agent is a valid hybrid outcome, not a finding.
    expect(graphFreshness({ hasWorkflowSteps: false, storedFingerprint: null, currentInputs: base }))
      .toBe('no_graph');
  });
});
