// Getting a file out of the browser, on whichever browser it is.
//
// Downloads were one vendor's feature: the two tools called the only vendor
// with a download API and refused on the other three, while the pane runs a
// different one by default. And a file the page merely POINTS at, which is
// what a page that generates a video produces, had no route into the
// conversation at all, so a person who watched a page render a video could be
// handed a screenshot of the page.
//
// So: the record is the browser's own announcement, which every vendor makes,
// and the bytes are fetched BY the session, where its sign-in applies. Which
// half of the session does the fetching turns out to matter, and has its own
// describe at the bottom of this file.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: (_tenantId: string, fn: (c: unknown) => unknown) => fn({ query: mockQuery }),
}));

const mockWithPage = jest.fn();
jest.mock('../cdp-page', () => ({ withPage: (...a: unknown[]) => mockWithPage(...a) }));

const mockListSessionDownloads = jest.fn();
const mockFetchDownloadBytes = jest.fn();
jest.mock('../../integrations/web-fetch/anchor-client', () => ({
  AnchorClient: class {
    listSessionDownloads = (...a: unknown[]) => mockListSessionDownloads(...a);
    fetchDownloadBytes = (...a: unknown[]) => mockFetchDownloadBytes(...a);
  },
}));

import {
  fetchFileForSession,
  isShownInConversation,
  keepDownloadBytes,
  listDownloadsForSession,
  recordDownload,
  _clearKeptDownloads,
  MAX_FILE_BYTES,
} from '../downloads';

const TENANT = 't-1';
const steel = { id: 's-1', vendor: 'steel', vendorSessionId: 'vs-steel' };
const anchor = { id: 's-2', vendor: 'anchor', vendorSessionId: 'vs-anchor' };

/** What the browser's own fetch did, per test. */
let browserLoad: { body?: Buffer; headers?: Record<string, string>; status?: number; unavailable?: boolean } = { unavailable: true };
/** Whether the in-page fetch was reached, and with what. */
const inPageFetches: string[] = [];

/** A session whose browser answers `Network.loadNetworkResource` and whose
 *  page answers a `fetch`. Both closures run for real, against stubs, so the
 *  stream read and the chunked base64 are exercised rather than assumed. */
function pageServing(body: Buffer, headers: Record<string, string>, status = 200) {
  const page = {
    context: () => ({
      newCDPSession: async () => {
        if (browserLoad.unavailable) throw new Error('no cdp session here');
        const load = browserLoad;
        let read = false;
        return {
          send: async (method: string, params?: Record<string, unknown>) => {
            if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-1' } } };
            if (method === 'Network.loadNetworkResource') {
              const ok = (load.status ?? 200) >= 200 && (load.status ?? 200) < 300;
              return ok
                ? { resource: { success: true, stream: 'stream-1', headers: load.headers ?? {}, httpStatusCode: load.status ?? 200 } }
                : { resource: { success: false, httpStatusCode: load.status, netErrorName: 'net::ERR_FAILED' } };
            }
            if (method === 'IO.read') {
              if (read) return { data: '', eof: true };
              read = true;
              return { data: (load.body ?? Buffer.alloc(0)).toString('base64'), base64Encoded: true, eof: false };
            }
            if (method === 'IO.close') return {};
            throw new Error(`unexpected ${method} ${JSON.stringify(params)}`);
          },
          detach: async () => undefined,
        };
      },
    }),
    evaluate: async (fn: (args: { target: string }) => unknown, args: { target: string }) => {
      inPageFetches.push(args.target);
      const original = globalThis.fetch;
      globalThis.fetch = (async () => ({
        ok: status >= 200 && status < 300,
        status,
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      })) as unknown as typeof fetch;
      try {
        return await fn(args);
      } finally {
        globalThis.fetch = original;
      }
    },
  };
  mockWithPage.mockImplementation(async (_v: string, _s: string, _t: string, fn: (p: unknown) => unknown) => fn(page));
}

