// The destination a person picked has to reach the GRAPH, not only the prose.
//
// Suppose an operator hires a Competitive Intelligence Analyst and picks an
// existing Google Doc as its destination. If `user_instructions` carries the
// document id but `workflow_steps` and `system_prompt` do not, the graph
// resolves every document by title string instead, the picked document is never
// written to, and new ones are created beside it. Nothing fails: the graph is
// well-formed and the run reports success.
//
// Three wiring gaps upstream of the graph can cause this, each silent on its own:
//
//   1. Both distill routers validated `templatePicks` with a `z.object()` that
//      did not declare `kind`, and zod strips what it does not declare. So the
//      distiller could not tell a folder from a file, and the file/folder rule
//      could never fire on a distillation.
//   2. The cache fingerprinted a pick as `title|id`, so a file pick and a folder
//      pick on one id and one title shared an entry and could be served each
//      other's rule.
//   3. The rule itself was applied at STORAGE time, after the artifact and the
//      graph already existed, so the distiller never saw it.
//
// A fence closes the case the prompt cannot guarantee: a file destination whose
// id reaches no step.

import { __testOnlyDistillInputSchema as streamSchema } from '../distill-stream-router';
import { __testOnlyDistillInputSchema as postSchema } from '../distill-router';
import { computeFingerprint } from '../distill-cache';
import {
  buildDestinationSection,
  findMissingDestinationFileWrite,
  type DistillInput,
} from '../distill-service';
import { destinationRule } from '../destination-rule';
import { resolveTemplatePlaceholders } from '../template-placeholders';

const BASE = {
  role: 'Competitive Intelligence Analyst',
  responsibilities: '## Workflows\n1. Write the digest in {{pick:working-folder}}',
  integrations: [],
};

const FILE_PICK = {
  'working-folder': { id: '1YNfJz8INV8eWSM6cn010O', title: 'Competitive Digest', kind: 'file' as const },
};
const FOLDER_PICK = {
  'working-folder': { id: '1YNfJz8INV8eWSM6cn010O', title: 'Competitive Digest', kind: 'folder' as const },
};

describe('`kind` survives the distill routers', () => {
  // The whole of gap 1. `kind` is what tells a place to work in from the
  // deliverable itself, and the two are given opposite instructions.
  it.each([
    ['stream', streamSchema],
    ['post', postSchema],
  ])('%s router keeps a file destination rather than stripping its kind', (_label, schema) => {
    const parsed = schema.parse({ ...BASE, templatePicks: FILE_PICK });
    expect(parsed.templatePicks).toEqual(FILE_PICK);
  });

  it.each([
    ['stream', streamSchema],
    ['post', postSchema],
  ])('%s router keeps a folder destination too', (_label, schema) => {
    expect(schema.parse({ ...BASE, templatePicks: FOLDER_PICK }).templatePicks).toEqual(FOLDER_PICK);
  });

  it.each([
    ['stream', streamSchema],
    ['post', postSchema],
  ])('%s router refuses a kind that is neither', (_label, schema) => {
    // A value outside the pair would reach `namedDestination`, match neither
    // branch, and silently resolve to no rule at all.
    expect(schema.safeParse({
      ...BASE,
      templatePicks: { d: { id: 'x', title: 'y', kind: 'channel' } },
    }).success).toBe(false);
  });

  it.each([
    ['stream', streamSchema],
    ['post', postSchema],
  ])('%s router still accepts a pick with no kind', (_label, schema) => {
    // A channel or a table sends none, and most picks are one of those.
    const picks = { 'alert-channel': { id: 'C01', title: '#alerts' } };
    expect(schema.parse({ ...BASE, templatePicks: picks }).templatePicks).toEqual(picks);
  });
});

describe('the cache key tells a file destination from a folder', () => {
  // Gap 2. Same id, same title, opposite instructions.
  const input = (templatePicks: DistillInput['templatePicks']): DistillInput => ({
    role: BASE.role,
    responsibilities: BASE.responsibilities,
    integrations: [],
    tenantId: '11111111-1111-1111-1111-111111111111',
    templatePicks,
  });

  it('gives a file pick and a folder pick different keys', () => {
    expect(computeFingerprint(input(FILE_PICK), 'h', ''))
      .not.toBe(computeFingerprint(input(FOLDER_PICK), 'h', ''));
  });

  it('gives a kinded pick and the same pick with no kind different keys', () => {
    const unkinded = { 'working-folder': { id: FILE_PICK['working-folder'].id, title: 'Competitive Digest' } };
    expect(computeFingerprint(input(FILE_PICK), 'h', ''))
      .not.toBe(computeFingerprint(input(unkinded), 'h', ''));
  });

  it('still hits for the same file pick hired twice', () => {
    expect(computeFingerprint(input(FILE_PICK), 'h', ''))
      .toBe(computeFingerprint(input(FILE_PICK), 'h', ''));
  });

  it('still drops a pick that names nothing, kind or no kind', () => {
    // The filter guards the key against an empty pick counting as a choice, and
    // it is tested on TITLE AND ID for a reason: a pick that names nothing
    // produces no rule, so letting its `kind` move the key would split two
    // identical hires apart over a value neither of them uses.
    const bare = computeFingerprint(input({}), 'h', '');
    expect(computeFingerprint(input({ d: { id: '', title: '' } }), 'h', '')).toBe(bare);
    expect(computeFingerprint(input({ d: { id: ' ', title: ' ', kind: 'file' } }), 'h', '')).toBe(bare);
    expect(computeFingerprint(input({ d: { id: '', title: '', kind: 'folder' } }), 'h', '')).toBe(bare);
  });
});

