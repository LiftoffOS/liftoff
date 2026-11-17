// The files a browser session downloaded, and the bytes of a file it can see.
//
// Both halves of one act: getting something out of the browser and into the
// conversation. Anchor answered a listing endpoint and the two download tools
// called it, so on Steel, Browser Use and Browserbase they refused — and the
// pane runs Steel by default, so a request to bring a generated video into
// the chat got a screenshot of the page.
//
// So neither half asks a vendor anything.
//
//   RECORDING  Chromium announces a download on the session's own CDP
//              connection, with the address it is fetching and the name it
//              would save. `recordDownload` writes that (migration 436);
//              `armDownloadCapture` in cdp-page.ts is what hears it, on
//              whichever vendor's browser the connection reached.
//
//   FETCHING   The bytes are read by the SESSION, so its cookies and headers
//              apply: a file behind a sign-in comes back for the same reason
//              the person can see it. A fetch from this process would be a
//              different caller to that site, which is the whole difficulty
//              with "download this for me".
//
//              The browser does the fetching and the page is the fallback,
//              because a generated file is almost never on the page's own
//              origin and a fetch from inside the page is then a cross-origin
//              request the file's host never consented to. See
//              loadThroughBrowser.
//
// The same fetch serves an address a model read off the page, which is how a
// generated video with a plain CDN address reaches the chat without anybody
// clicking a download button.
//
// Nothing here stores bytes. A file becomes a generated file only when it is
// asked for, and the caller hands it to platform-backend's store.

import type { Page } from 'playwright-core';
import { sanitizeBrowserText } from '@liftoffos/redact';
import { withTenantScope } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { withPage } from './cdp-page';

/** Longest address kept, as the activity record keeps one. */
const URL_CAP = 2_000;

/** Longest file name kept. */
const NAME_CAP = 200;

/** The most a single file may be. Above this the fetch refuses rather than
 *  pulling a gigabyte through the page, the runtime and the store: the chat
 *  surface renders a card, not an archive. */
export const MAX_FILE_BYTES = 40 * 1024 * 1024;

/** How long the in-page fetch may take before it is abandoned. */
const FETCH_TIMEOUT_MS = 60_000;

/** How much of the browser's own read is taken at a time. */
const IO_CHUNK_BYTES = 1 << 20;

export interface SessionDownload {
  id: string;
  url: string;
  suggestedFileName: string;
  originUrl: string;
  createdAt: Date;
}

interface DownloadRow {
  id: string;
  url: string;
  suggested_file_name: string;
  origin_url: string;
  created_at: Date;
}

function mapRow(row: DownloadRow): SessionDownload {
  return {
    id: row.id,
    url: row.url,
    suggestedFileName: row.suggested_file_name,
    originUrl: row.origin_url,
    createdAt: row.created_at,
  };
}

/**
 * Record a download the browser announced. Idempotent per (session, address,
 * name): a page that re-announces the same file, or two listeners on one
 * connection, leave one row.
 */
export async function recordDownload(input: {
  tenantId: string;
  sessionId: string;
  url: string;
  suggestedFileName?: string;
  originUrl?: string;
}): Promise<void> {
  const url = sanitizeBrowserText(input.url, URL_CAP);
  const name = sanitizeBrowserText(input.suggestedFileName ?? '', NAME_CAP);
  const origin = sanitizeBrowserText(input.originUrl ?? '', URL_CAP);
  await withTenantScope(input.tenantId, async (client) => {
    await client.query(
      `INSERT INTO browser_session_downloads
         (tenant_id, session_id, url, url_truncated, url_protected_data_omitted, suggested_file_name, origin_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (session_id, url, suggested_file_name) DO NOTHING`,
      [
        input.tenantId, input.sessionId, url.text, url.truncated, url.protectedDataOmitted,
        name.text, origin.text,
      ],
    );
  });
}

/** What this session has downloaded, newest last, as the tool's contract
 *  promises ("most recent download is at the end of the list"). */
export async function listDownloads(tenantId: string, sessionId: string): Promise<SessionDownload[]> {
  return withTenantScope(tenantId, async (client) => {
    const { rows } = await client.query<DownloadRow>(
      `SELECT id, url, suggested_file_name, origin_url, created_at
         FROM browser_session_downloads
        WHERE tenant_id = $1 AND session_id = $2
        ORDER BY created_at ASC`,
      [tenantId, sessionId],
    );
    return rows.map(mapRow);
  });
}