/** The browser answers this file itself; the page is never asked. */
function browserServing(body: Buffer, headers: Record<string, string> = {}, status = 200) {
  browserLoad = { body, headers, status };
  // The in-page stub is deliberately a DIFFERENT file, so a test that claims
  // the browser answered cannot be passing on the page's bytes.
  pageServing(Buffer.from('from the page'), { 'content-type': 'text/plain' });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [] });
  // Most tests exercise the page's own fetch; the browser's route has its own
  // describe below.
  browserLoad = { unavailable: true };
  inPageFetches.length = 0;
  _clearKeptDownloads();
});

describe('what the session downloaded', () => {
  it('answers on a browser that is not the one with a download API, which is the whole point', async () => {
    mockQuery.mockResolvedValue({
      rows: [{
        id: 'd-1', url: 'https://cdn.example/clip.mp4', suggested_file_name: 'clip.mp4',
        origin_url: 'https://maker.example/studio', created_at: new Date('2026-09-25T10:00:00Z'),
      }],
    });
    const out = await listDownloadsForSession(TENANT, steel);
    expect(out).toEqual([{
      id: 'd-1',
      url: 'https://cdn.example/clip.mp4',
      suggestedFileName: 'clip.mp4',
      originUrl: 'https://maker.example/studio',
      downloadedAt: '2026-09-25T10:00:00.000Z',
    }]);
    // Nothing was asked of any vendor.
    expect(mockListSessionDownloads).not.toHaveBeenCalled();
  });

  it('names a file after its address when the browser named none', async () => {
    mockQuery.mockResolvedValue({
      rows: [{
        id: 'd-1', url: 'https://cdn.example/files/report%20final.pdf', suggested_file_name: '',
        origin_url: '', created_at: new Date('2026-09-25T10:00:00Z'),
      }],
    });
    const [only] = await listDownloadsForSession(TENANT, steel);
    expect(only.suggestedFileName).toBe('report final.pdf');
  });

  it('merges the one vendor that keeps a store of its own, by address, oldest first', async () => {
    mockQuery.mockResolvedValue({
      rows: [{
        id: 'd-1', url: 'https://x.example/a.pdf', suggested_file_name: 'a.pdf',
        origin_url: '', created_at: new Date('2026-09-25T10:00:00Z'),
      }],
    });
    mockListSessionDownloads.mockResolvedValue([
      // The same file the session was heard to download: not repeated.
      { id: 'v-1', fileLink: 'https://vendor/f/1', originalDownloadUrl: 'https://x.example/a.pdf', originUrl: '', suggestedFileName: 'a.pdf', originalFileName: null, createdAt: '2026-09-25T10:00:00.000Z' },
      // One only the vendor knows, from before the connection was listening.
      { id: 'v-2', fileLink: 'https://vendor/f/2', originalDownloadUrl: 'https://x.example/b.pdf', originUrl: 'https://x.example/', suggestedFileName: 'b.pdf', originalFileName: null, createdAt: '2026-09-25T09:00:00.000Z' },
    ]);
    const out = await listDownloadsForSession(TENANT, anchor);
    expect(out.map((d) => d.url)).toEqual(['https://x.example/b.pdf', 'https://x.example/a.pdf']);
  });

  it('reports what it heard directly when the vendor store cannot be read', async () => {
    mockQuery.mockResolvedValue({
      rows: [{
        id: 'd-1', url: 'https://x.example/a.pdf', suggested_file_name: 'a.pdf',
        origin_url: '', created_at: new Date('2026-09-25T10:00:00Z'),
      }],
    });
    mockListSessionDownloads.mockRejectedValue(new Error('vendor down'));
    const out = await listDownloadsForSession(TENANT, anchor);
    expect(out).toHaveLength(1);
  });
});

