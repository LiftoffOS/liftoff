// The eval set has to be guarded like any other measuring instrument: a task
// that cannot detect the thing reports a pass, and a pass from a broken task is
// worse than no task, because it reads as evidence.
//
// These are structural. They cannot tell you a skill is genuinely unreachable
// from a model's priors — that judgment lives in `loadBearingBecause` and in
// running the set. They CAN tell you the answer is sitting in the question, or
// in the one-line description the disclosed mode already shows, which are the
// two ways a task silently stops measuring anything.

import {
  DISCLOSURE_EVAL_TASKS,
  evalSkills,
  gradeAnswer,
  type DisclosureEvalTask,
} from '../disclosure-tasks';

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ');

describe('the disclosure eval set', () => {
  it('has stable, unique identity per task and per skill', () => {
    const taskIds = DISCLOSURE_EVAL_TASKS.map((t) => t.id);
    expect(new Set(taskIds).size).toBe(taskIds.length);

    const skillIds = DISCLOSURE_EVAL_TASKS.map((t) => t.skill.id);
    expect(new Set(skillIds).size).toBe(skillIds.length);
    for (const id of skillIds) {
      // read_skill rejects a non-uuid before it queries, so a malformed id here
      // would fail the disclosed arm for a reason that has nothing to do with
      // disclosure.
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it('never puts the answer in the question', () => {
    // The defect this catches: `skillEvidence` that also appears in the prompt.
    // The agent passes by echoing what it was just told, in BOTH modes, and the
    // task contributes a confident null result.
    const offenders: string[] = [];
    for (const t of DISCLOSURE_EVAL_TASKS) {
      for (const e of t.skillEvidence) {
        if (norm(t.prompt).includes(norm(e))) offenders.push(`${t.id}: "${e}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never puts the answer in the one-line description', () => {
    // In disclosed mode the description is all the model sees before deciding
    // whether to read. Evidence visible there is reachable WITHOUT read_skill,
    // so the task would report that disclosure is free when it was never tested.
    const offenders: string[] = [];
    for (const t of DISCLOSURE_EVAL_TASKS) {
      for (const e of t.skillEvidence) {
        if (norm(t.skill.description).includes(norm(e))) offenders.push(`${t.id}: "${e}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('can actually detect a failure on every task', () => {
    // A task with no evidence AND no prohibition measures nothing at all.
    const toothless = DISCLOSURE_EVAL_TASKS
      .filter((t) => t.skillEvidence.length + (t.mustNotContain?.length ?? 0) === 0)
      .map((t) => t.id);
    expect(toothless).toEqual([]);
  });

  it('cannot be passed by a refusal or an empty answer', () => {
    // The hole `substantive` exists to close, asserted against the real grader
    // rather than by inspecting the field: a purely-negative task passes every
    // prohibition when the agent says nothing at all.
    for (const t of DISCLOSURE_EVAL_TASKS) {
      expect(t.substantive.length).toBeGreaterThan(0);
      for (const empty of ['', 'I cannot help with that.', 'Error: request failed']) {
        expect(gradeAnswer(t, empty).pass).toBe(false);
      }
    }
  });

  it('states why each skill is load-bearing, in a sentence', () => {
    for (const t of DISCLOSURE_EVAL_TASKS) {
      // Not a length ritual: the field is the only record of the judgment that
      // decides whether the task is worth running, and an empty one means
      // somebody added a task without making that judgment.
      expect(t.loadBearingBecause.length).toBeGreaterThan(40);
      expect(t.skill.instruction.length).toBeGreaterThan(80);
      expect(t.skill.description.length).toBeGreaterThan(20);
    }
  });

  it('is big enough for a difference between the two arms to mean anything', () => {
    // Ten tasks: one task flipping is 10%, which is a difference worth looking
    // at rather than noise in a set of three.
    expect(DISCLOSURE_EVAL_TASKS.length).toBeGreaterThanOrEqual(10);
    // And varied enough that the result is not one skill shape repeated: a set
    // of ten formatting rules would say nothing about routing or thresholds.
    const tagged = new Set(DISCLOSURE_EVAL_TASKS.flatMap((t) => t.skill.tags));
    expect(tagged.size).toBeGreaterThanOrEqual(6);
  });

  it('seeds one skill per task, deduplicated', () => {
    const skills = evalSkills();
    expect(skills).toHaveLength(DISCLOSURE_EVAL_TASKS.length);
    expect(new Set(skills.map((s) => s.id)).size).toBe(skills.length);
  });
});

describe('grading', () => {
  const task = (over: Partial<DisclosureEvalTask> = {}): DisclosureEvalTask => ({
    id: 't', context: 'c',
    skill: { id: 'x', name: 'n', description: 'd', instruction: 'i', tags: [] },
    prompt: 'p',
    skillEvidence: ['S2'],
    mustNotContain: ['SEV1'],
    substantive: ['checkout'],
    loadBearingBecause: 'because',
    ...over,
  });

  it('passes an answer carrying the evidence and none of the priors', () => {
    expect(gradeAnswer(task(), 'Checkout is down. Grading this S2.').pass).toBe(true);
  });

  it('fails an answer that reached for the prior instead', () => {
    const v = gradeAnswer(task(), 'Checkout is down. Declaring SEV1.');
    expect(v.pass).toBe(false);
    expect(v.forbidden).toEqual(['SEV1']);
    expect(v.missingEvidence).toEqual(['S2']);
  });

  it('reads through formatting, because a bolded S2 is still an S2', () => {
    expect(gradeAnswer(task(), 'checkout — severity **S2**').pass).toBe(true);
    expect(gradeAnswer(
      task({ skillEvidence: ['Decision owner: Priya'], mustNotContain: [], substantive: ['x'] }),
      'x\nDecision owner:\n   Priya',
    ).pass).toBe(true);
  });

  it('does not read through a different number', () => {
    // The whole point is that 14 is not 30. Nothing about the matcher may
    // soften that.
    const t = task({ skillEvidence: ['14'], mustNotContain: ['30 days'], substantive: ['export'] });
    expect(gradeAnswer(t, 'Your export is available for 30 days.').pass).toBe(false);
  });

  it('separates "answered wrongly" from "did not answer"', () => {
    // These are different findings and must not collapse into one column: a
    // degenerate answer means the run failed, not that disclosure cost anything.
    const wrong = gradeAnswer(task(), 'Checkout is down. Declaring SEV1.');
    expect(wrong.notSubstantive).toEqual([]);

    const degenerate = gradeAnswer(task(), 'I cannot help with that.');
    expect(degenerate.notSubstantive).toEqual(['checkout']);
    expect(degenerate.forbidden).toEqual([]);
  });
});