/** One recorded download by its id. */
export async function downloadById(
  tenantId: string, sessionId: string, id: string,
): Promise<SessionDownload | null> {
  return withTenantScope(tenantId, async (client) => {
    const { rows } = await client.query<DownloadRow>(
      `SELECT id, url, suggested_file_name, origin_url, created_at
         FROM browser_session_downloads
        WHERE tenant_id = $1 AND session_id = $2 AND id = $3`,
      [tenantId, sessionId, id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  });
}

export class FileTooLarge extends Error {
  constructor(public readonly sizeBytes: number) {
    super(`the file is ${Math.round(sizeBytes / (1024 * 1024))} MB, over the ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB a file card takes`);
    this.name = 'FileTooLarge';
  }
}

export class FileNotFetchable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileNotFetchable';
  }
}

export interface FetchedFile {
  bytes: Buffer;
  contentType: string;
  /** The name the server gave it, when it gave one. */
  filename: string | null;
}

/** Only these reach a browser a person is watching, and only these are worth
 *  fetching from one. */
function assertFetchableUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new FileNotFetchable(`"${url.slice(0, 80)}" is not a web address`);
  }
  // `blob:` is here because a generator that renders in the browser never
  // puts the file on a server at all: the address on the <video> is the only
  // one there is, and only the page that made it can resolve it.
  if (!['http:', 'https:', 'blob:'].includes(parsed.protocol)) {
    throw new FileNotFetchable('only http, https and blob addresses can be fetched from the browser');
  }
  return parsed;
}

/** The name a Content-Disposition header gives, if it gives one. */
function filenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null;
  const star = /filename\*=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  if (star?.[1]) { try { return decodeURIComponent(star[1]); } catch { return star[1]; } }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain?.[1] ?? null;
}

// ── A file that exists for one moment ───────────────────────────────
//
// A page that builds a file in the browser hands it to the person as a
// `blob:` address, and the usual idiom revokes that address as soon as the
// click is done:
//
//     const url = URL.createObjectURL(blob)
//     a.href = url; a.click()
//     URL.revokeObjectURL(url)
//
// So the address outlives the file by a few milliseconds. Recording it and
// fetching later cannot work: such a download is listed correctly and then
// fails to fetch.
//
// The only moment the bytes exist is the announcement, so that is when they
// are taken. Kept in memory, per process, bounded and with a short life:
// this is a file on its way to a person, not storage. Nothing reaches the
// database, and a session that ends takes its entries with it.

interface KeptFile {
  bytes: Buffer;
  contentType: string;
  keptAt: number;
}

/** How long a kept file is worth keeping. Long enough for the model to
 *  notice the download and ask for it; short enough that a busy instance
 *  does not carry a person's files around. */
const KEPT_TTL_MS = 15 * 60_000;

/** The most this process holds across every session. The oldest go first. */
const KEPT_MAX_BYTES = 64 * 1024 * 1024;

const kept = new Map<string, KeptFile>();

function keptKey(vendorSessionId: string, url: string): string {
  return `${vendorSessionId}|${url}`;
}

function forgetStale(): void {
  const deadline = Date.now() - KEPT_TTL_MS;
  let total = 0;
  for (const [key, file] of kept) {
    if (file.keptAt < deadline) kept.delete(key);
    else total += file.bytes.byteLength;
  }
  // Oldest first, which Map iteration already gives us.
  for (const [key, file] of kept) {
    if (total <= KEPT_MAX_BYTES) break;
    kept.delete(key);
    total -= file.bytes.byteLength;
  }
}

/**
 * Take the bytes of a download that will not survive being asked for later.
 *
 * Called from the download announcement (cdp-page.ts), for a `blob:` address
 * only: every other kind can be fetched again when somebody wants it, and
 * fetching those here would pull files nobody asked for through this process.
 * Best effort by nature: the page may already have revoked the address, and
 * then the fetch fails and the download stays listed with nothing behind it.
 */
