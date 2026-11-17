// The two authored prose fields are composed, not authored as markdown.
//
// `responsibilities` and `additionalContext` use a fixed set of `## ` headings,
// shared with the template validator and the catalog. Asking a model to emit
// that markdown means sometimes getting a flattened version of it — headings
// inlined as prose labels — which nothing downstream can distinguish from prose
// a user genuinely wrote that way. Filling slots and rendering headings in code
// removes the failure mode rather than detecting it.

import {
  composeAdditionalContext,
  composeResponsibilities,
} from '../workforce-plans/agent-prose.js';
import {
  ADDITIONAL_CONTEXT_SECTIONS,
  RESPONSIBILITIES_SECTIONS,
} from '@liftoffos/workforce-types';

describe('composeResponsibilities', () => {
  it('renders the canonical headings in canonical order', () => {
    const md = composeResponsibilities({
      responsibilities: 'Owns the daily sweep.',
      goals: 'One row per campaign.',
      workflows: 'Page 0 through 9, one at a time.',
      instructions: 'Never create a second tab.',
      outcomes: 'The sheet is current.',
    });

    expect(md.indexOf('## Responsibilities')).toBe(0);
    const order = RESPONSIBILITIES_SECTIONS.map(h => md.indexOf(h));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every(i => i >= 0)).toBe(true);
  });

  it('separates sections with a blank line, as the catalog does', () => {
    const md = composeResponsibilities({ responsibilities: 'A.', goals: 'B.' });
    expect(md).toBe('## Responsibilities\n\nA.\n\n## Goals\n\nB.');
  });

  it('omits a section rather than emitting an empty heading', () => {
    const md = composeResponsibilities({ responsibilities: 'A.', workflows: '   ' });
    expect(md).toContain('## Responsibilities');
    expect(md).not.toContain('## Workflows');
  });

  it('returns empty when nothing was filled, so callers can fall back', () => {
    expect(composeResponsibilities({})).toBe('');
  });

  it('keeps section bodies verbatim, including URLs and numbered steps', () => {
    const workflows = '1. Fetch https://example.test/x?a=1&b=2\n2. Write the rows before page N+1.';
    const md = composeResponsibilities({ workflows });
    expect(md).toContain(workflows);
  });
});

describe('composeAdditionalContext', () => {
  it('renders its own section set, not the responsibilities one', () => {
    const md = composeAdditionalContext({
      rules: 'Never write a second header row.',
      edgeCases: 'A rotated API key stops the run.',
    });

    expect(md).toBe(
      '## Rules\n\nNever write a second header row.\n\n## Edge cases\n\nA rotated API key stops the run.',
    );
    expect(md).not.toContain('## Responsibilities');
  });

  it('orders by the shared section list', () => {
    const md = composeAdditionalContext({
      anythingToAvoid: 'Z.',
      specificInstructions: 'A.',
      constraints: 'M.',
    });
    const order = ADDITIONAL_CONTEXT_SECTIONS.map(h => md.indexOf(h)).filter(i => i >= 0);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(md.indexOf('## Specific instructions')).toBe(0);
  });

  it('is independent of the responsibilities slots', () => {
    expect(composeAdditionalContext({ responsibilities: 'A.', goals: 'B.' })).toBe('');
  });
});