describe('the distiller is told where the work goes, before it writes the graph', () => {
  // Gap 3. The section is in the user message beside the obligations.
  it('states the hub rule for a file, and demands the id in a step', () => {
    const section = buildDestinationSection(FILE_PICK);
    expect(section).toContain('WHERE THIS HIRE\'S WORK GOES');
    expect(section).toMatch(/UPDATE that document rather than creating a new one/);
    expect(section).toMatch(/LINK from that document/);
    expect(section).toContain(FILE_PICK['working-folder'].id);
    expect(section).toMatch(/A graph that carries the id nowhere is rejected/);
  });

  it('states the folder rule for a folder, and demands no id', () => {
    const section = buildDestinationSection(FOLDER_PICK);
    expect(section).toMatch(/Everything you produce goes in "Competitive Digest"/);
    // A folder id in a step cannot be honoured: create_document_markdown takes
    // a title and a body and no parent. Demanding it would reject correct work.
    expect(section).not.toMatch(/A graph that carries the id nowhere is rejected/);
  });

  it('says nothing at all when no destination was picked', () => {
    expect(buildDestinationSection(undefined)).toBe('');
    expect(buildDestinationSection({})).toBe('');
    expect(buildDestinationSection({ d: { id: 'C01', title: '#alerts' } })).toBe('');
  });

  it('carries the SAME rule the hire is stored with, verbatim', () => {
    // The point of the shared module. Two copies is how the stored prose and the
    // graph come to be told different things about one destination.
    const rule = destinationRule(FILE_PICK);
    expect(rule).not.toBe('');
    expect(buildDestinationSection(FILE_PICK)).toContain(rule);
    const stored = resolveTemplatePlaceholders(
      'competitive-intelligence-analyst',
      { responsibilities: 'r', additionalContext: '## Context\nWeekly.' },
      FILE_PICK,
    );
    expect(stored.additionalContext).toContain(rule);
  });

  it('obeys the copy rules the prose it embeds obeys', () => {
    const both = buildDestinationSection(FILE_PICK) + buildDestinationSection(FOLDER_PICK);
    expect(both).not.toContain('—');
    expect(both).not.toMatch(/\bagents?\b/i);
    expect(both).not.toMatch(/\{\{/);
  });
});

describe('a file destination is checked on the graph', () => {
  const ID = FILE_PICK['working-folder'].id;

  it('rejects a graph that carries the id nowhere', () => {
    // The defect: every document resolved by title string.
    const errors = findMissingDestinationFileWrite(FILE_PICK, [
      { description: 'Search for the document titled "Competitive Digest"', toolInputTemplate: '{"query":"Competitive Digest"}' },
      { description: 'Write the digest', toolInputTemplate: '{"title":"Competitive Digest","body":"{{steps.s7.digest}}"}' },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.type).toBe('missing_destination_write');
    expect(errors[0]!.stepId).toBe('workflowSteps');
    expect(errors[0]!.detail).toContain(ID);
    expect(errors[0]!.detail).toContain('Competitive Digest');
  });

  it('accepts the id in toolInputTemplate', () => {
    expect(findMissingDestinationFileWrite(FILE_PICK, [
      { description: 'Update the deliverable', toolInputTemplate: `{"document_id":"${ID}","body":"{{steps.s7.digest}}"}` },
    ])).toEqual([]);
  });

  it('accepts the id in static toolInput', () => {
    expect(findMissingDestinationFileWrite(FILE_PICK, [
      { description: 'Read the deliverable', toolInput: { document_id: ID } },
    ])).toEqual([]);
  });

  it('accepts the id in an llm_reason step description', () => {
    // A reasoning step has no call arguments; its description is what it reads.
    expect(findMissingDestinationFileWrite(FILE_PICK, [
      { description: `Compose the digest for document ${ID}.` },
    ])).toEqual([]);
  });

  it('does not count a condition or a failure edge as carrying it', () => {
    // Neither reaches a tool. Scanning the whole step object would have passed
    // this, which is why the scan names the three fields that execute.
    const steps: Array<Record<string, unknown>> = [
      { description: 'Write the digest' },
      { description: 'Branch', condition: `$.doc == "${ID}"`, onFailure: ID },
    ];
    expect(findMissingDestinationFileWrite(FILE_PICK, steps)).toHaveLength(1);
  });

  it('leaves a FOLDER destination alone', () => {
    // "Create it inside this folder" is an instruction a documents connector
    // cannot perform, so demanding the folder id would reject correct work.
    expect(findMissingDestinationFileWrite(FOLDER_PICK, [
      { description: 'Write the digest', toolInputTemplate: '{"title":"Competitive Digest"}' },
    ])).toEqual([]);
  });

  it('leaves a file destination with no id alone', () => {
    // Nothing addressable was named, so title matching is the only shape
    // available and rejecting it would leave the hire with no graph at all.
    expect(findMissingDestinationFileWrite(
      { d: { id: '   ', title: 'Competitive Digest', kind: 'file' } },
      [{ description: 'Write the digest' }],
    )).toEqual([]);
  });

  it('lapses with no destination picked, and on a pick that is not one', () => {
    expect(findMissingDestinationFileWrite(undefined, [{ description: 'x' }])).toEqual([]);
    expect(findMissingDestinationFileWrite({}, [{ description: 'x' }])).toEqual([]);
    expect(findMissingDestinationFileWrite(
      { d: { id: 'C01', title: '#alerts' } },
      [{ description: 'x' }],
    )).toEqual([]);
  });
});