export async function keepDownloadBytes(
  vendor: string, vendorSessionId: string, tenantId: string, url: string,
): Promise<void> {
  if (!url.startsWith('blob:')) return;
  forgetStale();
  try {
    const fetched = await withPage(vendor, vendorSessionId, tenantId,
      async (page: Page) => (await takeHeldBlob(page, url)) ?? await fetchInsidePage(page, url),
      'keepDownloadBytes');
    if (!fetched.base64) {
      // The race with the page's own revoke, lost. Said out loud: a silent
      // return here made a lost race indistinguishable from a download that
      // was never a blob, and the first live run of this looked like the
      // capture had not run at all.
      logger.info(
        { tenantId, vendor, vendor_session_id: vendorSessionId, event: 'browser_download_not_kept', reason: fetched.error ?? 'empty' },
        'the page let go of the file before its bytes could be taken',
      );
      return;
    }
    const bytes = Buffer.from(fetched.base64, 'base64');
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES) {
      logger.info(
        { tenantId, vendor, vendor_session_id: vendorSessionId, event: 'browser_download_not_kept', size_bytes: bytes.byteLength },
        'the file was empty or too large to keep',
      );
      return;
    }
    kept.set(keptKey(vendorSessionId, url), {
      bytes,
      contentType: (fetched.contentType ?? '').split(';')[0].trim(),
      keptAt: Date.now(),
    });
    logger.info(
      { tenantId, vendor, vendor_session_id: vendorSessionId, size_bytes: bytes.byteLength, event: 'browser_download_kept' },
      'a download the page built in the browser was taken while it existed',
    );
  } catch (err) {
    logger.warn(
      { tenantId, vendor, vendor_session_id: vendorSessionId, err: (err as Error).message },
      'could not take the bytes of a download the page built in the browser',
    );
  }
}

/** The kept bytes for a download, if this process still has them. */
function takeKept(vendorSessionId: string, url: string): KeptFile | null {
  forgetStale();
  return kept.get(keptKey(vendorSessionId, url)) ?? null;
}

/** For tests: forget everything kept. */
export function _clearKeptDownloads(): void {
  kept.clear();
}

/** What either route answers with, before it becomes a FetchedFile. */
interface RawFetch {
  base64?: string;
  contentType?: string;
  disposition?: string | null;
  error?: string;
  tooLarge?: number;
}

/** A header from a CDP response, whatever case the server used. */
function headerOf(headers: Record<string, string> | undefined, name: string): string | null {
  if (!headers) return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}

/**
 * Fetch through the BROWSER's own network stack, not the page's.
 *
 * This is the route that works. A page that generated something almost never
 * serves it from its own origin: the video is on a CDN subdomain, and a
 * `fetch` from inside the page is a cross-origin request the CDN never
 * consented to, so the browser refuses it before it leaves. An in-page fetch
 * succeeds only once the page navigates to the file so the page and the file
 * share an origin.
 *
 * `Network.loadNetworkResource` is the browser fetching, the way it fetches a
 * sourcemap: the session's cookies are attached, and same-origin policy does
 * not apply because there is no document making the request. The bytes come
 * back as a stream read through `IO.read`.
 *
 * Answers null when this browser has no such command, so the in-page fetch
 * still gets its turn.
 */