describe('recording what the browser announced', () => {
  it('writes the sanitized address once per session, address and name', async () => {
    await recordDownload({
      tenantId: TENANT, sessionId: 's-1', url: 'https://cdn.example/clip.mp4',
      suggestedFileName: 'clip.mp4', originUrl: 'https://maker.example/',
    });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (session_id, url, suggested_file_name) DO NOTHING');
    expect(params[2]).toBe('https://cdn.example/clip.mp4');
  });
});

describe('bringing one file back', () => {
  it('fetches an address the page points at, from inside the page, with its type and name', async () => {
    pageServing(Buffer.from('a video'), {
      'content-type': 'video/mp4; charset=binary',
      'content-disposition': 'attachment; filename="clip.mp4"',
    });
    const file = await fetchFileForSession(TENANT, steel, { url: 'https://cdn.example/x?token=1' });
    expect(file.bytes.toString()).toBe('a video');
    expect(file.contentType).toBe('video/mp4');
    expect(file.filename).toBe('clip.mp4');
    expect(file.sourceUrl).toBe('https://cdn.example/x?token=1');
    // From inside the session's own page, so its sign-in applies.
    expect(mockWithPage).toHaveBeenCalledWith('steel', 'vs-steel', TENANT, expect.any(Function), 'fetchFileFromSession');
  });

  it('carries bytes that are not text through unchanged', async () => {
    const bytes = Buffer.from(Array.from({ length: 70_000 }, (_, i) => i % 256));
    pageServing(bytes, { 'content-type': 'image/png' });
    const file = await fetchFileForSession(TENANT, steel, { url: 'https://cdn.example/p.png' });
    expect(file.bytes.equals(bytes)).toBe(true);
    expect(file.contentType).toBe('image/png');
  });

  it('takes the name from the address when the server gives none', async () => {
    pageServing(Buffer.from('x'), { 'content-type': 'application/pdf' });
    const file = await fetchFileForSession(TENANT, steel, { url: 'https://x.example/docs/invoice.pdf' });
    expect(file.filename).toBe('invoice.pdf');
  });

  it('infers the type from the name when the server gives none either', async () => {
    pageServing(Buffer.from('x'), {});
    const file = await fetchFileForSession(TENANT, steel, { url: 'https://x.example/docs/invoice.pdf' });
    expect(file.contentType).toBe('application/pdf');
  });

  it('refuses an address that is not a web address, with a reason', async () => {
    await expect(fetchFileForSession(TENANT, steel, { url: 'view-source:https://x.example/' }))
      .rejects.toThrow(/only http, https and blob/);
    expect(mockWithPage).not.toHaveBeenCalled();
  });

  it('refuses a file the page could not fetch, saying so rather than returning nothing', async () => {
    pageServing(Buffer.from(''), {}, 404);
    await expect(fetchFileForSession(TENANT, steel, { url: 'https://x.example/gone' }))
      .rejects.toThrow(/status 404/);
  });

  it('refuses a file past the cap, in megabytes a person could be told', async () => {
    pageServing(Buffer.alloc(MAX_FILE_BYTES + 1), { 'content-type': 'video/mp4' });
    await expect(fetchFileForSession(TENANT, steel, { url: 'https://x.example/huge.mp4' }))
      .rejects.toThrow(/over the 40 MB/);
  });

  it('refuses an id nothing downloaded, and says where the ids come from', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(fetchFileForSession(TENANT, steel, { downloadId: 'nope' }))
      .rejects.toThrow(/List the downloads/);
  });

  it('refuses a call that names neither an id nor an address', async () => {
    await expect(fetchFileForSession(TENANT, steel, {})).rejects.toThrow(/a download id, or the address/);
  });

  it('replays a recorded download from inside the page, keeping the page it came from', async () => {
    mockQuery.mockResolvedValue({
      rows: [{
        id: 'd-1', url: 'https://cdn.example/clip.mp4', suggested_file_name: 'clip.mp4',
        origin_url: 'https://maker.example/studio', created_at: new Date(),
      }],
    });
    pageServing(Buffer.from('bytes'), { 'content-type': 'video/mp4' });
    const file = await fetchFileForSession(TENANT, steel, { downloadId: 'd-1' });
    expect(file.filename).toBe('clip.mp4');
    expect(file.sourceUrl).toBe('https://maker.example/studio');
  });

  it('takes an id from the one vendor that keeps its own store, which nothing else can see', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    mockListSessionDownloads.mockResolvedValue([
      { id: 'v-1', fileLink: 'https://vendor/f/1', originalDownloadUrl: null, originUrl: 'https://x.example/', suggestedFileName: 'export.csv', originalFileName: null, createdAt: '' },
    ]);
    mockFetchDownloadBytes.mockResolvedValue(Buffer.from('a,b'));
    const file = await fetchFileForSession(TENANT, anchor, { downloadId: 'v-1' });
    expect(file.bytes.toString()).toBe('a,b');
    expect(file.contentType).toBe('text/csv');
    expect(mockWithPage).not.toHaveBeenCalled();
  });
});

