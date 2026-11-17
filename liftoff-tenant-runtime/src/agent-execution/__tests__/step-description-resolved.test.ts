// A step's instruction is resolved before the model reads it.
//
// `Step objective: ${step.description}` handed the description over raw, so a
// description saying "include the full answer text from {{steps.s5.body}}" gave
// the model a pointer where the content belongs. It cannot follow a pointer, so
// it paraphrases one — and the paraphrase reaches the person, as a reply like
// "there is no result from step s5 to return here".
//
// Resolving is the fix rather than scrubbing. The step id disappears BECAUSE the
// value replaces it, so nothing has to recognise an id as an id, and the step
// gets the material its author meant it to have. `ask_user` already renders its
// question this way.

import { readFileSync } from 'fs';
import { join } from 'path';
import { substitute } from '../template';

const SERVICE = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

describe('the step objective in the prompt', () => {
  it('is resolved, not interpolated into the prompt verbatim', () => {
    // Resolved once into `resolvedObjective` — its length is reported beside
    // the earlier-outputs section — and the objective line carries that name.
    expect(SERVICE).toMatch(/const resolvedObjective = resolveStepProse\(step\.description/);
    expect(SERVICE).toMatch(/`Step objective: \$\{resolvedObjective\}`/);
    // The raw form is what leaked; it must not come back.
    expect(SERVICE).not.toMatch(/`Step objective: \$\{step\.description\}`/);
  });

  it('is given the step registry, so {{steps.sN.x}} can resolve at all', () => {
    const call = SERVICE.slice(
      SERVICE.indexOf('const resolvedObjective = resolveStepProse('),
      SERVICE.indexOf('const resolvedObjective = resolveStepProse(') + 220,
    );
    expect(call).toContain('steps: stepOutputs');
  });
});

describe('what resolution does to the leak', () => {
  const CONTEXT = { steps: { s5: { body: 'The headline is "Run Your Company With AI".' } } };

  it('replaces the reference with the value, so no step id survives', () => {
    const authored = 'State plainly that NO reply was delivered, and include the full answer text from {{steps.s5.body}} here.';
    const resolved = substitute(authored, CONTEXT, { jsonContext: false });
    expect(resolved).toContain('Run Your Company With AI');
    expect(resolved).not.toContain('s5');
    expect(resolved).not.toContain('{{');
  });

  it('leaves an authored description with no references untouched', () => {
    const plain = 'Decide whether this message is a research request.';
    expect(substitute(plain, CONTEXT, { jsonContext: false })).toBe(plain);
  });
});