async function loadThroughBrowser(page: Page, url: string): Promise<RawFetch | null> {
  let cdp: import('playwright-core').CDPSession;
  try {
    cdp = await page.context().newCDPSession(page);
  } catch {
    // Not a Chromium connection, or a page that cannot take one.
    return null;
  }
  try {
    const tree = await cdp.send('Page.getFrameTree') as unknown as { frameTree: { frame: { id: string } } };
    const loaded = await cdp.send('Network.loadNetworkResource', {
      frameId: tree.frameTree.frame.id,
      url,
      options: { disableCache: false, includeCredentials: true },
    } as never) as unknown as {
      resource: {
        success: boolean; netErrorName?: string; httpStatusCode?: number;
        stream?: string; headers?: Record<string, string>;
      };
    };
    const resource = loaded.resource;
    if (!resource.success || !resource.stream) {
      // A refusal the browser itself made: a 404, a host that does not
      // resolve, a connection reset. Said plainly rather than retried.
      const status = resource.httpStatusCode ? `status ${resource.httpStatusCode}` : resource.netErrorName;
      return { error: `the browser could not fetch it${status ? ` (${status})` : ''}` };
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const read = await cdp.send('IO.read', { handle: resource.stream, size: IO_CHUNK_BYTES } as never) as unknown as
          { data: string; base64Encoded?: boolean; eof: boolean };
        if (read.data) {
          const chunk = Buffer.from(read.data, read.base64Encoded ? 'base64' : 'utf8');
          size += chunk.byteLength;
          if (size > MAX_FILE_BYTES) return { tooLarge: size };
          chunks.push(chunk);
        }
        if (read.eof) break;
      }
    } finally {
      await cdp.send('IO.close', { handle: resource.stream } as never).catch(() => undefined);
    }
    if (size === 0) return { error: 'the file came back empty' };
    return {
      base64: Buffer.concat(chunks).toString('base64'),
      contentType: headerOf(resource.headers, 'content-type') ?? '',
      disposition: headerOf(resource.headers, 'content-disposition'),
    };
  } catch (err) {
    // A browser whose protocol has no such command is not a failure to
    // report: the in-page fetch still gets its turn.
    logger.info({ err: (err as Error).message, event: 'browser_file_load_unavailable' },
      'the browser could not load the file itself; fetching from inside the page');
    return null;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/**
 * Fetch from inside the page, as the page itself would.
 *
 * Second, because same-origin policy applies here and it is what blocks the
 * usual case. It is kept because it is the only route for an address only the
 * document can resolve, a `blob:` a generator made in the browser and never
 * put on a server, and it covers a browser whose protocol lacks the command
 * above.
 */
/**
 * A file the page BUILT, taken through the handle the session holds on it.
 *
 * `blob:` is not an address anything can go and get: it resolves only inside
 * the document that made it, and only until that document revokes it, which a
 * generator does in the same tick as the click. Fetching it is a race that was
 * lost every time. The session holds onto what the page builds (cdp-page.ts),
 * so this asks for the file itself rather than chasing its address.
 *
 * Null when the page was not armed, or built the file before it was, in which
 * case the ordinary fetch is still tried and will probably fail — with the
 * refusal that tells the model to download it again.
 */
async function takeHeldBlob(page: Page, url: string): Promise<RawFetch | null> {
  try {
    const got = await page.evaluate(
      async (target) => {
        const take = (globalThis as unknown as { __liftoffTakeHeldBlob?: (u: string) => Promise<{ base64: string; contentType: string } | null> })
          .__liftoffTakeHeldBlob;
        if (!take) return null;
        return take(target);
      },
      url,
    ) as { base64: string; contentType: string } | null;
    if (!got || !got.base64) return null;
    return { base64: got.base64, contentType: got.contentType };
  } catch {
    return null;
  }
}

function fetchInsidePage(page: Page, url: string): Promise<RawFetch> {
  return page.evaluate(
    async ({ target, cap, timeoutMs }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(target, { credentials: 'include', signal: controller.signal });
        if (!response.ok) return { error: `the page could not fetch it (status ${response.status})` };
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > cap) return { tooLarge: buffer.byteLength };
        // Chunked so a large file does not build one enormous argument to
        // String.fromCharCode, which throws past a few hundred thousand.
        const view = new Uint8Array(buffer);
        let binary = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < view.length; i += CHUNK) {
          binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
        }
        return {
          base64: btoa(binary),
          contentType: response.headers.get('content-type') ?? '',
          disposition: response.headers.get('content-disposition'),
        };
      } catch (err) {
        return { error: (err as Error).message || 'the page could not fetch it' };
      } finally {
        clearTimeout(timer);
      }
    },
    { target: url, cap: MAX_FILE_BYTES, timeoutMs: FETCH_TIMEOUT_MS },
  ) as Promise<RawFetch>;
}

/**
 * Fetch a file the session can see.
 *
 * The browser fetches it first and the page fetches it only if the browser
 * cannot, because the two differ in exactly the case that matters: the
 * browser's own fetch carries the session's cookies with no same-origin
 * policy over it, and a generated file almost always lives on an origin the
 * page does not share. Either way it is the SESSION doing the fetching, which
 * is what makes a file behind a sign-in come back at all.
 *
 * A file that does not come back is a refusal with a reason, never empty
 * bytes.
 */