describe('what the person sees', () => {
  it('shows a picture, a clip and a recording in the conversation itself', () => {
    for (const type of ['image/png', 'image/jpeg', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg']) {
      expect(isShownInConversation(type)).toBe(true);
    }
  });

  it('offers anything else as a file to open, which always works', () => {
    for (const type of ['application/pdf', 'text/csv', 'application/zip', 'image/svg+xml']) {
      expect(isShownInConversation(type)).toBe(false);
    }
  });
});


// The browser fetches it, not the page
//
// A page that generated something almost never serves it from its own origin:
// the video is on a CDN subdomain, and a fetch from inside the page is a
// cross-origin request the CDN never consented to, so the browser refuses it
// before it leaves. An in-page fetch works only once the page navigates to
// the file so the page and the file share an origin.
//
// `Network.loadNetworkResource` is the browser fetching, the way it fetches a
// sourcemap: the session's cookies go with it and no document is making the
// request, so there is no origin to be across.
describe('the browser\'s own fetch', () => {
  it('is what a cross-origin file comes back through, and the page is never asked', async () => {
    browserServing(Buffer.from('the real video'), {
      'Content-Type': 'video/mp4',
      'Content-Disposition': 'attachment; filename="clip.mp4"',
    });
    const file = await fetchFileForSession(TENANT, steel, { url: 'https://cdn.other-origin.example/clip.mp4' });
    expect(file.bytes.toString()).toBe('the real video');
    expect(file.contentType).toBe('video/mp4');
    expect(file.filename).toBe('clip.mp4');
    expect(inPageFetches).toEqual([]);
  });

  it('reads a header whatever case the server sent it in', async () => {
    browserServing(Buffer.from('x'), { 'CONTENT-TYPE': 'image/png' });
    const file = await fetchFileForSession(TENANT, steel, { url: 'https://cdn.example/p.png' });
    expect(file.contentType).toBe('image/png');
  });

  it('stops at the cap while reading, rather than after', async () => {
    browserServing(Buffer.alloc(MAX_FILE_BYTES + 1), { 'content-type': 'video/mp4' });
    await expect(fetchFileForSession(TENANT, steel, { url: 'https://cdn.example/huge.mp4' }))
      .rejects.toThrow(/over the 40 MB/);
  });

  it('lets the page try when the browser refused, and keeps the browser\'s reason when the page fails too', async () => {
    browserLoad = { status: 403 };
    pageServing(Buffer.from(''), {}, 403);
    await expect(fetchFileForSession(TENANT, steel, { url: 'https://cdn.example/secret.mp4' }))
      .rejects.toThrow(/the browser could not fetch it \(status 403\)/);
    expect(inPageFetches).toEqual(['https://cdn.example/secret.mp4']);
  });

  it('falls back to the page when this browser has no such command', async () => {
    browserLoad = { unavailable: true };
    pageServing(Buffer.from('from the page'), { 'content-type': 'text/plain' });
    const file = await fetchFileForSession(TENANT, steel, { url: 'https://x.example/a.txt' });
    expect(file.bytes.toString()).toBe('from the page');
  });

  // A generator that renders in the browser never puts the file on a server:
  // the address on the <video> is the only one there is, and only the page
  // that made it can resolve it. The browser's own fetch is never asked.
  it('goes straight to the page for a blob the browser made', async () => {
    browserServing(Buffer.from('never asked'), { 'content-type': 'video/mp4' });
    const file = await fetchFileForSession(TENANT, steel, { url: 'blob:https://maker.example/abc-123' });
    expect(file.bytes.toString()).toBe('from the page');
    expect(inPageFetches).toContain('blob:https://maker.example/abc-123');
  });
});

// A file that exists for one moment
//
// A page that builds a file in the browser hands it over as a `blob:`
// address and revokes that address as soon as the click is done, so the
// address outlives the file. Such a download is listed correctly and then
// fails to fetch: by the time anybody asks, there is nothing behind it. The bytes are taken at the announcement or not at all.
describe('a download the page built in the browser', () => {
  const blobUrl = 'blob:https://maker.example/076251cd-7efa-4999-86f7-6aee011ec9c4';

  /** The recorded download that the announcement wrote. */
  function recordedBlob() {
    mockQuery.mockResolvedValue({
      rows: [{
        id: 'd-1', url: blobUrl, suggested_file_name: 'qr-code.jpg',
        origin_url: 'https://maker.example/', created_at: new Date(),
      }],
    });
  }

  it('is served from what was taken at the announcement, without going near the page again', async () => {
    pageServing(Buffer.from('the qr code'), { 'content-type': 'image/jpeg' });
    await keepDownloadBytes('steel', 'vs-steel', TENANT, blobUrl);
    // The handle the session holds on the file is asked for first, and the
    // address is only chased when the page was never armed.
    expect(inPageFetches).toContain(blobUrl);

    recordedBlob();
    inPageFetches.length = 0;
    const file = await fetchFileForSession(TENANT, steel, { downloadId: 'd-1' });
    expect(file.bytes.toString()).toBe('the qr code');
    expect(file.contentType).toBe('image/jpeg');
    expect(file.filename).toBe('qr-code.jpg');
    // The address is long gone by now; nothing tried it.
    expect(inPageFetches).toEqual([]);
  });

  it('is not taken for an address that can simply be fetched again', async () => {
    pageServing(Buffer.from('x'), { 'content-type': 'image/png' });
    await keepDownloadBytes('steel', 'vs-steel', TENANT, 'https://cdn.example/p.png');
    expect(inPageFetches).toEqual([]);
  });

  it('tells the model what will work when the page let go before we got there', async () => {
    recordedBlob();
    pageServing(Buffer.from(''), {}, 404);
    await expect(fetchFileForSession(TENANT, steel, { downloadId: 'd-1' }))
      .rejects.toThrow(/Download it again on the page and ask for it straight away/);
  });

  // The taking is best effort by nature: it races the page's own revoke.
  // Losing that race must cost the session nothing.
  it('costs nothing when the page has already let go', async () => {
    pageServing(Buffer.from(''), {}, 404);
    await expect(keepDownloadBytes('steel', 'vs-steel', TENANT, blobUrl)).resolves.toBeUndefined();
    recordedBlob();
    await expect(fetchFileForSession(TENANT, steel, { downloadId: 'd-1' })).rejects.toThrow(/Download it again/);
  });

  it('keeps nothing that is too large to deliver', async () => {
    pageServing(Buffer.alloc(MAX_FILE_BYTES + 1), { 'content-type': 'video/mp4' });
    await keepDownloadBytes('steel', 'vs-steel', TENANT, blobUrl);
    recordedBlob();
    pageServing(Buffer.from(''), {}, 404);
    await expect(fetchFileForSession(TENANT, steel, { downloadId: 'd-1' })).rejects.toThrow(/Download it again/);
  });
});
