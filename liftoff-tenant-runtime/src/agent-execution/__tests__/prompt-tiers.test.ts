// Ordering the system prompt so a prefix of it can be cached.
//
// Prompt caching pays only on a byte-identical PREFIX, which makes assembly
// order a performance decision rather than a stylistic one. One volatile block
// placed early invalidates every stable block after it for the whole session.

import { TieredPrompt } from '../prompt-tiers';

describe('tier ordering', () => {
  it('emits stable content before session before volatile, whatever order it was added in', () => {
    const p = new TieredPrompt()
      .add('volatile', 'THE OBJECTIVE')
      .add('stable', 'IDENTITY')
      .add('session', 'BROWSER SESSION')
      .add('stable', 'DIRECTIVES');

    const text = p.render();
    expect(text.indexOf('IDENTITY')).toBeLessThan(text.indexOf('BROWSER SESSION'));
    expect(text.indexOf('BROWSER SESSION')).toBeLessThan(text.indexOf('THE OBJECTIVE'));
  });

  it('keeps insertion order within a tier, so related blocks still read together', () => {
    const text = new TieredPrompt()
      .add('stable', 'FIRST')
      .add('stable', 'SECOND')
      .render();
    expect(text.indexOf('FIRST')).toBeLessThan(text.indexOf('SECOND'));
  });

  it('ignores empty and whitespace-only blocks rather than emitting blank gaps', () => {
    const text = new TieredPrompt()
      .add('stable', 'REAL')
      .add('stable', '')
      .add('stable', '   ')
      .add('stable', null)
      .add('stable', undefined)
      .render();
    expect(text).toBe('REAL');
  });
});

describe('the cacheable prefix', () => {
  it('covers exactly the stable content', () => {
    const p = new TieredPrompt()
      .add('stable', 'AAAA')
      .add('volatile', 'BBBBBBBB');
    expect(p.cacheablePrefixLength()).toBe('AAAA'.length);
  });

  it('is zero when there is nothing stable, rather than marking nothing', () => {
    const p = new TieredPrompt().add('volatile', 'ONLY VOLATILE');
    expect(p.cacheablePrefixLength()).toBe(0);
  });

  it('splits into a stable prefix and the rest', () => {
    const { stable, rest } = new TieredPrompt()
      .add('stable', 'IDENTITY')
      .add('session', 'LEDGER')
      .add('volatile', 'OBJECTIVE')
      .split();
    expect(stable).toBe('IDENTITY');
    expect(rest).toContain('LEDGER');
    expect(rest).toContain('OBJECTIVE');
    expect(rest).not.toContain('IDENTITY');
  });

  it('reports per-tier sizes, so we can tell whether the ordering pays', () => {
    const s = new TieredPrompt()
      .add('stable', 'ab')
      .add('volatile', 'cdef')
      .stats();
    expect(s.stable).toBe(2);
    expect(s.volatile).toBe(4);
    expect(s.session).toBe(0);
  });
});