export async function fetchFileFromSession(
  vendor: string,
  vendorSessionId: string,
  tenantId: string,
  url: string,
): Promise<FetchedFile> {
  const parsed = assertFetchableUrl(url);
  const fetched = await withPage(vendor, vendorSessionId, tenantId, async (page: Page) => {
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      const viaBrowser = await loadThroughBrowser(page, url);
      // A refusal the browser reasoned about stands: asking the page to try
      // the same address again would only reach the same server.
      if (viaBrowser && (viaBrowser.base64 || viaBrowser.tooLarge)) return viaBrowser;
      if (viaBrowser?.error) {
        const insidePage = await fetchInsidePage(page, url);
        return insidePage.base64 || insidePage.tooLarge ? insidePage : viaBrowser;
      }
    }
    // A file the page built: the handle the session holds on it, because its
    // address is dead by now by the page's own design.
    return (await takeHeldBlob(page, url)) ?? await fetchInsidePage(page, url);
  }, 'fetchFileFromSession');

  if (fetched.tooLarge) throw new FileTooLarge(fetched.tooLarge);
  if (fetched.error || !fetched.base64) throw new FileNotFetchable(fetched.error ?? 'the file came back empty');
  const bytes = Buffer.from(fetched.base64, 'base64');
  if (bytes.byteLength === 0) throw new FileNotFetchable('the file came back empty');
  if (bytes.byteLength > MAX_FILE_BYTES) throw new FileTooLarge(bytes.byteLength);
  logger.info(
    { tenantId, vendor, vendor_session_id: vendorSessionId, size_bytes: bytes.byteLength, event: 'browser_file_fetched' },
    'a file was fetched from the session',
  );
  return {
    bytes,
    contentType: (fetched.contentType ?? '').split(';')[0].trim() || 'application/octet-stream',
    filename: filenameFromDisposition(fetched.disposition ?? null),
  };
}

// ── What a caller asks for ──────────────────────────────────────
//
// Two callers reach these: the agents' own tools, and the RPCs the three
// platform assistants come in through. They share the body so the two cannot
// answer differently about the same session, which is exactly how downloads
// came to work on one browser and not the other three.

/** Anchor's own download store, the one vendor that keeps one. Built here
 *  rather than imported from the tool layer, which imports this. */
let anchorStoreClient: import('../integrations/web-fetch/anchor-client').AnchorClient | null = null;
async function anchorStore(): Promise<import('../integrations/web-fetch/anchor-client').AnchorClient> {
  if (!anchorStoreClient) {
    const { AnchorClient } = await import('../integrations/web-fetch/anchor-client');
    anchorStoreClient = new AnchorClient();
  }
  return anchorStoreClient;
}

/** A session, as much of one as this needs. */
export interface DownloadSession {
  id: string;
  vendor: string;
  vendorSessionId: string;
}

/** One download, as a caller reports it. */
export interface SessionDownloadView {
  id: string;
  url: string;
  suggestedFileName: string;
  originUrl: string;
  /** ISO 8601. */
  downloadedAt: string;
}

/** A file name from an address, for a download the browser named nothing. */
export function fileNameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    const cleaned = decodeURIComponent(last).trim();
    if (cleaned && cleaned.length <= 120) return cleaned;
  } catch { /* an address we cannot parse names nothing */ }
  return '';
}

/**
 * Everything this session has downloaded, oldest first.
 *
 * What the session's own connection heard, which is every vendor. Anchor
 * keeps a download store of its own, holding what its in-session work saved,
 * and that is merged in by address so a file both sides know about appears
 * once. A vendor store that cannot be read costs nothing that was heard
 * directly.
 */
