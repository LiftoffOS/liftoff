// Answers to a template's declared inputs must survive the whole way in, be
// substituted into its prose, and never be shared between two different answers.
//
// Every failure here is silent by construction, which is why each is asserted
// directly rather than left to an integration test:
//
//   1. Both distill routers validate with `z.object()`, which STRIPS undeclared
//      keys instead of rejecting them — exactly how `templateId` was lost for
//      every template hire. The POST router additionally rebuilt its call object
//      field by field, which drops a declared key one line after accepting it.
//
//   2. A `{{placeholder}}` that survives substitution reaches the agent's prompt
//      as literal braces. A team told to visit "{{company_website}}" will try.
//
//   3. The distillation cache is keyed by a fingerprint. tenantId separates
//      workspaces, but ONE workspace can hire the same template twice with
//      different answers — an agency, a holding company, or someone fixing a
//      typo. Without the answers in the key, the second hire silently receives
//      the first one's agent.

import { readFileSync } from 'fs';
import { join } from 'path';
import { __testOnlyDistillInputSchema as streamSchema } from '../distill-stream-router';
import { __testOnlyDistillInputSchema as postSchema } from '../distill-router';
import { computeFingerprint } from '../distill-cache';
import { applyTemplateInputs, type DistillInput } from '../distill-service';

const BASE = {
  role: 'Competitive Intelligence Analyst',
  responsibilities: '## Workflows\n1. Sweep each competitor weekly',
  integrations: [],
};

const ANSWERS = { company_name: 'Acme Corp', company_website: 'acme.com' };

describe('declared-input answers survive the routers', () => {
  it.each([
    ['stream', streamSchema],
    ['post', postSchema],
  ])('%s router keeps them rather than stripping them', (_label, schema) => {
    const parsed = schema.parse({ ...BASE, templateInputs: ANSWERS });
    expect(parsed.templateInputs).toEqual(ANSWERS);
  });

  it.each([
    ['stream', streamSchema],
    ['post', postSchema],
  ])('%s router still accepts a body with no answers at all', (_label, schema) => {
    // Most templates declare no inputs, so absence is the common case.
    expect(schema.parse(BASE).templateInputs).toBeUndefined();
  });
});

describe('applyTemplateInputs', () => {
  it('substitutes an answer into the template prose', () => {
    expect(applyTemplateInputs('Track {{company_name}} competitors', ANSWERS))
      .toBe('Track Acme Corp competitors');
  });

  it('substitutes every occurrence, not just the first', () => {
    expect(applyTemplateInputs('{{company_name}} and {{company_name}}', ANSWERS))
      .toBe('Acme Corp and Acme Corp');
  });

  it('tolerates whitespace inside the braces', () => {
    expect(applyTemplateInputs('for {{ company_name }}', ANSWERS)).toBe('for Acme Corp');
  });

  it('removes a placeholder with no answer rather than leaving braces', () => {
    // The regression this prevents: an optional input left blank reaching the
    // agent as the literal string "{{company_website}}".
    expect(applyTemplateInputs('See {{company_website}} for details', { company_name: 'Acme' }))
      .toBe('See  for details');
  });

  it('reads as the input\'s fallback phrase when the answer is blank', () => {
    // A blank optional input otherwise leaves the sentence without its object:
    // "argue from what  says". The phrase is declared beside the input, the
    // way an object's pick fallback is.
    expect(applyTemplateInputs(
      'Argue from what {{company_website}} says',
      { company_name: 'Acme' },
      { company_website: "the company's own website" },
    )).toBe("Argue from what the company's own website says");
  });

  it('prefers the answer over the fallback when both exist', () => {
    expect(applyTemplateInputs('See {{company_website}}', ANSWERS, { company_website: 'its website' }))
      .toBe('See acme.com');
  });

  it('applies a fallback to a whitespace-only answer too', () => {
    expect(applyTemplateInputs('See {{company_website}}', { company_website: '  ' }, { company_website: 'its website' }))
      .toBe('See its website');
  });

  it('removes a placeholder whose answer is only whitespace', () => {
    expect(applyTemplateInputs('See {{company_website}}', { company_website: '   ' }))
      .toBe('See ');
  });

  it('leaves text alone when there are no placeholders', () => {
    expect(applyTemplateInputs('No placeholders here', ANSWERS)).toBe('No placeholders here');
  });

  it('leaves unrelated braces alone', () => {
    // Templates contain literal examples like {filename}_v1.xlsx.
    expect(applyTemplateInputs('{filename}_v1.xlsx', ANSWERS)).toBe('{filename}_v1.xlsx');
  });
});

describe('answers are part of the cache key', () => {
  const input = (templateInputs?: Record<string, string>): DistillInput => ({
    role: BASE.role,
    responsibilities: BASE.responsibilities,
    integrations: [],
    tenantId: '11111111-1111-1111-1111-111111111111',
    templateInputs,
  });

  it('gives two companies in one workspace different keys', () => {
    expect(computeFingerprint(input({ company_name: 'Acme Corp' }), 'h', ''))
      .not.toBe(computeFingerprint(input({ company_name: 'Initech' }), 'h', ''));
  });

  it('treats a changed website as a different distillation', () => {
    expect(computeFingerprint(input({ company_name: 'A', company_website: 'a.com' }), 'h', ''))
      .not.toBe(computeFingerprint(input({ company_name: 'A', company_website: 'a.io' }), 'h', ''));
  });

  it('still hits for the same answers hired twice', () => {
    expect(computeFingerprint(input(ANSWERS), 'h', ''))
      .toBe(computeFingerprint(input(ANSWERS), 'h', ''));
  });

  it('does not depend on the order the answers were typed', () => {
    const a = computeFingerprint(input({ company_name: 'A', company_website: 'a.com' }), 'h', '');
    const b = computeFingerprint(input({ company_website: 'a.com', company_name: 'A' }), 'h', '');
    expect(a).toBe(b);
  });

  it('separates answering from not answering', () => {
    expect(computeFingerprint(input({ company_name: 'Acme' }), 'h', ''))
      .not.toBe(computeFingerprint(input(undefined), 'h', ''));
  });
});

describe('input fallbacks are wired at both ends', () => {
  // A phrase declared on the template but never handed to the substitution
  // would pass every test above and still leave the hole in a real hire.
  const SRC = readFileSync(join(__dirname, '..', 'distill-service.ts'), 'utf8');

  it('collects each declared fallback from the template that asked the question', () => {
    expect(SRC).toContain('for (const inp of tmpl.inputs ?? []) {');
    expect(SRC).toContain('if (inp.fallback) inputFallbacks[inp.id] = inp.fallback;');
  });

  it('hands them to the substitution the prose goes through', () => {
    expect(SRC).toContain('applyTemplateInputs(s, input.templateInputs, inputFallbacks)');
  });
});
