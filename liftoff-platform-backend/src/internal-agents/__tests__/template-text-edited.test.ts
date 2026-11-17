// A hire whose prose was rewritten BEFORE it was created.
//
// `templateIdForRedistill` protects an owner's wording by comparing the agent's
// current text against the baseline recorded at create. That works because,
// historically, the only way to reach create was with the catalog's text
// verbatim — so the baseline WAS the template's text, and any later divergence
// was the owner's doing.
//
// Inline editing on the explore detail step ends that. The text now arrives
// already rewritten, and fingerprinting it would make it its own baseline:
// permanently equal to itself, so `templateIdForRedistill` would keep handing
// the id back and every redistill would re-seed from our catalog and drag their
// wording toward ours. Nothing would report it — the graph would just come back
// saying something they did not write.
//
// `templateTextEdited` is what closes that, by recording no baseline at all.
// These pin the consequence rather than the plumbing, because the plumbing is
// one ternary and the consequence is silent.

import { templateSourceHash, templateIdForRedistill, templateIdForObligations } from '../template-provenance';

const TEMPLATE_ID = 'accounts-payable-specialist';
const CATALOG_RESP = '## Workflows\n1. Extract the vendor name and total amount';
const CATALOG_CTX = '## Rules\n- Never modify a previously paid bill';
const THEIR_RESP = '## Workflows\n1. Extract the vendor name, total and due date';

/** What create() writes, given an input. Mirrors the ternary in service.ts. */
function rowFor(input: {
  templateId?: string;
  templateTextEdited?: boolean;
  responsibilities: string;
  additionalContext: string;
}) {
  return {
    templateId: input.templateId ?? null,
    templateSourceHash:
      input.templateId && !input.templateTextEdited
        ? templateSourceHash(input.responsibilities, input.additionalContext)
        : null,
    responsibilities: input.responsibilities,
    additionalContext: input.additionalContext,
  };
}

describe('a template hired unchanged', () => {
  const row = rowFor({
    templateId: TEMPLATE_ID,
    responsibilities: CATALOG_RESP,
    additionalContext: CATALOG_CTX,
  });

  it('records a baseline and re-seeds from the template', () => {
    expect(row.templateSourceHash).not.toBeNull();
    expect(templateIdForRedistill(row)).toBe(TEMPLATE_ID);
  });

  it('stops re-seeding once the owner edits it afterwards', () => {
    expect(templateIdForRedistill({ ...row, responsibilities: THEIR_RESP })).toBeNull();
  });
});

describe('a template rewritten before it was hired', () => {
  const row = rowFor({
    templateId: TEMPLATE_ID,
    templateTextEdited: true,
    responsibilities: THEIR_RESP,
    additionalContext: CATALOG_CTX,
  });

  it('records no baseline', () => {
    expect(row.templateSourceHash).toBeNull();
  });

  it('never re-seeds from the catalog, so their wording is never dragged back', () => {
    expect(templateIdForRedistill(row)).toBeNull();
  });

  it('would have re-seeded without the flag — which is the bug it exists for', () => {
    // The same hire, fingerprinted the old way: its own edited text becomes the
    // baseline, equal to itself forever, and the template id comes back.
    const withoutFlag = rowFor({
      templateId: TEMPLATE_ID,
      responsibilities: THEIR_RESP,
      additionalContext: CATALOG_CTX,
    });
    expect(templateIdForRedistill(withoutFlag)).toBe(TEMPLATE_ID);
  });

  it('keeps the template\'s declared obligations, which an edit never suspends', () => {
    // Deliberately NOT provenance-gated. Rewriting a sentence asks for different
    // words; it does not ask for the work to stop being delivered.
    expect(templateIdForObligations(row)).toBe(TEMPLATE_ID);
  });
});

describe('a bespoke hire', () => {
  it('has neither id nor baseline, and the flag changes nothing', () => {
    const row = rowFor({
      templateTextEdited: true,
      responsibilities: THEIR_RESP,
      additionalContext: '',
    });
    expect(row.templateSourceHash).toBeNull();
    expect(templateIdForRedistill(row)).toBeNull();
    expect(templateIdForObligations(row)).toBeNull();
  });
});
