// Authored flows become skills, and keep their identity while doing it.
//
// The property under test is not "a flow renders". It is that a flow's id
// SURVIVES: skill identity not surviving a republish is what orphans ~90% of
// agent_skill_metrics rows, so skill-level learning never accumulates. A
// renderer that produced the right text with a fresh id each time would pass
// every readable assertion and reproduce the exact defect.

import {
  flowsAsSkills,
  toolNotesAsSkill,
  toolNotesAsOverrides,
  mergeAuthoredSkills,
} from '../authored-flows';
import type { AgentTemplate } from '../../agent-templates/schema';
import type { Skill } from '../types';

const TEMPLATE = {
  id: 'code-reviewer',
  flows: [
    {
      id: 'first-pass-review',
      name: 'First-pass review of a change',
      useWhen: 'A change arrives at a head this run has not reviewed.',
      notNeededFor: 'A head already reviewed, which handle-review-feedback covers.',
      body: 'Review the diff in order.',
    },
  ],
  toolNotes: { version_control: 'Name the host in every reference.' },
  domainAliases: { diff: 'the set of changed lines in this change' },
} as unknown as AgentTemplate;

describe('a flow becomes a skill', () => {
  it('keeps the authored id as the skill id', () => {
    // The whole point. A minted id here would orphan every metric row keyed on
    // the last hire's id, silently, on every redistill.
    expect(flowsAsSkills(TEMPLATE)[0].id).toBe('first-pass-review');
  });

  it('puts both clauses of the retrieval key in the description', () => {
    // A description with only "use when" is a key with no boundary, and every
    // skill on the agent then competes for the same top-K slot.
    const d = flowsAsSkills(TEMPLATE)[0].description;
    expect(d).toContain('Use when:');
    expect(d).toContain('Not needed for:');
  });

  it('repeats the boundary inside the instruction', () => {
    // The retriever reads the key and the model reads the instruction. An
    // exclusion only one of them can see holds half the time.
    expect(flowsAsSkills(TEMPLATE)[0].instruction).toContain('Not needed for:');
  });

  it('marks it distilled, not operator', () => {
    // ADR-043: a redistill replaces the `distilled` slice and leaves `operator`
    // alone. An authored flow SHOULD be replaced by the next redistill of its
    // template — that is how a catalog edit reaches hired agents. Operator
    // would freeze the template's text against the template.
    expect(flowsAsSkills(TEMPLATE)[0].provenance).toBe('distilled');
  });

  it('glosses a domain term the body actually uses, and only then', () => {
    expect(flowsAsSkills(TEMPLATE)[0].instruction).toContain("'diff' means");
    const noAlias = flowsAsSkills({
      ...TEMPLATE, domainAliases: { listing: 'a property on the market' },
    } as AgentTemplate);
    expect(noAlias[0].instruction).not.toContain('means');
  });

  it('renders nothing for a template with no flows', () => {
    expect(flowsAsSkills({ id: 'x' } as AgentTemplate)).toEqual([]);
  });
});

describe('tool notes become one skill', () => {
  it('names the capabilities in the retrieval key', () => {
    const s = toolNotesAsSkill(TEMPLATE)!;
    expect(s.description).toContain('version_control');
    expect(s.instruction).toContain('Name the host');
  });

  it('is one skill rather than one per capability', () => {
    // They are all read at the same moment — while a call is being written —
    // so splitting them would make retrieval choose between notes that do not
    // compete.
    const many = toolNotesAsSkill({
      ...TEMPLATE, toolNotes: { version_control: 'a', team_chat: 'b' },
    } as AgentTemplate)!;
    expect(many.instruction).toContain('### version_control');
    expect(many.instruction).toContain('### team_chat');
  });

  it('is null when there are none', () => {
    expect(toolNotesAsSkill({ id: 'x' } as AgentTemplate)).toBeNull();
  });
});

