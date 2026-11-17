// readDocument must ask connector-service for text; the write-side document
// tools must not.
//
// Composio-managed connectors (Drive, Gmail, Calendar and the rest of the
// Composio-brokered set) have no access token to lend — Composio signs
// requests server-side and returns a decoded body. Binary cannot cross that
// hop, so connector-service serves those files as text or refuses. A reader
// that does not ask for text gets nothing back at all: browse lists the file,
// readDocument cannot open it.
//
// The same parameter is what turns a Google Sheet into CSV instead of an
// .xlsx that falls through to `buffer.toString('utf-8')` on a zip.
//
// editDocument and editPresentation rewrite real .docx/.pptx bytes, and
// readPresentation parses a real .pptx, so all three must keep asking for
// binary. This pins both halves.

jest.mock('@liftoffos/service-client', () => ({
  buildOidcAuthHeader: jest.fn(async () => ({})),
}));
// The native edit registers its copy with the platform, which crosses the
// agent id boundary (ADR-039) before it sends anything. Not this test's
// subject — document-tool-registration.test.ts owns it — so the boundary
// answers with a fixed id here.
jest.mock('../../agent-lifecycle/resolve-runtime-agent-id', () => ({
  resolveInternalAgentId: jest.fn(async () => '11111111-1111-1111-1111-111111111111'),
}));

import { readDocument, readPresentation, editDocument } from '../document-tool-handlers';

const manifest = {
  id: 'conn-1',
  connectorType: 'google_drive',
} as unknown as Parameters<typeof readDocument>[1];

const ctx = { tenantId: 'tenant-1' } as unknown as Parameters<typeof readDocument>[2];

const ORIG_ENV = { ...process.env };
let fetchMock: jest.Mock;

function textResponse(body: string, contentType = 'text/plain') {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (k: string) =>
        k.toLowerCase() === 'content-type'
          ? contentType
          : k.toLowerCase() === 'content-disposition'
            ? 'attachment; filename="Report.txt"'
            : null,
    },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  } as unknown as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env = {
    ...ORIG_ENV,
    CONNECTOR_SERVICE_URL: 'http://connector.local',
    CONNECTOR_SERVICE_TOKEN: 'tok',
  };
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  process.env = ORIG_ENV;
});

describe('readDocument', () => {
  it('asks for the file as text, which is the only shape a Composio connector can serve', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('the document body'));

    // Unique fileId per test — the handler memoises by connector+file.
    const result = await readDocument({ fileId: 'file-text-1' }, manifest, ctx);

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/files/file-text-1/content');
    expect(url).toContain('exportAs=text');
    expect(result).toMatchObject({ textContent: 'the document body' });
  });

  it('reads a spreadsheet served as CSV', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('stage,count\nqualified,12\n', 'text/csv'));

    const result = await readDocument({ fileId: 'file-csv-1' }, manifest, ctx);

    expect(result).toMatchObject({ textContent: expect.stringContaining('stage,count') });
  });
});

describe('the write-side tools still want bytes', () => {
  it('editDocument does not ask for text — it rewrites real .docx', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      headers: { get: () => null },
    } as unknown as Response);

    await editDocument(
      { doc_id: 'file-2', edits: [] } as unknown as Parameters<typeof editDocument>[0],
      manifest,
      ctx,
    );

    expect(String(fetchMock.mock.calls[0][0])).not.toContain('exportAs=text');
  });

  it('readPresentation does not ask for text — it parses a real .pptx', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      headers: { get: () => null },
    } as unknown as Response);

    await readPresentation(
      { fileId: 'file-3' } as unknown as Parameters<typeof readPresentation>[0],
      { ...manifest, connectorType: 'google_drive' } as unknown as Parameters<typeof readPresentation>[1],
      ctx,
    ).catch(() => undefined);

    expect(String(fetchMock.mock.calls[0][0])).not.toContain('exportAs=text');
  });
});

describe('readPresentation picks the reader by file type, not connector type', () => {
  const drive = { id: 'conn-1', connectorType: 'google_drive' } as unknown as Parameters<
    typeof readPresentation
  >[1]

  it('reads a Google-native deck through the Slides API even on a Drive connector', async () => {
    // Native decks hold no bytes to download, and on a Composio-managed
    // connector the binary path cannot work at all. Keying off connectorType
    // sent these to the .pptx reader, which then failed.
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          id: 'file-9',
          metadata: { mimeType: 'application/vnd.google-apps.presentation' },
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ fileId: 'file-9', name: 'Deck', slideCount: 2, slides: [] }),
      } as unknown as Response);

    const result = await readPresentation({ fileId: 'file-9' }, drive, ctx);

    expect(String(fetchMock.mock.calls[1][0])).toContain('/presentations/file-9');
    expect(result).toMatchObject({ slideCount: 2 })
  })

  it('still downloads a real .pptx uploaded to Drive', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          id: 'file-10',
          metadata: {
            mimeType:
              'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          },
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: { get: () => null },
      } as unknown as Response);

    await readPresentation({ fileId: 'file-10' }, drive, ctx).catch(() => undefined)

    expect(String(fetchMock.mock.calls[1][0])).toContain('/files/file-10/content')
  })

  it('falls through to the download path when the metadata lookup fails', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503, headers: { get: () => null } } as unknown as Response)
      .mockResolvedValueOnce({ ok: false, status: 500, headers: { get: () => null } } as unknown as Response)

    await readPresentation({ fileId: 'file-11' }, drive, ctx).catch(() => undefined)

    // A metadata call that did not answer is not a reason to refuse the read.
    expect(String(fetchMock.mock.calls[1][0])).toContain('/files/file-11/content')
  })
})

describe('editDocument on a connector that cannot hand over bytes', () => {
  const drive = { id: 'conn-1', connectorType: 'google_drive' } as unknown as Parameters<
    typeof editDocument
  >[1]

  const edits = [{ find: 'old', replace: 'new', context_before: '', context_after: '' }]

  it('edits a copy natively when the download is refused with 415', async () => {
    fetchMock
      // The .docx download: connector-service cannot serve bytes over Composio.
      .mockResolvedValueOnce({
        ok: false,
        status: 415,
        headers: { get: () => null },
      } as unknown as Response)
      // copy-and-edit accepted as a job.
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        headers: { get: () => null },
        json: async () => ({ jobId: 'job-1' }),
      } as unknown as Response)
      // Job poll.
      .mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          // The poller waits for 'complete' — 'succeeded' would spin until timeout.
          status: 'complete',
          result: {
            documentId: 'doc-copy-1',
            name: 'document_edited',
            webViewUrl: 'https://docs.google.com/document/d/EXAMPLE_DOC_ID/edit',
            replacements: [{ find: 'old', occurrencesChanged: 2 }],
            unmatched: [],
          },
        }),
      } as unknown as Response)

    await editDocument({ doc_id: 'doc-1', edits }, drive, ctx)

    const editCall = String(fetchMock.mock.calls[1][0])
    expect(editCall).toContain('/documents/doc-1/copy-and-edit')
    const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)
    expect(body.edits).toEqual([{ find: 'old', replace: 'new' }])
  })

  it('does not reach for the native path when bytes are available', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      headers: { get: () => null },
    } as unknown as Response)

    await editDocument({ doc_id: 'doc-2', edits }, drive, ctx)

    // One call only: a 500 is a failure to report, not a reason to switch
    // strategies and silently produce a different kind of artifact.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