describe('the assembly this fixed', () => {
  // Previously these read the source and compared the line numbers of
  // `prompt +=` statements, because line order WAS the ordering. It is not any
  // more — the tail declares each block's tier and the class decides the
  // order — so the property can be asserted on the output, which is both
  // stronger and immune to the assembly being rewritten again.
  const assembleTail = (opts: { withMemories: boolean; skills: string }): string => {
    const tail = new TieredPrompt();
    tail.add('stable', 'RESPONSE FORMAT DIRECTIVE');
    tail.add('stable', 'AUTONOMOUS OPERATION DIRECTIVE');
    tail.add('stable', 'MEMORY TOOL GUIDANCE');
    tail.add('volatile', opts.skills);
    tail.add('volatile', '## Current Objective\nship the thing');
    if (opts.withMemories) tail.add('volatile', 'MEMORY CONTEXT BLOCK');
    return tail.render();
  };

  it('puts the standing directives above the objective', () => {
    // These are byte-identical on every run of every agent. Below the objective
    // they were re-sent uncached every turn.
    const out = assembleTail({ withMemories: false, skills: 'SKILLS' });
    expect(out.indexOf('RESPONSE FORMAT DIRECTIVE')).toBeLessThan(out.indexOf('## Current Objective'));
    expect(out.indexOf('AUTONOMOUS OPERATION DIRECTIVE')).toBeLessThan(out.indexOf('## Current Objective'));
  });

  it('puts the standing directives above the recalled memories', () => {
    const out = assembleTail({ withMemories: true, skills: 'SKILLS' });
    expect(out.indexOf('AUTONOMOUS OPERATION DIRECTIVE')).toBeLessThan(out.indexOf('MEMORY CONTEXT BLOCK'));
  });

  it('renders the skill block with the volatile content, not above the directives', () => {
    // Skills are selected against THIS objective, so they change turn to turn.
    // Above the breakpoint they would invalidate the cache every turn.
    const out = assembleTail({ withMemories: false, skills: 'SKILLS' });
    expect(out.indexOf('SKILLS')).toBeGreaterThan(out.indexOf('RESPONSE FORMAT DIRECTIVE'));
  });

  it('holds the order whatever order the blocks were added in', () => {
    // The point of making the tiers data. A block appended in the obvious
    // place — at the bottom, after the volatile content — still lands above it.
    const tail = new TieredPrompt();
    tail.add('volatile', '## Current Objective');
    tail.add('volatile', 'SKILLS');
    tail.add('stable', 'A LATE STANDING DIRECTIVE');
    const out = tail.render();
    expect(out.indexOf('A LATE STANDING DIRECTIVE')).toBeLessThan(out.indexOf('## Current Objective'));
  });

  it('still always renders the skill block, baselines included', () => {
    // Gating on retrieved-skill count would strand an agent distilled with
    // skills:[] without its identity and communication guardrails.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'service.ts'), 'utf8',
    ) as string;
    // Unconditional: no `skills.length > 0 &&` guard in front of it. The mode
    // argument selects how they RENDER, never whether the block exists —
    // baselines are in it either way.
    //
    // Matched on the CALL rather than one exact spelling of its first argument:
    // the list passed in gains per-skill annotations (a skill that ships files
    // says where they are), and pinning the identifier made this fail for a
    // change that could not touch the property it protects.
    expect(src).toMatch(
      /const skillContextBlock = buildSkillContextBlock\([A-Za-z]+, skillDisclosureMode\(\)\);/,
    );
    expect(src).not.toMatch(/skills\.length > 0 && buildSkillContextBlock/);
    expect(src).toMatch(/tail\.add\('volatile', skillContextBlock\)/);
  });
});

describe('the wiring', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'service.ts'), 'utf8',
  ) as string;

  it('assembles the prompt tail through the tiers, not by line order', () => {
    // An order held only by the sequence of `prompt +=` lines and a comment
    // saying "volatile from here down" decays the first time somebody appends a
    // block in the obvious place. This class exists so the ordering is a
    // property of the data instead.
    expect(src).toMatch(/const tail = new TieredPrompt\(\)/);
    expect(src).toMatch(/tail\.add\('stable', responseFormatDirective\)/);
    expect(src).toMatch(/tail\.add\('volatile', skillContextBlock\)/);
    expect(src).toMatch(/prompt \+= `\\n\\n\$\{tail\.render\(\)\}`/);
  });

  it('appends the objective and memories as volatile, never stable', () => {
    // Both change turn to turn. Above the breakpoint they would invalidate the
    // cached prefix on every single turn, which is the bug this replaced.
    expect(src).toMatch(/tail\.add\('volatile', `## Current Objective/);
    expect(src).toMatch(/tail\.add\('volatile', buildMemoryContextBlock\(context\.memories\)\)/);
    expect(src).toMatch(/tail\.add\('volatile', context\.priorInvocationSummary\)/);
  });

  it('measures what the ordering buys, so a regression is visible', () => {
    // Without the measurement the tiers are an assertion. With it, a change
    // that pushes volatile content above the breakpoint shows up as the stable
    // share collapsing.
    expect(src).toMatch(/event: 'prompt_tier_layout'/);
    expect(src).toMatch(/cacheablePrefixChars/);
  });
});
