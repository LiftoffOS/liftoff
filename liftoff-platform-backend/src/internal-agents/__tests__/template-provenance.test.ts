// Whether a redistill may seed from the template the agent was hired from.
//
// What these pin: the id is used only while the agent still says what the
// template said. Re-seeding carries our wording, our column contract and our
// declared inputs back into the agent, which is right for an untouched hire and
// wrong for one its owner has edited — that edit is theirs, and an optimisation
// they asked for must not quietly undo it.

import { templateSourceHash, templateIdForRedistill } from '../template-provenance';

const RESP = '## Workflows\n1. Sweep each competitor weekly';
const CTX = '## Rules\n- Every claim carries a source link';

const hired = (over: Record<string, unknown> = {}) => ({
  templateId: 'competitive-intelligence-analyst',
  templateSourceHash: templateSourceHash(RESP, CTX),
  responsibilities: RESP,
  additionalContext: CTX,
  ...over,
});

describe('templateIdForRedistill', () => {
  it('seeds from the template when the text is untouched', () => {
    expect(templateIdForRedistill(hired())).toBe('competitive-intelligence-analyst');
  });

  it('withholds it once the responsibilities are edited', () => {
    expect(templateIdForRedistill(hired({ responsibilities: RESP + '\n2. Also watch pricing' }))).toBeNull();
  });

  it('withholds it once the additional context is edited', () => {
    expect(templateIdForRedistill(hired({ additionalContext: CTX + '\n- Never guess' }))).toBeNull();
  });

  it('withholds it when either field is cleared', () => {
    expect(templateIdForRedistill(hired({ responsibilities: null }))).toBeNull();
    expect(templateIdForRedistill(hired({ additionalContext: null }))).toBeNull();
  });

  it('treats an agent built by hand as bespoke', () => {
    expect(templateIdForRedistill({ responsibilities: RESP, additionalContext: CTX })).toBeNull();
  });

  it('treats an agent created before the column existed as bespoke', () => {
    // template_id and template_source_hash are both null on every existing row,
    // so those agents redistill exactly as they always have.
    expect(templateIdForRedistill(hired({ templateSourceHash: null }))).toBeNull();
    expect(templateIdForRedistill(hired({ templateId: null }))).toBeNull();
  });

  it('does not confuse a field boundary', () => {
    // Moving text from one field to the other changes the agent, and a hash
    // that concatenated them without a separator would call it unchanged.
    const moved = templateSourceHash(RESP + CTX, '');
    expect(moved).not.toBe(templateSourceHash(RESP, CTX));
  });
});