describe('merging authored over generated', () => {
  const authored = flowsAsSkills(TEMPLATE);
  const gen = (name: string, id?: string): Skill =>
    ({ name, description: 'd', instruction: 'i', ...(id ? { id } : {}) });

  it('keeps a generated skill that covers different ground', () => {
    const merged = mergeAuthoredSkills([gen('Escalation routing')], authored);
    expect(merged.map((s) => s.name)).toContain('Escalation routing');
  });

  it('drops a generated skill colliding by id', () => {
    const merged = mergeAuthoredSkills([gen('Something else', 'first-pass-review')], authored);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('first-pass-review');
  });

  it('drops a generated skill colliding by name, case-insensitively', () => {
    // The distiller never sees the authored ids, so a generated skill covering
    // the same ground announces itself by name.
    const merged = mergeAuthoredSkills([gen('FIRST-PASS REVIEW OF A CHANGE')], authored);
    expect(merged).toHaveLength(1);
  });

  it('drops rather than keeps both', () => {
    // Keeping both is what puts two skills answering one request into a single
    // agent's top-K.
    const merged = mergeAuthoredSkills([gen('First-pass review of a change')], authored);
    expect(merged.filter((s) => /first-pass/i.test(s.name))).toHaveLength(1);
  });

  it('passes generated through untouched when nothing is authored', () => {
    const generated = [gen('A'), gen('B')];
    expect(mergeAuthoredSkills(generated, [])).toBe(generated);
  });
});

describe('tool notes reach their real destination', () => {
  // Phase 4 put tool notes in a skill "until Phase 6/D2 lands". It has landed,
  // and the skill was always the interim: a note about writing a pull-request
  // comment belongs ON that tool, read when the arguments are written, not in
  // something the model must first decide to retrieve.
  //
  // The translation is the difficulty. Notes are keyed by CAPABILITY so a rule
  // about reviewing code survives a GitHub-versus-GitLab rebinding; overrides
  // are keyed by TOOL NAME, because that is what a catalog has. So the
  // capability must be resolved through what is actually bound at this hire.
  const catalog = new Map<string, unknown>([
    ['github-a1b2c3d4__create_review_comment', {}],
    ['github-a1b2c3d4__get_pull_request', {}],
    ['slack-99887766__send_message', {}],
  ]);
  const integrations = [
    { id: 'a1b2c3d4-1111-2222-3333-444444444444', integrationId: 'github' },
    { id: '99887766-1111-2222-3333-444444444444', integrationId: 'slack' },
  ];
  const typesFor = (cap: string): string[] =>
    cap === 'version_control' ? ['github', 'gitlab'] : cap === 'team_chat' ? ['slack'] : [];

  it('attaches a capability note to every bound tool providing it', () => {
    const out = toolNotesAsOverrides(TEMPLATE, integrations, catalog, typesFor);
    expect(Object.keys(out).sort()).toEqual([
      'github-a1b2c3d4__create_review_comment',
      'github-a1b2c3d4__get_pull_request',
    ]);
    expect(out['github-a1b2c3d4__create_review_comment']).toContain('Name the host');
  });

  it('yields nothing for a capability this hire has not bound', () => {
    // Correct and silent: the note was about a tool the agent does not have,
    // so there is nothing to attach it to.
    const out = toolNotesAsOverrides(TEMPLATE, [], catalog, typesFor);
    expect(out).toEqual({});
  });

  it('appends when two capabilities resolve to one tool', () => {
    // Dropping the first would make which note survives depend on key order.
    const twoNotes = {
      ...TEMPLATE,
      toolNotes: { version_control: 'First rule.', team_chat: 'Second rule.' },
    } as typeof TEMPLATE;
    const bothTypes = (): string[] => ['github'];
    const out = toolNotesAsOverrides(twoNotes, integrations, catalog, bothTypes);
    const v = out['github-a1b2c3d4__create_review_comment'];
    expect(v).toContain('First rule.');
    expect(v).toContain('Second rule.');
  });

  it('yields nothing when the catalog is empty', () => {
    expect(toolNotesAsOverrides(TEMPLATE, integrations, new Map(), typesFor)).toEqual({});
  });
});