export async function listDownloadsForSession(
  tenantId: string, session: DownloadSession,
): Promise<SessionDownloadView[]> {
  const recorded = await listDownloads(tenantId, session.id);
  const downloads: SessionDownloadView[] = recorded.map((d) => ({
    id: d.id,
    url: d.url,
    suggestedFileName: d.suggestedFileName || fileNameFromUrl(d.url),
    originUrl: d.originUrl,
    downloadedAt: d.createdAt.toISOString(),
  }));
  if (session.vendor !== 'anchor') return downloads;
  try {
    const items = await (await anchorStore()).listSessionDownloads(session.vendorSessionId, tenantId);
    const known = new Set(downloads.map((d) => d.url));
    for (const item of items) {
      const url = item.originalDownloadUrl ?? item.fileLink;
      if (!url || known.has(url)) continue;
      downloads.push({
        id: item.id,
        url,
        suggestedFileName: item.suggestedFileName || item.originalFileName || fileNameFromUrl(url),
        originUrl: item.originUrl ?? '',
        downloadedAt: item.createdAt,
      });
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message, vendor_session_id: session.vendorSessionId },
      'the vendor download store could not be read; reporting what the session was heard to download');
  }
  downloads.sort((a, b) => a.downloadedAt.localeCompare(b.downloadedAt));
  return downloads;
}

/** A file on its way to a person. */
export interface SessionFile {
  bytes: Buffer;
  filename: string;
  contentType: string;
  sourceUrl: string;
  /** What is wrong with it, when something is. Empty when it looks like the
   *  file that was asked for, or when nothing could be told. The file is
   *  delivered either way: this is what the person is told beside it, not a
   *  refusal. */
  concern?: string;
}

/**
 * Bring one file out of the session: a recorded download by `downloadId`, or
 * any address the page points at by `url`.
 *
 * The address route is the one that matters for a page that generated
 * something. A video generator finishes and puts the clip at a plain address
 * on its own CDN; nothing was downloaded, so there is no download to name,
 * and reading the address out of the page is the only handle anybody has on
 * the file. Fetching it from inside the page turns that address into bytes
 * the person can be handed.
 */
export async function fetchFileForSession(
  tenantId: string,
  session: DownloadSession,
  asked: { downloadId?: string; url?: string; wanted?: string },
): Promise<SessionFile> {
  const askedUrl = (asked.url ?? '').trim();
  const askedId = (asked.downloadId ?? '').trim();
  if (!askedUrl && !askedId) {
    throw new FileNotFetchable('name the file to fetch: a download id, or the address of the file on the page');
  }
  let url = askedUrl;
  let name = '';
  let sourceUrl = askedUrl;
  if (!url && askedId) {
    const found = await downloadById(tenantId, session.id, askedId);
    if (found) {
      url = found.url;
      name = found.suggestedFileName;
      sourceUrl = found.originUrl || found.url;
    }
  }
  if (!url && askedId && session.vendor === 'anchor') {
    // An id from this vendor's own store, which its in-session work writes to
    // and nothing else can see.
    const anchor = await anchorStore();
    const items = await anchor.listSessionDownloads(session.vendorSessionId, tenantId);
    const match = items.find((d) => d.id === askedId);
    if (match) {
      const filename = match.suggestedFileName || match.originalFileName || 'browser-download';
      return withCheck(tenantId, asked.wanted ?? '', {
        bytes: await anchor.fetchDownloadBytes(match.fileLink, tenantId),
        filename,
        contentType: contentTypeFromName(filename),
        sourceUrl: match.originUrl ?? match.originalDownloadUrl ?? '',
      });
    }
  }
  if (!url) {
    throw new FileNotFetchable(
      `no download with id "${askedId}" on this browser session. List the downloads for the ids it has, or pass the address of the file instead.`,
    );
  }
  // A file the page built in the browser was taken when it was announced,
  // because by now the page has almost certainly revoked the address.
  const keptFile = takeKept(session.vendorSessionId, url);
  if (keptFile) {
    const filename = name || fileNameFromUrl(url) || 'browser-download';
    return withCheck(tenantId, asked.wanted ?? '', {
      bytes: keptFile.bytes,
      filename,
      contentType: keptFile.contentType || contentTypeFromName(filename),
      sourceUrl: sourceUrl || url,
    });
  }
  try {
    const fetched = await fetchFileFromSession(session.vendor, session.vendorSessionId, tenantId, url);
    const filename = fetched.filename || name || fileNameFromUrl(url) || 'browser-download';
    return withCheck(tenantId, asked.wanted ?? '', {
      bytes: fetched.bytes,
      filename,
      contentType: fetched.contentType !== 'application/octet-stream'
        ? fetched.contentType
        : contentTypeFromName(filename),
      sourceUrl: sourceUrl || url,
    });
  } catch (err) {
    if (url.startsWith('blob:') && err instanceof FileNotFetchable) {
      // Nothing the model does to this address will work, so it is told what
      // will: the page still has the thing it made, and downloading it again
      // makes a new one.
      throw new FileNotFetchable(
        `${name || 'that file'} was built inside the page and the page has already let go of it, so it cannot be fetched now. `
        + 'Download it again on the page and ask for it straight away, or find the file\'s own web address on the page and pass that instead.',
      );
    }
    throw err;
  }
}

