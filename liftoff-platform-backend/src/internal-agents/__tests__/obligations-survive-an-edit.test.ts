// Editing a sentence must not switch off the guarantee that the work is
// delivered.
//
// `templateIdForRedistill` returns null once an owner has edited a hire's text,
// so a redistill cannot drag their wording back toward ours. That is right, and
// it was also the only route to the template's DECLARATIONS. Every fence reads
// its obligation off the template, so a null id skipped all of them at once.
//
// Without that, an agent whose text has been edited can be redistilled and come
// back with no `open_chat_thread` step at all. With no team-chat connector, that
// step is the only way its digest reaches a person. Nothing reports the loss;
// the graph can even keep the same step count, with the delivery step swapped
// out.

import { templateIdForRedistill, templateIdForObligations, templateSourceHash } from '../template-provenance';

const hired = {
  templateId: 'competitive-intelligence-analyst',
  responsibilities: 'Track competitors.',
  additionalContext: 'Cite every claim.',
};
const asHired = { ...hired, templateSourceHash: templateSourceHash(hired.responsibilities, hired.additionalContext) };
const afterAnEdit = { ...asHired, responsibilities: 'Track competitors, and lead with pricing moves.' };

describe('what survives an owner editing their team instructions', () => {
  it('stops seeding the prose, which is the point of the provenance rule', () => {
    expect(templateIdForRedistill(asHired)).toBe('competitive-intelligence-analyst');
    expect(templateIdForRedistill(afterAnEdit)).toBeNull();
  });

  it('keeps the declared obligations, which are about the output and not the words', () => {
    // The regression this exists to prevent. An owner asking for different
    // wording is not asking for the work to stop being delivered.
    expect(templateIdForObligations(afterAnEdit)).toBe('competitive-intelligence-analyst');
  });

  it('keeps them for an agent that was never edited either', () => {
    expect(templateIdForObligations(asHired)).toBe('competitive-intelligence-analyst');
  });

  it('has nothing to bind for a bespoke agent, which is honest', () => {
    // An agent built from free text has no template and no declarations. Null
    // here means "there is no obligation to read", not "the obligation lapsed".
    expect(templateIdForObligations({ templateId: null })).toBeNull();
    expect(templateIdForObligations({})).toBeNull();
  });

  it('does not depend on the hash column existing', () => {
    // An agent created before migration 378 has no recorded hash. It is
    // bespoke for SEEDING, and its declarations still bind.
    const preMigration = { templateId: 'competitive-intelligence-analyst' };
    expect(templateIdForRedistill(preMigration)).toBeNull();
    expect(templateIdForObligations(preMigration)).toBe('competitive-intelligence-analyst');
  });
});
