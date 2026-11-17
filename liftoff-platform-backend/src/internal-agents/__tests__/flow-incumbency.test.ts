// Incumbency for flows a distillation INVENTED.
//
// A template's authored flows keep their ids by construction — the catalog
// wrote them. A Custom Hire has no template, so its first distillation mints
// the flows and those identities have to be made to survive deliberately.
//
// The harm of not doing it is measured: ~90% of agent_skill_metrics rows point
// at ids no live skill carries, because a redistill that paraphrases a skill's
// name mints a fresh id and strands every metric row behind it. Skill-level
// learning cannot accumulate across a redistill, which is most of what it is
// for.
//
// The rule is invented-once-then-OWNED: a flow's key is re-minted only when the
// changed responsibilities implicate it.

import {
  subjectTermsFor,
  flowIsImplicated,
  carryFlowIncumbency,
} from '../flow-incumbency';
import type { Skill } from '../types';

const skill = (over: Partial<Skill> & { name: string }): Skill => ({
  description: '', instruction: '', ...over,
});

describe('subjectTermsFor', () => {
  it('is about the name and the retrieval key, not the body', () => {
    // The body is the procedure and drifts on every rewording. A subject that
    // moved with the wording would make every rewrite look like a new flow.
    const terms = subjectTermsFor({
      name: 'Escalating a billing dispute',
      description: 'Use when a customer disputes an invoice.',
    });
    expect(terms).toContain('escalating');
    expect(terms).toContain('billing');
    expect(terms).toContain('dispute');
  });

  it('drops words too common to identify anything', () => {
    const terms = subjectTermsFor({ name: 'The agent and the team', description: '' });
    expect(terms).toEqual([]);
  });
});

describe('flowIsImplicated', () => {
  const subject = ['billing', 'dispute', 'invoice', 'refund'];

  it('is not implicated when the responsibilities still speak to it', () => {
    expect(flowIsImplicated(subject, 'Handle billing disputes and issue an invoice refund.')).toBe(false);
  });

  it('IS implicated when the responsibilities moved away', () => {
    expect(flowIsImplicated(subject, 'Review pull requests and comment on the diff.')).toBe(true);
  });

  it('tolerates rewording around the subject', () => {
    // Being strict here would re-mint on a typo fix and put us back where we
    // started.
    expect(flowIsImplicated(subject, 'Deal with any billing dispute promptly.')).toBe(false);
  });

  it('treats a subjectless flow as implicated', () => {
    expect(flowIsImplicated([], 'anything')).toBe(true);
  });
});

describe('carryFlowIncumbency', () => {
  const incumbent = skill({
    id: 'flow-1',
    name: 'Avoiding duplicate reviews',
    description: 'Use when the same head commit arrives twice.',
  });
  const RESP = 'Review each pull request once. Avoid duplicate reviews of the same head commit.';

  it('carries the id across a PARAPHRASED name', () => {
    // The case that orphans metrics today: mergeSkillsByProvenance falls back
    // to an exact lowercased name match, so a reworded skill misses and mints.
    const r = carryFlowIncumbency({
      incumbents: [incumbent],
      incoming: [skill({
        name: 'Preventing duplicate reviews',
        description: 'Use when the same head commit arrives twice.',
      })],
      mintedSubjects: undefined,
      responsibilities: RESP,
    });
    expect(r.skills[0].id).toBe('flow-1');
    expect(r.carried).toEqual(['flow-1']);
  });

  it('re-mints when the responsibilities moved away from the flow', () => {
    const r = carryFlowIncumbency({
      incumbents: [incumbent],
      incoming: [skill({ name: 'Summarising quarterly revenue' })],
      mintedSubjects: undefined,
      responsibilities: 'Summarise quarterly revenue for the finance team.',
    });
    expect(r.skills[0].id).toBeUndefined();
    expect(r.reminted).toEqual(['flow-1']);
  });

  it('never lends one identity to two flows', () => {
    // Two flows sharing an id would collide in agent_skill_metrics and make the
    // number it produces meaningless — worse than the orphaning being fixed.
    const r = carryFlowIncumbency({
      incumbents: [incumbent],
      incoming: [
        skill({ name: 'Avoiding duplicate reviews', description: 'Use when the same head commit arrives twice.' }),
        skill({ name: 'Avoiding duplicate reviews', description: 'Use when the same head commit arrives twice.' }),
      ],
      mintedSubjects: undefined,
      responsibilities: RESP,
    });
    const ids = r.skills.map((s) => s.id).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(1);
  });

  it('does not hand an identity to a merely adjacent flow', () => {
    // Two different flows that share vocabulary are still two flows. Handing
    // one the other's id silently retargets every metric row behind it.
    const r = carryFlowIncumbency({
      incumbents: [incumbent],
      incoming: [skill({ name: 'Requesting reviews from teammates' })],
      mintedSubjects: undefined,
      responsibilities: RESP,
    });
    expect(r.skills[0].id).toBeUndefined();
  });

  it('leaves an already-identified skill alone', () => {
    const r = carryFlowIncumbency({
      incumbents: [incumbent],
      incoming: [skill({ id: 'already', name: 'Avoiding duplicate reviews' })],
      mintedSubjects: undefined,
      responsibilities: RESP,
    });
    expect(r.skills[0].id).toBe('already');
  });

  it('prefers the RECORDED subject over re-deriving one', () => {
    // Re-deriving from the current text asks whether the flow suits the
    // responsibilities as they now read, which answers "yes" for a flow that
    // has quietly drifted from what it was for.
    const r = carryFlowIncumbency({
      incumbents: [incumbent],
      incoming: [skill({ name: 'Avoiding duplicate reviews' })],
      mintedSubjects: { 'flow-1': ['quarterly', 'revenue', 'finance'] },
      responsibilities: RESP,
    });
    // The recorded subject is nowhere in these responsibilities, so the
    // incumbent may not lend its identity.
    expect(r.reminted).toEqual(['flow-1']);
    expect(r.skills[0].id).toBeUndefined();
  });

  it('records a subject for every surviving flow', () => {
    const r = carryFlowIncumbency({
      incumbents: [incumbent],
      incoming: [skill({ id: 'x', name: 'Avoiding duplicate reviews' })],
      mintedSubjects: undefined,
      responsibilities: RESP,
    });
    expect(Object.keys(r.subjects)).toContain('x');
  });
});
