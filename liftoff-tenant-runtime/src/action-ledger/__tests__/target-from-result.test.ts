// The ledger could not record what an agent MADE.
//
// `deriveTarget` reads the payload, and a create's payload carries a title and
// a body and no id — the id exists only in the response. So every artifact an
// agent produced was recorded unkeyed, and every surface that reads the ledger
// by target skipped exactly the rows describing the agent's own output.
//
// An agent could then report that a battle card it had written itself did not
// exist.
//
// recordOutcome now runs the SAME derivation against the response. These pin
// that the response actually yields a target — the assumption the whole fix
// rests on, and the one a mocked test would have let through.

import { deriveTarget } from '../target-ref';

describe('deriving a target from what came back', () => {
  it('keys a created Google Doc off the id in its response', () => {
    // The shape Composio returns for GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN.
    const response = {
      documentId: '1jeDMbf7DjY-eIkoSIoNG-yZ0Ehz_sjdJD54V8mvLruc',
      title: 'Battle Card: EstateAgent4Me',
      display_url: 'https://docs.google.com/document/d/EXAMPLE_DOC_ID/edit',
    };
    const target = deriveTarget({
      connector: 'google-docs-8fd9fc68',
      actionType: 'create_document_markdown',
      payload: response,
    });
    expect(target.ref).toContain('1jeDMbf7DjY-eIkoSIoNG-yZ0Ehz_sjdJD54V8mvLruc');
    // The connector TYPE, not the instance id: the same prefix the payload path
    // produces, so a document created on one run and updated on the next
    // collapses to ONE artifact rather than appearing twice under two keys.
    expect(target.ref.startsWith('google-docs:')).toBe(true);
  });

  it('gives the same ref whether the id came from the payload or the response', () => {
    // The property that matters. An update names the document in its payload; a
    // create names it only in its response. If these disagreed, the same
    // document would occupy two rows and be listed twice.
    const id = '1aCLb-l2AXpQyLOzfFRkHTzk9tRxIXNmo9eGKmJzyP7I';
    const fromPayload = deriveTarget({
      connector: 'google-docs-8fd9fc68',
      actionType: 'update_document_markdown',
      payload: { documentId: id, new_markdown_text: '...' },
    });
    const fromResponse = deriveTarget({
      connector: 'google-docs-8fd9fc68',
      actionType: 'create_document_markdown',
      payload: { documentId: id, title: 'Acme competition test' },
    });
    expect(fromResponse.ref).toBe(fromPayload.ref);
  });

  it('yields nothing when the response names nothing, rather than inventing a key', () => {
    // An unkeyed row is today's behaviour and is honest. A fabricated key would
    // make two unrelated artifacts look like one.
    const target = deriveTarget({
      connector: 'google-docs-8fd9fc68',
      actionType: 'create_document_markdown',
      payload: { ok: true },
    });
    expect(target.ref).toBe('');
  });
});
