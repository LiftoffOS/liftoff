// What a hired agent STORES, not just what the distiller prompts with.
//
// The placeholder was resolved on its way into the model and left raw in the
// saved record. That put our own syntax on the edit screen, and — because picks
// are persisted nowhere else — left a later redistill with nothing to resolve
// from, so it substituted the generic fallback and the chosen destination
// silently disappeared.

import path from 'path';
import { initTemplateLoader, getTemplate } from '../../agent-templates/loader';
import { resolveTemplatePlaceholders } from '../template-placeholders';

beforeAll(() => {
  initTemplateLoader(path.join(__dirname, '..', '..', 'agent-templates', 'catalog'));
});

const RESP = 'Post the checklist to {{pick:alert-channel}} when it is ready.';

describe('resolveTemplatePlaceholders', () => {
  it('writes the destination a person chose into the stored prose', () => {
    const out = resolveTemplatePlaceholders(
      'cp-checklist-analyst',
      { responsibilities: RESP },
      { 'alert-channel': { id: 'C0123', title: '#deal-room' } },
    );
    expect(out.responsibilities).toContain('"#deal-room" (id C0123)');
    expect(out.responsibilities).not.toContain('{{');
  });

  it('falls back to the template phrase when an optional pick went unanswered', () => {
    // The same string the gallery rendered before hiring, so the sentence a
    // person read is the sentence the team is given.
    const out = resolveTemplatePlaceholders('cp-checklist-analyst', { responsibilities: RESP }, undefined);
    expect(out.responsibilities).toBe('Post the checklist to your deal channel when it is ready.');
  });

  it('resolves additionalContext on the same terms', () => {
    const out = resolveTemplatePlaceholders(
      'cp-checklist-analyst',
      { additionalContext: RESP },
      undefined,
    );
    expect(out.additionalContext).not.toContain('{{');
  });

  it('leaves no placeholder behind for a template that was renamed away', () => {
    // Braces on a screen are worse than a vague noun, so an unknown template
    // still resolves — with the shared default.
    const out = resolveTemplatePlaceholders('no-such-template', { responsibilities: RESP }, undefined);
    expect(out.responsibilities).not.toContain('{{');
  });

  it('leaves absent text absent rather than inventing an empty string', () => {
    const out = resolveTemplatePlaceholders('cp-checklist-analyst', {}, undefined);
    expect(out.responsibilities).toBeUndefined();
    expect(out.additionalContext).toBeUndefined();
  });

  it('resolves every placeholder the catalog actually ships', () => {
    // A pick whose id the template does not declare would resolve to the shared
    // default and read as a hole. The validator forbids that; this proves it for
    // the real text rather than a fixture.
    const t = getTemplate('cp-checklist-analyst')!;
    const out = resolveTemplatePlaceholders(
      t.id,
      { responsibilities: t.responsibilities, additionalContext: t.additionalContext },
      undefined,
    );
    expect(out.responsibilities).not.toMatch(/\{\{pick:/);
    expect(out.responsibilities).not.toContain('the connected workspace');
  });
});

// The clause a hired team actually reads, chosen by what was bound.
describe('connector prose variants', () => {
  const cp = () => getTemplate('cp-checklist-analyst')!;

  it('reads as the connected version when the connector is bound', () => {
    const out = resolveTemplatePlaceholders(
      'cp-checklist-analyst',
      { responsibilities: cp().responsibilities },
      { 'alert-channel': { id: 'C0123', title: '#deal-room' } },
      new Set(['slack']),
    );
    expect(out.responsibilities).toContain('post to "#deal-room" (id C0123) that it is ready');
  });

  it('never mentions the tool when it is not bound', () => {
    // The point of the mechanism: not an apology for the missing channel, a
    // sentence written as though it was never part of the job.
    const out = resolveTemplatePlaceholders(
      'cp-checklist-analyst',
      { responsibilities: cp().responsibilities },
      undefined,
      new Set(),
    );
    expect(out.responsibilities).toContain('open a chat thread saying it is ready');
    expect(out.responsibilities).not.toMatch(/channel/i);
    expect(out.responsibilities).not.toContain('post to');
    // And it delivers somewhere a person actually looks. "Return it in your run
    // output" satisfied the old assertion and reached nobody.
    expect(out.responsibilities).not.toMatch(/run output/i);
  });

  it('leaves no placeholder behind either way', () => {
    for (const bound of [new Set<string>(['slack']), new Set<string>()]) {
      const out = resolveTemplatePlaceholders(
        'cp-checklist-analyst',
        { responsibilities: cp().responsibilities },
        undefined,
        bound,
      );
      expect(out.responsibilities).not.toMatch(/\{\{/);
    }
  });

  it('drops the unbound clause whole, so its destination never leaks', () => {
    // Resolving picks first would have left "your deal channel" in a sentence
    // belonging to a team with no team chat at all.
    const out = resolveTemplatePlaceholders(
      'cp-checklist-analyst',
      { responsibilities: cp().responsibilities },
      { 'alert-channel': { id: 'C0123', title: '#deal-room' } },
      new Set(),
    );
    expect(out.responsibilities).not.toContain('#deal-room');
    expect(out.responsibilities).not.toContain('your deal channel');
  });
});
