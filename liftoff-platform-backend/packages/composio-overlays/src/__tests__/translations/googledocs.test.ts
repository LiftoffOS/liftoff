// The two Google Docs create tools, against what Composio actually answers.
//
// Where the id sits depends on the toolkit version the call names. The
// runtime dispatches at `latest`, which answers the Docs
// API's own object: `documentId` at the top level, no `document_id`, no
// `response_data`. The unversioned default, and the registry schema shown
// when no version is named, declares `document_id` nullable beside a
// `response_data` object carrying the same `documentId`. A canonical shape
// that required a string `document_id` threw canonical_shape_violation on a
// create that had succeeded, so an agent would report the write as failed
// and escalate. These cases hold the overlay to all three
// places the id can be, and hold the shape to refusing a response that
// carries none.
import { GOOGLEDOCS_OVERLAYS } from '../../overlays/googledocs';
import { CANONICAL_RESPONSE_SHAPES } from '../../canonical-shapes';

const CREATES: Array<[string, 'googledocs.create_document' | 'googledocs.create_document_markdown']> = [
  ['GOOGLEDOCS_CREATE_DOCUMENT', 'googledocs.create_document'],
  ['GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN', 'googledocs.create_document_markdown'],
];

describe.each(CREATES)('googledocs %s', (slug, canonicalKey) => {
  const overlay = GOOGLEDOCS_OVERLAYS[slug];
  const shape = CANONICAL_RESPONSE_SHAPES[canonicalKey];

  it('reads the id from a top-level documentId, the shape toolkit version latest answers', () => {
    // Through the SDK at `latest`, Composio answers with the Docs API
    // object as the data itself, and nothing named document_id anywhere.
    const out = overlay.translateOutput!({
      documentId: 'doc-latest', title: 'T', revisionId: 'r1', display_url: 'https://docs.google.com/document/d/EXAMPLE_DOC_ID',
    });
    expect(shape.safeParse(out).success).toBe(true);
    expect((out as { document_id: string }).document_id).toBe('doc-latest');
    expect((out as { documentId: string }).documentId).toBe('doc-latest');
    expect((out as { display_url: string }).display_url).toBe('https://docs.google.com/document/d/EXAMPLE_DOC_ID');
  });

  it('keeps a top-level document_id and passes the rest through', () => {
    const out = overlay.translateOutput!({ document_id: 'doc-1', response_data: { documentId: 'doc-1', title: 'T' } });
    const parsed = shape.safeParse(out);
    expect(parsed.success).toBe(true);
    expect((out as { document_id: string }).document_id).toBe('doc-1');
    expect((out as { response_data: unknown }).response_data).toEqual({ documentId: 'doc-1', title: 'T' });
  });

  it('reads the id from response_data.documentId when document_id is null', () => {
    // The unversioned default's answer: the vendor schema allows the null,
    // and the document had been created.
    const out = overlay.translateOutput!({ document_id: null, response_data: { documentId: 'doc-2', title: 'T' } });
    expect(shape.safeParse(out).success).toBe(true);
    expect((out as { document_id: string }).document_id).toBe('doc-2');
  });

  it('reads the id from response_data.documentId when document_id is absent', () => {
    const out = overlay.translateOutput!({ response_data: { documentId: 'doc-3' } });
    expect(shape.safeParse(out).success).toBe(true);
    expect((out as { document_id: string }).document_id).toBe('doc-3');
  });

  it('prefers document_id over documentId when a response carries both', () => {
    const out = overlay.translateOutput!({ document_id: 'doc-snake', documentId: 'doc-camel' });
    expect((out as { document_id: string }).document_id).toBe('doc-snake');
  });

  it('is still a shape violation when no place carries an id', () => {
    // A create that answers with no id at all is the failure the shape exists
    // to catch; normalisation must not invent one.
    const out = overlay.translateOutput!({ document_id: null, documentId: '', response_data: null });
    expect(shape.safeParse(out).success).toBe(false);
    expect((out as { document_id?: unknown }).document_id).toBeNull();
  });

  it('declares its provenance path against the normalised shape', () => {
    expect(overlay.returnsIds).toEqual([{ entityType: 'document', path: 'document_id' }]);
  });
});

describe('googledocs GOOGLEDOCS_GET_DOCUMENT_BY_ID', () => {
  it('declares the id path for both toolkit versions', () => {
    // The default wraps the Docs API answer in response_data; latest returns
    // it as the data itself. A read at either version must record the id.
    expect(GOOGLEDOCS_OVERLAYS.GOOGLEDOCS_GET_DOCUMENT_BY_ID.returnsIds).toEqual([
      { entityType: 'document', path: 'response_data.documentId' },
      { entityType: 'document', path: 'documentId' },
    ]);
  });
});