/**
 * Look at the file before handing it over.
 *
 * A fetch that returns bytes is not a fetch that returned the RIGHT bytes: a
 * site wanting a sign-in answers a download with its login page, and that is
 * a successful response. The file is still delivered — the concern travels
 * beside it, for the caller to pass on — because a file we merely doubt is
 * better in the person's hands with a warning than withheld on a suspicion.
 */
async function withCheck(tenantId: string, wanted: string, file: SessionFile): Promise<SessionFile> {
  // The bytes first, because this one cannot be wrong and costs nothing. The
  // type came from the file's NAME, and a name is chosen by the site: a
  // generator out of free credits answers its own download control with its
  // rate-limit page, called clip.mp4, and every layer after that reads the
  // extension and calls it a video.
  const { verifyClaimedType } = await import('./sniff-file-type');
  const verdict = verifyClaimedType(file.bytes, file.contentType, file.filename);
  const checked: SessionFile = verdict.concern
    ? { ...file, contentType: verdict.contentType, concern: verdict.concern }
    : { ...file, contentType: verdict.contentType };
  if (verdict.concern) {
    logger.info(
      { tenantId, claimed: file.contentType, actual: verdict.contentType, event: 'browser_file_type_corrected' },
      'a fetched file was not the kind it was called',
    );
    // A file whose own bytes contradict its name needs no model to doubt it.
    return checked;
  }
  try {
    const { checkFetchedFile } = await import('./file-check');
    const looked = await checkFetchedFile({
      objective: wanted,
      filename: checked.filename,
      contentType: checked.contentType,
      bytes: checked.bytes,
      tenantId,
    });
    return looked.looksRight ? checked : { ...checked, concern: looked.concern };
  } catch (err) {
    logger.warn({ err: (err as Error).message, tenantId }, 'a fetched file could not be checked; handing it over');
    return checked;
  }
}

/** The type a file name implies, for a server that named none. The common
 *  ones are enumerated; anything else downloads cleanly as a file without
 *  rendering inline, which is the safe way to be wrong. */
export function contentTypeFromName(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  switch (filename.slice(dot + 1).toLowerCase()) {
    case 'pdf':  return 'application/pdf';
    case 'csv':  return 'text/csv';
    case 'json': return 'application/json';
    case 'txt':  return 'text/plain';
    case 'html': return 'text/html';
    case 'zip':  return 'application/zip';
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'xls':  return 'application/vnd.ms-excel';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'doc':  return 'application/msword';
    case 'pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'ppt':  return 'application/vnd.ms-powerpoint';
    case 'png':  return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif':  return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg':  return 'image/svg+xml';
    case 'mp4':  return 'video/mp4';
    case 'webm': return 'video/webm';
    case 'mp3':  return 'audio/mpeg';
    case 'wav':  return 'audio/wav';
    case 'ogg':  return 'audio/ogg';
    case 'm4a':  return 'audio/mp4';
    default:     return 'application/octet-stream';
  }
}

/** The media types platform-backend stores as media, so the person sees the
 *  thing itself in the conversation rather than a card to open. Mirrors
 *  MEDIA_TYPE_EXTENSIONS in platform-backend's generated-files store; a type
 *  outside it is delivered as a file, which always works. */
const MEDIA_CONTENT_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm',
  'audio/mpeg', 'audio/mp4', 'audio/webm', 'audio/ogg',
]);

/** Whether a file of this type is shown in the conversation rather than
 *  offered as a card to open. */
export function isShownInConversation(contentType: string): boolean {
  return MEDIA_CONTENT_TYPES.has(contentType);
}
