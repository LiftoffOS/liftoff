// Progressive skill disclosure.
//
// The saving is real — retrieved skills render in the VOLATILE prompt tier, so
// they are never cached and are re-sent every turn — but so is the cost: a
// round trip instead of passive reading, and a model that may skip guidance it
// would previously have absorbed for free. Off by default, and these assertions
// pin the two things that must hold whichever way the flag goes.

import { buildSkillContextBlock, skillDisclosureMode } from '../retrieval';
import { BASELINE_SKILLS } from '../baseline-skills';

const skills = [
  { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Escalation etiquette', description: 'When and how to escalate', instruction: 'Escalate only after two failed attempts, and say what you tried.' },
  { id: 'aaaaaaaa-0000-4000-8000-000000000002', name: 'Sheet formulas', description: 'Preserving formulas on write', instruction: 'Use valueInputOption=USER_ENTERED so formulas survive.' },
];

describe('the default is inline', () => {
  const original = process.env.SKILL_DISCLOSURE_MODE;
  afterEach(() => {
    if (original === undefined) delete process.env.SKILL_DISCLOSURE_MODE;
    else process.env.SKILL_DISCLOSURE_MODE = original;
  });

  it('is inline when the flag is unset', () => {
    delete process.env.SKILL_DISCLOSURE_MODE;
    expect(skillDisclosureMode()).toBe('inline');
  });

  // Never ship a first-guess default on something that changes what the model
  // reads. Anything other than the explicit opt-in value stays inline.
  it('is inline for any value that is not exactly "disclosed"', () => {
    for (const v of ['', 'true', '1', 'progressive', 'DISCLOSED']) {
      process.env.SKILL_DISCLOSURE_MODE = v;
      expect(skillDisclosureMode()).toBe('inline');
    }
  });

  it('is disclosed only for the exact opt-in', () => {
    process.env.SKILL_DISCLOSURE_MODE = 'disclosed';
    expect(skillDisclosureMode()).toBe('disclosed');
  });
});

describe('inline mode', () => {
  const block = buildSkillContextBlock(skills, 'inline');

  it('renders every retrieved instruction in full', () => {
    for (const s of skills) expect(block).toContain(s.instruction);
  });

  it('renders every baseline in full', () => {
    for (const b of BASELINE_SKILLS) expect(block).toContain(b.instruction);
  });

  it('offers no read_skill affordance', () => {
    expect(block).not.toContain('read_skill');
  });
});

describe('disclosed mode', () => {
  const block = buildSkillContextBlock(skills, 'disclosed');

  // The whole point: retrieved instructions are not in the prompt.
  it('lists retrieved skills by name and id instead of by body', () => {
    for (const s of skills) {
      expect(block).toContain(s.name);
      expect(block).toContain(s.id!);
      expect(block).toContain(s.description!);
      expect(block).not.toContain(s.instruction);
    }
  });

  it('tells the model how to read one', () => {
    expect(block).toContain('read_skill(id)');
  });

  // BASELINE_SKILLS are identity and safety guardrails, not retrieved
  // suggestions. A guardrail the model has to decide to go and read is not a
  // guardrail, so they stay inline and in full whatever the mode.
  it('keeps every baseline inline and in full', () => {
    for (const b of BASELINE_SKILLS) expect(block).toContain(b.instruction);
  });

  // The saving is in the BODIES, and it only exists once the bodies are worth
  // more than the one-off preamble that replaces them. Five retrieved skills of
  // realistic length is the shape production actually renders (topK = 5).
  it('is materially shorter for a realistic retrieved set', () => {
    const realistic = Array.from({ length: 5 }, (_, i) => ({
      id: `aaaaaaaa-0000-4000-8000-00000000000${i}`,
      name: `Skill ${i}`,
      description: `What skill ${i} is for`,
      instruction: `Step-by-step guidance for situation ${i}. `.repeat(20),
    }));
    const inline = buildSkillContextBlock(realistic, 'inline');
    const disclosed = buildSkillContextBlock(realistic, 'disclosed');
    expect(disclosed.length).toBeLessThan(inline.length / 2);
  });

  // And the honest converse, asserted rather than assumed: for a small set of
  // short skills the preamble costs MORE than the bodies it defers. This is why
  // the mode is flagged and eval-gated instead of defaulted on — the trade is
  // not free and does not always go the same way.
  it('costs more than it saves on a small set of short skills', () => {
    const inline = buildSkillContextBlock(skills, 'inline');
    expect(block.length).toBeGreaterThan(inline.length);
  });

  // A skill with no id cannot be fetched back, so listing it by name alone would
  // advertise guidance the model has no way to reach.
  it('renders an id-less skill in full rather than advertising an unreachable one', () => {
    const idless = [{ name: 'Legacy note', instruction: 'This one has no id.' }];
    const out = buildSkillContextBlock(idless, 'disclosed');
    expect(out).toContain('This one has no id.');
  });

  it('omits the request list entirely when nothing is listable', () => {
    const out = buildSkillContextBlock([], 'disclosed');
    expect(out).not.toContain('Guidance available on request');
  });

  // A baseline that also appears in the retrieved set must not be listed as
  // fetchable — it is already there in full, and offering to fetch it would
  // spend a round trip on text the model can already read.
  it('does not list a retrieved skill that collides with a baseline', () => {
    const collide = [{
      id: 'aaaaaaaa-0000-4000-8000-000000000009',
      name: BASELINE_SKILLS[0].name,
      description: 'shadow',
      instruction: 'shadowed instruction',
    }];
    const out = buildSkillContextBlock(collide, 'disclosed');
    expect(out).not.toContain('aaaaaaaa-0000-4000-8000-000000000009');
    expect(out).not.toContain('shadowed instruction');
    expect(out).toContain(BASELINE_SKILLS[0].instruction);
  });
});
