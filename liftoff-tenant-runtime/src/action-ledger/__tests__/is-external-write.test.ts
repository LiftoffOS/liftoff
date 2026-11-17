// `is_external_write` was a column nothing wrote.
//
// Migration 033 added it with DEFAULT false for a caller that no longer exists,
// so every row read false — including rows for an agent that had created and
// updated Google Docs in that run. Two features read the column and both were
// inert as a result: `acts-this-run` and `prior-work`.
//
// The value is derived inside recordIntent now, from the classifier the
// governance gate already uses, so the ledger's idea of a write cannot drift
// from the gate's. These pin the answers that made it inert.

import { STANDARD_TOOL_EFFECTS, classifyVendorToolEffect } from '../../tool-gateway/tool-effect';

/** Mirrors `isOutwardWrite` in service.ts. Kept here rather than exported so
 *  the test asserts the ANSWERS rather than re-running the implementation:
 *  a test that imported the function would pass for a function that returned
 *  the same wrong thing. */
const effectOf = (actionType: string): 'read' | 'write' | 'spawn' =>
  STANDARD_TOOL_EFFECTS[actionType] ?? classifyVendorToolEffect(actionType);

describe('what the ledger counts as an outward write', () => {
  it('counts the Google Docs calls that produced the missing battle card', () => {
    // These three are the agent's whole write surface, and all 32 of its ledger
    // rows were flagged false.
    expect(effectOf('google-docs-8fd9fc68__create_document_markdown')).toBe('write');
    expect(effectOf('google-docs-8fd9fc68__update_document_markdown')).toBe('write');
    expect(effectOf('open_chat_thread')).toBe('write');
  });

  it('does not count the search that went looking for them', () => {
    // The distinction that makes the block a list of artifacts rather than a
    // log: six searches produced nothing and belong nowhere near it.
    expect(effectOf('google-docs-8fd9fc68__search_documents')).toBe('read');
    expect(effectOf('google-docs-8fd9fc68__get_document')).toBe('read');
  });

  it('does not count the tools whose whole purpose is to be consulted first', () => {
    // have_i_acted_on reading as a write would put it in the list of things the
    // agent produced, and gate the check that exists to avoid a duplicate.
    expect(effectOf('have_i_acted_on')).toBe('read');
    expect(effectOf('memory_retrieve')).toBe('read');
    expect(effectOf('web_research')).toBe('read');
  });

  it('counts a vendor write whose name we have never seen', () => {
    // Rule 3 sends an unrecognised verb to 'write'. Over-inclusion here shows a
    // row in a list; under-inclusion hides an artifact and produces the false
    // absence the block exists to prevent.
    expect(classifyVendorToolEffect('notion__frobnicate_page')).toBe('write');
  });
});
