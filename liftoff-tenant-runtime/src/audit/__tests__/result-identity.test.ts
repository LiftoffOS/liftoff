// An audit summary keeps what the result is ABOUT.
//
// The cap was spent on whatever the provider serialised first. Both of these
// are 500-character rows of that shape:
//
//   get_document     {"body":{"content":[{"endIndex":1,"sectionBreak":…
//   update_document  {"display_url":"…","replies":[{},{},{},{},{},{}…
//
// One spent its budget on document body structure, the other on hundreds of
// empty `replies` objects. Both responses CONTAIN the document's title, and
// neither kept it — so the platform records documents it cannot name and
// shows a person "Updated document" over and over for files whose names it
// has every right to know.

import { summariseToolResult, collectIdentity } from '../result-identity';

describe('what survives the cap', () => {
  it('keeps the title ahead of a huge body', () => {
    const docsResponse = {
      body: { content: Array.from({ length: 400 }, (_, i) => ({ endIndex: i, paragraph: { x: 'y' } })) },
      title: 'Acme — Competitor Snapshot (current)',
      documentId: '1W9WHtag7VnedY',
    };
    const summary = summariseToolResult(docsResponse)!;

    expect(summary).toContain('Acme — Competitor Snapshot (current)');
    expect(summary).toContain('1W9WHtag7VnedY');
    expect(summary.length).toBeLessThanOrEqual(500);
  });

  it('keeps the link ahead of hundreds of empty replies', () => {
    const updateResponse = {
      display_url: 'https://docs.google.com/document/d/1QFf/edit',
      documentId: '1QFf',
      replies: Array.from({ length: 300 }, () => ({})),
    };
    const summary = summariseToolResult(updateResponse)!;

    expect(summary).toContain('https://docs.google.com/document/d/1QFf/edit');
    expect(summary.length).toBeLessThanOrEqual(500);
  });

  it('finds an identity the provider nested', () => {
    // A Docs response carries the title beside `body`; a Drive one puts it
    // inside `file`. Neither is worth a special case.
    const nested = { ok: true, file: { name: 'Battle Card: RivalCo', webViewLink: 'https://x/1' } };
    expect(summariseToolResult(nested)).toContain('Battle Card: RivalCo');
  });

  it('still records a result with nothing identifying in it', () => {
    // Degrades to exactly the blind prefix it replaces, so nothing that worked
    // before gets worse.
    expect(summariseToolResult({ rows: 4, ok: true })).toBe('{"rows":4,"ok":true}');
  });

  it('passes a string through, bounded', () => {
    expect(summariseToolResult('x'.repeat(900))!.length).toBe(500);
  });

  it('says nothing when the tool returns nothing', () => {
    // Distinct from "nobody wrote it down".
    expect(summariseToolResult(undefined)).toBeUndefined();
  });

  it('records that something came back even when it cannot be serialised', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(summariseToolResult(circular)).toBe('[unserialisable result]');
  });

  it('keeps the identity even when the identity alone fills the cap', () => {
    const summary = summariseToolResult({ title: 'T'.repeat(600), id: 'x' })!;
    expect(summary.length).toBeLessThanOrEqual(500);
    expect(summary.startsWith('{"title":"TTT')).toBe(true);
  });
});

// `collectIdentity` is exported because prior-work.ts reads the same fields out
// of `actions.external_response` to name an artifact in the prompt. One
// definition of "what identifies a result", used by the audit summary and by
// the record put in front of the model, so the two cannot drift.
describe('collectIdentity, as prior-work uses it', () => {
  it('pulls a title and a link out of a Google Docs create response', () => {
    const response = {
      documentId: '1jeDMbf7DjY-eIkoSIoNG-yZ0Ehz_sjdJD54V8mvLruc',
      title: 'Battle Card: EstateAgent4Me',
      display_url: 'https://docs.google.com/document/d/EXAMPLE_DOC_ID/edit',
      body: { content: [{ endIndex: 1 }, { endIndex: 2 }] },
    };
    const identity = collectIdentity(response);
    expect(identity.title).toBe('Battle Card: EstateAgent4Me');
    expect(identity.display_url).toBe('https://docs.google.com/document/d/EXAMPLE_DOC_ID/edit');
  });

  it('finds an identity the provider nested one level down', () => {
    // A Drive response carries it inside `file`; a Docs one carries it beside
    // `body`. Neither is worth a special case.
    const identity = collectIdentity({ file: { name: 'Weekly Digest', webViewLink: 'https://x/y' } });
    expect(identity.name).toBe('Weekly Digest');
    expect(identity.webViewLink).toBe('https://x/y');
  });

  it('returns nothing for a response that names nothing, rather than inventing', () => {
    expect(collectIdentity({ ok: true, replies: [{}, {}] })).toEqual({});
  });
});
