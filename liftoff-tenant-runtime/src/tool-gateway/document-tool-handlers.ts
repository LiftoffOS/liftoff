/**
 * Document Tool Handlers
 *
 * Per-manifest handler implementations for cloud storage document tools:
 * listFiles, readDocument, findInDocument, generateXlsx, generateDocx, editDocument,
 * readPresentation, generatePptx, editPresentation.
 *
 * Uses CONNECTOR_SERVICE_URL for cloud storage REST calls and
 * PLATFORM_BACKEND_URL for generated-file registry calls.
 * Service auth uses TENANT_RUNTIME_SERVICE_TOKEN in X-Service-Auth header.
 */
import type { ConnectorManifest, ToolErrorCode } from '@liftoffos/connector-types';
import type { StandardToolContext } from '../tools/standard-tool-handler';
import { logger } from '../infrastructure/logging';
import { buildOidcAuthHeader } from '@liftoffos/service-client';
import { getManagedSecret } from '../infrastructure/secret-store';
import { resolveInternalAgentId } from '../agent-lifecycle/resolve-runtime-agent-id';
import { fileCardHostNote } from './file-card-note';

// ── Module-level text cache (valid for the agent run lifetime) ────────────────
const documentTextCache = new Map<string, string>();
const documentNameCache = new Map<string, string>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function getConnectorServiceUrl(): string {
  return (process.env.CONNECTOR_SERVICE_URL ?? '').replace(/\/+$/, '');
}

function getPlatformBackendUrl(): string {
  return (process.env.PLATFORM_BACKEND_URL ?? '').replace(/\/+$/, '');
}

function getServiceToken(): string {
  return getManagedSecret('TENANT_RUNTIME_SERVICE_TOKEN') ?? '';
}

function getConnectorServiceToken(): string {
  return getManagedSecret('CONNECTOR_SERVICE_TOKEN') ?? '';
}

function pbAuthHeaders(): Record<string, string> {
  return {
    'X-Service-Auth': getServiceToken(),
  };
}

/** Classified document-tool failure. `code` carries the tool-error contract so
 *  the document-tools MCP wrapper renders a uniform TOOL_ERROR envelope; `error`
 *  is kept as the machine string the wrapper uses to detect the error branch. */
export interface DocumentToolError {
  error: string;
  code: ToolErrorCode;
  message: string;
}

/**
 * Classify a connector-service REST failure into the tool-error contract, so the
 * model reads the ACTUAL problem instead of a blanket "re-authorize":
 *   401 / 403 / 409 → auth_expired    (genuine auth / inactive → reconnect)
 *   404             → not_found       (missing file, or op unsupported for this connector)
 *   429             → rate_limited
 *   500             → internal_error     (our own service failed; NOT retryable)
 *   other 5xx / net → vendor_unavailable
 * Called with the HTTP status; call with no status for a thrown/network failure.
 */
export function connectorRestError(status?: number): DocumentToolError {
  if (status === 401 || status === 403 || status === 409) {
    return {
      error: 'connector_auth_required',
      code: 'auth_expired',
      message: 'This connector needs to be re-authorized. Reconnect it in Settings, then retry.',
    };
  }
  if (status === 404) {
    return {
      error: 'not_found',
      code: 'not_found',
      message: 'The requested file or connector operation was not found. Verify the id/path — the operation may not be supported for this connector.',
    };
  }
  if (status === 429) {
    return {
      error: 'rate_limited',
      code: 'rate_limited',
      message: 'The connector is rate limiting requests. Retry shortly.',
    };
  }
  // A 500 comes from connector-service, which is ours. That is a bug in the
  // request path, not a vendor having a bad minute: the same call made again
  // fails the same way. Reporting it as temporary spends another run to learn
  // nothing, and tells the person waiting to try again when they should be
  // telling somebody. `internal_error` is non-retryable in the contract, so
  // the retry flag follows from the code rather than being asserted here.
  //
  // 502/503/504 stay vendor_unavailable: those are the statuses that mean the
  // hop beyond us did not answer, which is the case retrying is for.
  if (status === 500) {
    return {
      error: 'connector_internal_error',
      code: 'internal_error',
      message:
        'The connector service failed while handling this request. Retrying will not help. '
        + 'Report it, and say which file or operation was involved.',
    };
  }
  return {
    error: 'connector_unavailable',
    code: 'vendor_unavailable',
    message: 'The connector is temporarily unavailable. Retry shortly; if it persists, report it.',
  };
}

/** Genuine auth failure (401). Retained for call sites that KNOW it's auth. */
export const CONNECTOR_AUTH_ERROR: DocumentToolError = connectorRestError(401);

async function fetchConnector(
  manifest: ConnectorManifest,
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const base = getConnectorServiceUrl();
  const url = `${base}${path}`;
  const headers: Record<string, string> = {
    'X-Service-Auth': getConnectorServiceToken(),
    ...(options?.headers as Record<string, string> ?? {}),
  };
  // Cloud Run requires an OIDC identity token in Authorization — same pattern
  // as the Connect-RPC interceptor in connector-service-client.ts.
  try {
    const oidc = await buildOidcAuthHeader(base);
    Object.assign(headers, oidc);
  } catch {
    // No metadata server in local dev — silently skip.
  }
  return fetch(url, { ...options, headers });
}

// ── listFiles ─────────────────────────────────────────────────────────────────

export interface ListFilesArgs {
  path?: string;
  query?: string;
  mimeTypes?: string[];
  recursive?: boolean;
  maxResults?: number;
}

export interface FileMetadata {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
  modifiedAt?: string;
  path?: string;
  webViewUrl?: string;
}

export interface ListFilesResult {
  files: FileMetadata[];
  nextPageToken?: string;
}

export async function listFiles(
  args: ListFilesArgs,
  manifest: ConnectorManifest,
  ctx: StandardToolContext & { invocationId?: string },
): Promise<ListFilesResult | typeof CONNECTOR_AUTH_ERROR> {
  const params = new URLSearchParams();
  params.set('tenantId', ctx.tenantId);
  if (args.path) params.set('path', args.path);
  if (args.query) params.set('query', args.query);
  if (args.maxResults) params.set('limit', String(args.maxResults));
  if (args.recursive) params.set('recursive', 'true');
  if (args.mimeTypes?.length) params.set('mimeTypes', args.mimeTypes.join(','));

  const qs = params.toString();
  const path = `/api/connectors/${manifest.id}/files${qs ? `?${qs}` : ''}`;

  try {
    const resp = await fetchConnector(manifest, path, { method: 'GET' });
    if (resp.status === 401 || resp.status === 403) {
      return CONNECTOR_AUTH_ERROR;
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      logger.warn({ status: resp.status, text, connectorId: manifest.id }, 'listFiles connector error');
      return connectorRestError(resp.status);
    }
    return (await resp.json()) as ListFilesResult;
  } catch (err) {
    logger.error({ err, connectorId: manifest.id }, 'listFiles fetch failed');
    return connectorRestError();
  }
}

// ── readDocument ──────────────────────────────────────────────────────────────

export interface ReadDocumentArgs {
  fileId: string;
}

export interface ReadDocumentResult {
  fileId: string;
  name: string;
  textContent: string;
  pageCount?: number;
  mimeType?: string;
}

export async function readDocument(
  args: ReadDocumentArgs,
  manifest: ConnectorManifest,
  ctx: StandardToolContext & { invocationId?: string },
): Promise<ReadDocumentResult | typeof CONNECTOR_AUTH_ERROR> {
  const cacheKey = `${manifest.id}:${args.fileId}`;

  const cached = documentTextCache.get(cacheKey);
  if (cached) {
    return { fileId: args.fileId, name: documentNameCache.get(cacheKey) ?? args.fileId, textContent: cached };
  }

  // exportAs=text states what this tool is for: everything below turns the
  // response into a string. It matters for two file classes.
  //
  // A composio_managed connector (the Composio-brokered set — Drive, Gmail,
  // Calendar and friends) has no access token to lend, because Composio signs
  // requests server-side and hands back a decoded body. Text is the only shape
  // that survives that hop, so without this every Drive file on such a
  // connector is unreadable: browse lists it, readDocument cannot open it.
  //
  // And a Google Sheet arrives as CSV rather than .xlsx, which nothing here
  // can parse; it used to fall through to `buffer.toString('utf-8')` on a zip
  // and hand the model mojibake.
  //
  // readPresentation, editDocument and editPresentation deliberately do NOT
  // send it — they parse or rewrite real .pptx/.docx bytes.
  const path = `/api/connectors/${manifest.id}/files/${encodeURIComponent(args.fileId)}/content?tenantId=${encodeURIComponent(ctx.tenantId)}&exportAs=text`;

  try {
    const resp = await fetchConnector(manifest, path, { method: 'GET' });
    if (resp.status === 401 || resp.status === 403) {
      return CONNECTOR_AUTH_ERROR;
    }
    if (!resp.ok) {
      logger.warn({ status: resp.status, connectorId: manifest.id, fileId: args.fileId }, 'readDocument content error');
      return connectorRestError(resp.status);
    }

    const disposition = resp.headers.get('content-disposition') ?? '';
    const nameMatch = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
    const fileName = nameMatch?.[1] ?? args.fileId;
    const mimeType = resp.headers.get('content-type')?.split(';')[0]?.trim() ?? '';

    const arrayBuffer = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let textContent: string;
    let pageCount: number | undefined;
    const lowerName = fileName.toLowerCase();

    if (mimeType === 'application/pdf' || lowerName.endsWith('.pdf')) {
      const pdfMod = await import('pdf-parse') as unknown as {
        default?: (buf: Buffer) => Promise<{ text: string; numpages: number }>;
        (buf: Buffer): Promise<{ text: string; numpages: number }>;
      };
      const pdfParse = typeof pdfMod.default === 'function' ? pdfMod.default : pdfMod;
      const data = await pdfParse(buffer);
      textContent = data.text;
      pageCount = data.numpages;
    } else if (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      lowerName.endsWith('.docx')
    ) {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      textContent = result.value;
    } else if (
      mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
      lowerName.endsWith('.pptx')
    ) {
      const { text, slideCount } = await extractPptxFlatText(buffer);
      textContent = text;
      pageCount = slideCount;
    } else if (lowerName.endsWith('.doc')) {
      textContent = 'Legacy .doc format not supported. Please convert to .docx.';
    } else {
      textContent = buffer.toString('utf-8');
    }

    documentTextCache.set(cacheKey, textContent);
    documentNameCache.set(cacheKey, fileName);

    return { fileId: args.fileId, name: fileName, textContent, pageCount, mimeType };
  } catch (err) {
    logger.error({ err, connectorId: manifest.id, fileId: args.fileId }, 'readDocument failed');
    return connectorRestError();
  }
}

// ── findInDocument ────────────────────────────────────────────────────────────
//
// Whitespace-tolerant exact substring search (case-insensitive).
// Normalises both text and query to single-space whitespace, then uses
// indexOf for exact matching. Returns up to maxResults hits with
// surrounding context. More reliable than keyword density for legal clause
// lookups where you know the exact text you're searching for.

export interface FindInDocumentArgs {
  fileId: string;
  query: string;
  maxResults?: number;
  contextChars?: number;
}

export interface FindInDocumentHit {
  index: number;
  excerpt: string;
  context: string;
}

export interface FindInDocumentResult {
  ok: boolean;
  filename?: string;
  query: string;
  total_matches?: number;
  returned?: number;
  truncated?: boolean;
  hits?: FindInDocumentHit[];
  error?: string;
}

function normalizeWithMap(text: string): { norm: string; origIdx: number[] } {
  const norm: string[] = [];
  const origIdx: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!prevSpace) {
        norm.push(' ');
        origIdx.push(i);
        prevSpace = true;
      }
    } else {
      norm.push(ch.toLowerCase());
      origIdx.push(i);
      prevSpace = false;
    }
  }
  return { norm: norm.join(''), origIdx };
}

function normalizeQuery(q: string): string {
  return q.trim().replace(/\s+/g, ' ').toLowerCase();
}

export async function findInDocument(
  args: FindInDocumentArgs,
  manifest: ConnectorManifest,
  ctx: StandardToolContext & { invocationId?: string },
): Promise<FindInDocumentResult> {
  if (!args.query?.trim()) {
    return { ok: false, query: args.query ?? '', error: 'Empty query.' };
  }

  const cacheKey = `${manifest.id}:${args.fileId}`;
  let text = documentTextCache.get(cacheKey);
  let filename = documentNameCache.get(cacheKey) ?? args.fileId;

  if (!text) {
    const readResult = await readDocument({ fileId: args.fileId }, manifest, ctx);
    if ('error' in readResult) {
      return { ok: false, query: args.query, filename, error: readResult.message };
    }
    text = readResult.textContent;
    filename = readResult.name;
  }

  const maxResults = args.maxResults ?? 20;
  const contextChars = args.contextChars ?? 80;

  const { norm, origIdx } = normalizeWithMap(text);
  const needle = normalizeQuery(args.query);
  if (!needle) {
    return { ok: false, query: args.query, error: 'Empty query after normalisation.' };
  }

  const hits: FindInDocumentHit[] = [];
  let from = 0;
  while (from <= norm.length - needle.length && hits.length < maxResults) {
    const pos = norm.indexOf(needle, from);
    if (pos < 0) break;
    const endNormPos = pos + needle.length;
    const origStart = origIdx[pos] ?? 0;
    const origEnd =
      endNormPos - 1 < origIdx.length
        ? origIdx[endNormPos - 1] + 1
        : text.length;
    const ctxStart = Math.max(0, origStart - contextChars);
    const ctxEnd = Math.min(text.length, origEnd + contextChars);
    hits.push({
      index: hits.length,
      excerpt: text.slice(origStart, origEnd),
      context:
        (ctxStart > 0 ? '…' : '') +
        text.slice(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim() +
        (ctxEnd < text.length ? '…' : ''),
    });
    from = pos + Math.max(1, needle.length);
  }

  // Count remaining occurrences beyond the cap.
  let totalMatches = hits.length;
  if (hits.length >= maxResults) {
    let probe = from;
    while (probe <= norm.length - needle.length) {
      const pos = norm.indexOf(needle, probe);
      if (pos < 0) break;
      totalMatches++;
      probe = pos + Math.max(1, needle.length);
    }
  }

  return {
    ok: true,
    filename,
    query: args.query,
    total_matches: totalMatches,
    returned: hits.length,
    truncated: totalMatches > hits.length,
    hits,
  };
}

// ── readPresentation ──────────────────────────────────────────────────────────

export interface PresentationSlide {
  index: number;
  title?: string;
  bodyText: string;
  tables: Array<{ headers: string[]; rows: string[][] }>;
  notes?: string;
}

export interface ReadPresentationResult {
  fileId: string;
  name: string;
  slideCount: number;
  slides: PresentationSlide[];
  mimeType?: string;
}

export async function readPresentation(
  args: { fileId: string },
  manifest: ConnectorManifest,
  ctx: StandardToolContext,
): Promise<ReadPresentationResult> {
  // Which reader to use is a property of the FILE, not of the connector it
  // came through. A Google-native deck has no bytes to download — Drive
  // materialises a .pptx on demand — so the Slides API is both the better
  // source (structure, speaker notes, no zip parsing) and the only one that
  // works when the connector is composio_managed, where binary cannot cross
  // the proxy at all. Keying this off `connectorType === 'google_slides'` sent
  // every native deck reached through a Drive connector down the .pptx path,
  // which then 401'd (before) or 415'd (after) for Composio tenants.
  if (manifest.connectorType === 'google_slides' || (await isGoogleNativePresentation(args.fileId, manifest, ctx))) {
    return readPresentationSlides(args, manifest, ctx);
  }

  const path = `/api/connectors/${manifest.id}/files/${encodeURIComponent(args.fileId)}/content?tenantId=${encodeURIComponent(ctx.tenantId)}`;
  const resp = await fetchConnector(manifest, path, { method: 'GET' });
  if (!resp.ok) throw new Error(`Failed to fetch file: ${resp.status}`);

  const disposition = resp.headers.get('content-disposition') ?? '';
  const nameMatch = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
  const filename = nameMatch?.[1] ?? args.fileId;
  const mimeType = resp.headers.get('content-type')?.split(';')[0]?.trim() ?? '';

  const arrayBuffer = await resp.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const slides = await parsePptxSlides(buffer);

  const cacheKey = `${manifest.id}:${args.fileId}`;
  const flatText = slides.map((s, i) => {
    const parts: string[] = [];
    if (s.title) parts.push(s.title);
    if (s.bodyText) parts.push(s.bodyText);
    for (const table of s.tables) {
      const tableText = [table.headers, ...table.rows]
        .map(row => row.join('\t'))
        .join('\n');
      if (tableText.trim()) parts.push(tableText);
    }
    return `--- SLIDE ${i + 1} ---\n${parts.join('\n')}`;
  }).join('\n\n');
  documentTextCache.set(cacheKey, flatText);
  documentNameCache.set(cacheKey, filename);

  return {
    fileId: args.fileId,
    name: filename,
    slideCount: slides.length,
    slides,
    mimeType,
  };
}

async function parsePptxSlides(buffer: Buffer): Promise<PresentationSlide[]> {
  const JSZip = (await import('jszip')).default;
  const { XMLParser } = await import('fast-xml-parser');
  const zip = await JSZip.loadAsync(buffer);

  const slideFiles = Object.keys(zip.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = parseInt(a.match(/\d+/)?.[0] ?? '0');
      const nb = parseInt(b.match(/\d+/)?.[0] ?? '0');
      return na - nb;
    });

  const parser = new XMLParser({
    removeNSPrefix: true,
    ignoreAttributes: false,
    attributeNamePrefix: '_attr_',
    textNodeName: '_text',
    isArray: (name) => ['sp', 'p', 'r', 'tr', 'tc', 'graphicFrame'].includes(name),
  });

  function extractRunText(runs: unknown[]): string {
    return runs.map((r: unknown) => {
      const run = r as Record<string, unknown>;
      const t = run['t'];
      if (typeof t === 'string') return t;
      if (t && typeof t === 'object' && '_text' in (t as Record<string, unknown>)) return String((t as Record<string, unknown>)['_text']);
      return '';
    }).join('');
  }

  function extractParaText(paras: unknown[]): string {
    return paras.map((p: unknown) => {
      const para = p as Record<string, unknown>;
      const runs = Array.isArray(para['r']) ? para['r'] : para['r'] ? [para['r']] : [];
      return extractRunText(runs);
    }).filter(Boolean).join('\n');
  }

  const slides: PresentationSlide[] = [];
  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await zip.files[slideFiles[i]].async('string');
    const parsed = parser.parse(xml) as Record<string, unknown>;

    const sld = parsed['sld'] as Record<string, unknown> | undefined;
    const cSld = sld?.['cSld'] as Record<string, unknown> | undefined;
    const spTree = cSld?.['spTree'] as Record<string, unknown> | undefined;

    let title: string | undefined;
    const bodyParts: string[] = [];
    const tables: Array<{ headers: string[]; rows: string[][] }> = [];

    const shapes = Array.isArray(spTree?.['sp']) ? spTree!['sp'] as unknown[] : [];
    for (const sp of shapes) {
      const shape = sp as Record<string, unknown>;
      const nvSpPr = shape['nvSpPr'] as Record<string, unknown> | undefined;
      const ph = (nvSpPr?.['nvPr'] as Record<string, unknown> | undefined)?.['ph'] as Record<string, unknown> | undefined;
      const phType = ph?.['_attr_type'] as string | undefined;
      const txBody = shape['txBody'] as Record<string, unknown> | undefined;
      const paras = txBody ? (Array.isArray(txBody['p']) ? txBody['p'] as unknown[] : txBody['p'] ? [txBody['p']] : []) : [];
      const text = extractParaText(paras);
      if (!text) continue;
      if (phType === 'title' || phType === 'ctrTitle') {
        title = text;
      } else {
        bodyParts.push(text);
      }
    }

    const graphicFrames = Array.isArray(spTree?.['graphicFrame']) ? spTree!['graphicFrame'] as unknown[] : [];
    for (const gf of graphicFrames) {
      const frame = gf as Record<string, unknown>;
      const graphic = frame['graphic'] as Record<string, unknown> | undefined;
      const graphicData = graphic?.['graphicData'] as Record<string, unknown> | undefined;
      const tbl = graphicData?.['tbl'] as Record<string, unknown> | undefined;
      if (!tbl) continue;
      const trs = Array.isArray(tbl['tr']) ? tbl['tr'] as unknown[] : [];
      const rows = trs.map(tr => {
        const row = tr as Record<string, unknown>;
        const cells = Array.isArray(row['tc']) ? row['tc'] as unknown[] : [];
        return cells.map(tc => {
          const cell = tc as Record<string, unknown>;
          const txBody = cell['txBody'] as Record<string, unknown> | undefined;
          const paras = txBody ? (Array.isArray(txBody['p']) ? txBody['p'] as unknown[] : txBody['p'] ? [txBody['p']] : []) : [];
          return extractParaText(paras);
        });
      });
      if (rows.length > 0) {
        tables.push({ headers: rows[0], rows: rows.slice(1) });
      }
    }

    let notes: string | undefined;
    const notesFile = zip.files[`ppt/notesSlides/notesSlide${i + 1}.xml`];
    if (notesFile) {
      const notesXml = await notesFile.async('string');
      const notesParsed = parser.parse(notesXml) as Record<string, unknown>;
      const notesSld = notesParsed['notes'] as Record<string, unknown> | undefined;
      const notesCsld = notesSld?.['cSld'] as Record<string, unknown> | undefined;
      const notesSpTree = notesCsld?.['spTree'] as Record<string, unknown> | undefined;
      const notesShapes = Array.isArray(notesSpTree?.['sp']) ? notesSpTree!['sp'] as unknown[] : [];
      const notesParts: string[] = [];
      for (const sp of notesShapes) {
        const shape = sp as Record<string, unknown>;
        const txBody = shape['txBody'] as Record<string, unknown> | undefined;
        const paras = txBody ? (Array.isArray(txBody['p']) ? txBody['p'] as unknown[] : txBody['p'] ? [txBody['p']] : []) : [];
        const t = extractParaText(paras);
        if (t) notesParts.push(t);
      }
      if (notesParts.length) notes = notesParts.join('\n');
    }

    slides.push({ index: i, title, bodyText: bodyParts.join('\n'), tables, notes });
  }

  return slides;
}

/**
 * Is this file a Google-native presentation, whatever connector it came
 * through? Answered from the connector service's item metadata.
 *
 * Best-effort on purpose: if the lookup fails we fall through to the download
 * path, which is the behaviour that existed before. A metadata call that did
 * not answer is not a reason to refuse to read a file.
 */
async function isGoogleNativePresentation(
  fileId: string,
  manifest: ConnectorManifest,
  ctx: StandardToolContext,
): Promise<boolean> {
  if (!manifest.connectorType?.startsWith('google')) return false;
  try {
    const resp = await fetchConnector(
      manifest,
      `/api/connectors/${manifest.id}/items/${encodeURIComponent(fileId)}?tenantId=${encodeURIComponent(ctx.tenantId)}`,
    );
    if (!resp.ok) return false;
    const item = (await resp.json()) as { mimeType?: string; metadata?: { mimeType?: string } };
    const mime = item.mimeType ?? item.metadata?.mimeType ?? '';
    return mime === 'application/vnd.google-apps.presentation';
  } catch {
    return false;
  }
}

async function readPresentationSlides(
  args: { fileId: string },
  manifest: ConnectorManifest,
  ctx: StandardToolContext,
): Promise<ReadPresentationResult> {
  const tenantId = ctx.tenantId;
  const resp = await fetchConnector(
    manifest,
    `/api/connectors/${manifest.id}/presentations/${encodeURIComponent(args.fileId)}?tenantId=${tenantId}`,
  );
  if (!resp.ok) throw new Error(`Failed to read presentation: ${resp.status}`);
  return resp.json() as Promise<ReadPresentationResult>;
}

// ── generateXlsx ──────────────────────────────────────────────────────────────

export interface GenerateXlsxArgs {
  baseName: string;
  sheets: Array<{
    name: string;
    columns: string[];
    rows: string[][];
    /** Optional column format hints for post-extraction normalisation (parallel to columns array). */
    columnFormats?: string[];
  }>;
  outputPath?: string;
}

function normalizeCell(value: string, format?: string): string {
  if (value == null || value === 'null' || value === 'undefined') return '';
  const trimmed = String(value).trim();
  if (!format) return trimmed;
  switch (format) {
    case 'yes_no': {
      const l = trimmed.toLowerCase();
      if (/^yes\b/.test(l) || l === 'y' || l === 'true') return 'Yes';
      if (/^no\b/.test(l) || l === 'n' || l === 'false') return 'No';
      return trimmed;
    }
    case 'bulleted_list': {
      const lines = trimmed.split('\n').map(l => l.replace(/^[\s\-*•]+/, '').trim()).filter(Boolean);
      return lines.length ? lines.map(l => `• ${l}`).join('\n') : trimmed;
    }
    case 'percentage': {
      const m = trimmed.match(/([\d.]+)\s*%/);
      return m ? `${m[1]}%` : trimmed;
    }
    case 'monetary_amount': {
      const m = trimmed.match(/(USD|EUR|GBP|AUD|CAD|[$€£¥])\s*([\d,]+(?:\.\d{2})?)/i);
      if (m) {
        const sym = m[1].replace('$', 'USD').replace('€', 'EUR').replace('£', 'GBP');
        return `${sym} ${m[2]}`;
      }
      return trimmed;
    }
    default:
      return trimmed;
  }
}

export interface GenerateFileResult {
  generatedFileId?: string;
  filename: string;
  version?: number;
  downloadUrl?: string;
  webViewUrl?: string;
  /** True only when the platform answered that a `file_output` card was
   *  appended for this file. A `generatedFileId` alone is not that: the
   *  registration routes append the card in a catch that logs and continues
   *  and answer 201 regardless. Absent when the platform was not asked or
   *  did not say. */
  cardAppended?: boolean;
  /** One host-authored line the model may repeat: what THIS surface did
   *  with the file. Present only when `cardAppended` is true — never on a
   *  file id alone, never on a failure. */
  hostNote?: string;
}

/** What a registration answered, as the result carries it. */
function cardFields(name: string, cardAppended: boolean): Pick<GenerateFileResult, 'cardAppended' | 'hostNote'> {
  return cardAppended ? { cardAppended, hostNote: fileCardHostNote(name) } : { cardAppended };
}

export async function generateXlsx(
  args: GenerateXlsxArgs,
  manifest: ConnectorManifest,
  ctx: StandardToolContext & { invocationId?: string },
): Promise<GenerateFileResult | typeof CONNECTOR_AUTH_ERROR> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();

  for (const sheet of args.sheets) {
    const ws = workbook.addWorksheet(sheet.name);
    ws.addRow(sheet.columns);
    sheet.rows.forEach(r => {
      const normalizedRow = sheet.columns.map((_, i) =>
        normalizeCell(r[i] ?? '', sheet.columnFormats?.[i]),
      );
      ws.addRow(normalizedRow);
    });
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' },
      bgColor: { argb: 'FFE0E0E0' },
    };
    ws.columns.forEach((col, i) => {
      const maxLen = Math.max(
        sheet.columns[i]?.length ?? 10,
        ...sheet.rows.map(r => (r[i] ?? '').length),
      );
      col.width = Math.min(maxLen + 2, 60);
    });
  }

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const filename = `${args.baseName}.xlsx`;
  const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  return dualWrite({ buffer, filename, baseName: args.baseName, mimeType, outputPath: args.outputPath ?? '', outputType: 'xlsx', manifest, ctx });
}

// ── generateDocx ──────────────────────────────────────────────────────────────

export interface GenerateDocxSection {
  heading?: string;
  level?: number;
  content?: string;
  pageBreak?: boolean;
  table?: {
    headers: string[];
    rows: string[][];
  };
}

export interface GenerateDocxArgs {
  title: string;
  landscape?: boolean;
  sections: GenerateDocxSection[];
  outputPath?: string;
}

export async function generateDocx(
  args: GenerateDocxArgs,
  manifest: ConnectorManifest,
  ctx: StandardToolContext & { invocationId?: string },
): Promise<GenerateFileResult | typeof CONNECTOR_AUTH_ERROR> {
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    HeadingLevel,
    AlignmentType,
    Table,
    TableRow,
    TableCell,
    WidthType,
    BorderStyle,
    PageOrientation,
    PageBreak,
  } = await import('docx');

  const FONT = 'Times New Roman';
  const SIZE = 22; // 11pt in half-points

  const cellBorder = {
    top:    { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' },
    bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' },
    left:   { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' },
    right:  { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' },
  };

  const headingLevels = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4,
  ];
  const counters = [0, 0, 0, 0];

  type DocChild = InstanceType<typeof Paragraph> | InstanceType<typeof Table>;
  const children: DocChild[] = [];

  // Centered uppercase title paragraph
  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      spacing: { after: 200 },
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: args.title.toUpperCase(), color: '000000', font: FONT, size: SIZE, bold: true })],
    }),
  );

  for (const section of args.sections) {
    if (section.pageBreak) {
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }

    if (section.heading) {
      const idx = Math.min((section.level ?? 1) - 1, 3);
      counters[idx]++;
      for (let i = idx + 1; i < 4; i++) counters[i] = 0;
      const prefix = counters.slice(0, idx + 1).join('.');
      // Level 1 headings are uppercase; levels 2+ are as-is.
      const headingText = `${prefix}. ${idx === 0 ? section.heading.toUpperCase() : section.heading}`;
      children.push(
        new Paragraph({
          heading: headingLevels[idx],
          spacing: { after: 160 },
          children: [new TextRun({ text: headingText, color: '000000', font: FONT, size: SIZE, bold: true })],
        }),
      );
    }

    if (section.table) {
      const { headers, rows } = section.table;
      const colCount = headers.length;
      const tableRows: InstanceType<typeof TableRow>[] = [];

      tableRows.push(
        new TableRow({
          tableHeader: true,
          children: headers.map(h =>
            new TableCell({
              borders: cellBorder,
              shading: { fill: 'F2F2F2' },
              children: [
                new Paragraph({
                  alignment: AlignmentType.LEFT,
                  children: [new TextRun({ text: h, bold: true, font: FONT, size: SIZE })],
                }),
              ],
            }),
          ),
        }),
      );

      for (const rawRow of rows) {
        const row = Array.isArray(rawRow) ? rawRow : [];
        const normalized: string[] = [];
        for (let i = 0; i < colCount; i++) {
          normalized.push(typeof row[i] === 'string' ? row[i] : '');
        }
        if (row.length !== colCount) {
          logger.warn({ expected: colCount, actual: row.length }, 'generateDocx: row length mismatch, normalized');
        }
        tableRows.push(
          new TableRow({
            children: normalized.map(cell =>
              new TableCell({
                borders: cellBorder,
                children: [
                  new Paragraph({
                    children: [new TextRun({ text: cell, font: FONT, size: SIZE })],
                  }),
                ],
              }),
            ),
          }),
        );
      }

      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: tableRows,
        }),
      );
      children.push(new Paragraph({ text: '' }));
    }

    if (section.content) {
      for (const line of section.content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const bulletMatch = trimmed.match(/^[-•*]\s+(.+)/);
        if (bulletMatch) {
          children.push(
            new Paragraph({
              bullet: { level: 0 },
              spacing: { after: 120 },
              children: [new TextRun({ text: bulletMatch[1], font: FONT, size: SIZE })],
            }),
          );
        } else {
          children.push(
            new Paragraph({
              spacing: { after: 120 },
              children: [new TextRun({ text: trimmed, font: FONT, size: SIZE })],
            }),
          );
        }
      }
    }
  }

  const doc = new Document({
    sections: [
      {
        properties: args.landscape
          ? { page: { size: { orientation: PageOrientation.LANDSCAPE } } }
          : {},
        children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);

  // Derive baseName from title: strip non-alphanumeric/space/dash, cap at 64 chars.
  const baseName = args.title.replace(/[^a-zA-Z0-9 -]/g, '').trim().slice(0, 64) || 'document';
  const filename = `${baseName}.docx`;
  const mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  return dualWrite({ buffer, filename, baseName, mimeType, outputPath: args.outputPath ?? '', outputType: 'docx', manifest, ctx });
}

// ── generatePptx ──────────────────────────────────────────────────────────────

export interface GeneratePptxSlide {
  title?: string;
  bullets?: string[];
  content?: string;
  table?: { headers: string[]; rows: string[][] };
  notes?: string;
}

export interface GeneratePptxArgs {
  title: string;
  subtitle?: string;
  slides: GeneratePptxSlide[];
  outputPath?: string;
}

export async function generatePptx(
  args: GeneratePptxArgs,
  manifest: ConnectorManifest,
  ctx: StandardToolContext & { invocationId?: string },
): Promise<GenerateFileResult | typeof CONNECTOR_AUTH_ERROR> {
  const pptxgen = (await import('pptxgenjs')).default;
  const prs = new pptxgen();

  const titleSlide = prs.addSlide();
  titleSlide.addText(args.title, { x: 0.5, y: 2.0, w: 12.3, h: 1.2, fontSize: 36, bold: true, align: 'center' });
  if (args.subtitle) {
    titleSlide.addText(args.subtitle, { x: 0.5, y: 3.4, w: 12.3, h: 0.8, fontSize: 20, align: 'center', color: '666666' });
  }

  for (const sl of args.slides) {
    const slide = prs.addSlide();
    if (sl.title) {
      slide.addText(sl.title, { x: 0.5, y: 0.3, w: 12.3, h: 0.8, fontSize: 24, bold: true });
    }
    if (sl.bullets?.length) {
      slide.addText(
        sl.bullets.map(b => ({ text: b, options: { bullet: true, fontSize: 18 } })),
        { x: 0.5, y: 1.3, w: 12.3, h: 5.5 },
      );
    } else if (sl.content) {
      slide.addText(sl.content, { x: 0.5, y: 1.3, w: 12.3, h: 5.5, fontSize: 18 });
    }
    if (sl.table) {
      const tableRows = [
        sl.table.headers.map(h => ({ text: h, options: { bold: true, fill: { color: 'F2F2F2' } } })),
        ...sl.table.rows.map(row => row.map(cell => ({ text: cell }))),
      ];
      slide.addTable(tableRows, {
        x: 0.5, y: 1.3, w: 12.3,
        border: { type: 'solid', color: 'CCCCCC' },
        rowH: 0.4,
      });
    }
    if (sl.notes) {
      slide.addNotes(sl.notes);
    }
  }

  const buffer = Buffer.from(await prs.write({ outputType: 'nodebuffer' }) as ArrayBuffer);
  const baseName = args.title.replace(/[^a-zA-Z0-9\s_-]/g, '').trim() || 'presentation';
  const filename = `${baseName}.pptx`;
  const mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

  return dualWrite({
    buffer,
    filename,
    baseName,
    mimeType,
    outputPath: args.outputPath ?? '',
    outputType: 'pptx',
    manifest,
    ctx,
  });
}

async function pollConnectorJob(
  jobId: string,
  manifest: ConnectorManifest,
  tenantId: string,
  timeoutMs = 120_000,
  intervalMs = 2_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise<void>(r => setTimeout(r, intervalMs));
    const resp = await fetchConnector(
      manifest,
      `/api/connectors/jobs/${jobId}?tenantId=${encodeURIComponent(tenantId)}`,
    );
    if (!resp.ok) throw new Error(`Job poll failed: ${resp.status}`);
    const job = await resp.json() as { status: string; result?: Record<string, unknown>; error?: string };
    if (job.status === 'complete') return job.result!;
    if (job.status === 'failed') {
      if (job.error === 'reconnect_required') return CONNECTOR_AUTH_ERROR as unknown as Record<string, unknown>;
      throw new Error(job.error ?? 'Connector job failed');
    }
    // pending / running — continue polling
  }
  throw new Error(`Connector job timed out after ${timeoutMs}ms`);
}

export async function generatePresentationSlides(
  args: GeneratePptxArgs & { templateFileId?: string },
  manifest: ConnectorManifest,
  ctx: StandardToolContext & { invocationId?: string },
): Promise<GenerateFileResult | typeof CONNECTOR_AUTH_ERROR> {
  const tenantId = ctx.tenantId;
  const baseName = args.title.replace(/[^a-zA-Z0-9\s_-]/g, '').trim() || 'presentation';

  const resp = await fetchConnector(
    manifest,
    `/api/connectors/${manifest.id}/presentations/create-from-template?tenantId=${tenantId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        templateFileId: args.templateFileId,
        name: baseName,
        title: args.title,
        subtitle: args.subtitle,
        slides: args.slides,
        // The folder the person asked for. The tool's schema promises Drive
        // takes a folder id here; the native route dropped it and every deck
        // landed in My Drive root. Named parentFolderId on the wire, because
        // that is what it is on Drive — a PATH means nothing to the Slides API.
        parentFolderId: args.outputPath,
      }),
    },
  );

  if (resp.status === 401) return CONNECTOR_AUTH_ERROR;
  if (resp.status === 202) {
    const { jobId } = await resp.json() as { jobId: string };
    const result = await pollConnectorJob(jobId, manifest, tenantId);
    if ((result as unknown) === CONNECTOR_AUTH_ERROR) return CONNECTOR_AUTH_ERROR;
    const data = result as { presentationId: string; name: string; webViewUrl: string };
    return registerConnectorNative({
      baseName,
      outputType: 'gslides',
      connectorId: manifest.id,
      connectorFileId: data.presentationId,
      webViewUrl: data.webViewUrl,
      ctx,
    });
  }
  if (!resp.ok) throw new Error(`Failed to create presentation from template: ${resp.status}`);

  // 201 sync path (backward compat during rollout)
  const data = await resp.json() as { presentationId: string; name: string; webViewUrl: string };

  return registerConnectorNative({
    baseName,
    outputType: 'gslides',
    connectorId: manifest.id,
    connectorFileId: data.presentationId,
    webViewUrl: data.webViewUrl,
    ctx,
  });
}

// ── generateGoogleDoc ──────────────────────────────────────────────────────────

export interface GenerateGoogleDocSection {
  heading?: string;
  level?: number;
  content?: string;
  pageBreak?: boolean;
  table?: { headers: string[]; rows: string[][] };
}

export interface GenerateGoogleDocArgs {
  title: string;
  sections: GenerateGoogleDocSection[];
  outputPath?: string;
}

export async function generateGoogleDoc(
  args: GenerateGoogleDocArgs,
  manifest: ConnectorManifest,
  ctx: StandardToolContext & { invocationId?: string },
): Promise<GenerateFileResult | typeof CONNECTOR_AUTH_ERROR> {
  const tenantId = ctx.tenantId;
  const baseName = args.title.replace(/[^a-zA-Z0-9\s_-]/g, '').trim() || 'document';

  const resp = await fetchConnector(
    manifest,
    `/api/connectors/${manifest.id}/documents/create?tenantId=${tenantId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: args.title, sections: args.sections, parentFolderId: args.outputPath }),
    },
  );

  if (resp.status === 401) return CONNECTOR_AUTH_ERROR;
  if (resp.status === 202) {
    const { jobId } = await resp.json() as { jobId: string };
    const result = await pollConnectorJob(jobId, manifest, tenantId);
    if ((result as unknown) === CONNECTOR_AUTH_ERROR) return CONNECTOR_AUTH_ERROR;
    const data = result as { documentId: string; name: string; webViewUrl: string };
    // A native Google Doc is `gdoc`, never `docx`: the platform names the
    // card `${baseName}_v${n}.${ext}` and gives a Google-native type no
    // extension, so `docx` would card this as `Report_v1.docx` beside a URL
    // that opens a Google Doc, with a Download button over bytes that do
    // not exist.
    return registerConnectorNative({
      baseName,
      outputType: 'gdoc',
      connectorId: manifest.id,
      connectorFileId: data.documentId,
      webViewUrl: data.webViewUrl,
      ctx,
    });
  }
  if (!resp.ok) throw new Error(`Failed to create Google Doc: ${resp.status}`);

  // Sync path (should not occur — route always returns 202)
  const data = await resp.json() as { documentId: string; name: string; webViewUrl: string };
  return registerConnectorNative({
    baseName,
    outputType: 'gdoc',
    connectorId: manifest.id,
    connectorFileId: data.documentId,
    webViewUrl: data.webViewUrl,
    ctx,
  });
}

// ── editDocument ──────────────────────────────────────────────────────────────

export interface EditDocumentArgs {
  doc_id: string;
  edits: Array<{
    find: string;
    replace: string;
    context_before: string;
    context_after: string;
    reason?: string;
  }>;
  outputPath?: string;
}

export async function editDocument(
  args: EditDocumentArgs,
  manifest: ConnectorManifest,
  ctx: StandardToolContext & { invocationId?: string },
): Promise<GenerateFileResult | typeof CONNECTOR_AUTH_ERROR> {
  const path = `/api/connectors/${manifest.id}/files/${encodeURIComponent(args.doc_id)}/content?tenantId=${encodeURIComponent(ctx.tenantId)}`;

  try {
    const resp = await fetchConnector(manifest, path, { method: 'GET' });
    if (resp.status === 401 || resp.status === 403) {
      return CONNECTOR_AUTH_ERROR;
    }
    // 415 is connector-service saying it cannot hand over bytes: the connector
    // is composio_managed, Composio signs requests server-side and never
    // releases the token, so nothing can download the .docx to redline. Edit a
    // copy natively instead of failing. Different result — a Drive document
    // rather than a redlined file — and the tool says so.
    if (resp.status === 415) {
      return editDocumentNative(args, manifest, ctx);
    }
    if (!resp.ok) {
      logger.warn({ status: resp.status, connectorId: manifest.id, doc_id: args.doc_id }, 'editDocument fetch error');
      return connectorRestError(resp.status);
    }

    // Derive baseName from the Content-Disposition filename.
    const disposition = resp.headers.get('content-disposition') ?? '';
    const nameMatch = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
    const sourceFilename = nameMatch?.[1] ?? args.doc_id;
    const baseName = sourceFilename.replace(/\.docx$/i, '').replace(/[^a-zA-Z0-9 -]/g, '').trim().slice(0, 64) || 'document';

    const arrayBuffer = await resp.arrayBuffer();
    const sourceBuffer = Buffer.from(arrayBuffer);

    const modifiedBuffer = await applyTrackedChanges(sourceBuffer, args.edits);
    const filename = `${baseName}_redlined.docx`;
    const mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    return dualWrite({
      buffer: modifiedBuffer,
      filename,
      baseName,
      mimeType,
      outputPath: args.outputPath ?? '',
      outputType: 'docx_redlined',
      manifest,
      ctx,
    });
  } catch (err) {
    logger.error({ err, connectorId: manifest.id, doc_id: args.doc_id }, 'editDocument failed');
    return connectorRestError();
  }
}

// ── editPresentation ──────────────────────────────────────────────────────────

export interface EditPresentationArgs {
  fileId: string;
  name?: string;
  replacements: Array<{ find: string; replace: string }>;
  outputPath?: string;
}

export async function editPresentation(
  args: EditPresentationArgs,
  manifest: ConnectorManifest,
  ctx: StandardToolContext & { invocationId?: string },
): Promise<GenerateFileResult | typeof CONNECTOR_AUTH_ERROR> {
  if (manifest.connectorType === 'google_slides') {
    return editPresentationSlides(args, manifest, ctx);
  }

  const path = `/api/connectors/${manifest.id}/files/${encodeURIComponent(args.fileId)}/content?tenantId=${encodeURIComponent(ctx.tenantId)}`;

  try {
    const resp = await fetchConnector(manifest, path, { method: 'GET' });
    if (resp.status === 401 || resp.status === 403) {
      return CONNECTOR_AUTH_ERROR;
    }
    if (!resp.ok) {
      logger.warn({ status: resp.status, connectorId: manifest.id, fileId: args.fileId }, 'editPresentation fetch error');
      return connectorRestError(resp.status);
    }

    const disposition = resp.headers.get('content-disposition') ?? '';
    const nameMatch = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
    const filename = nameMatch?.[1] ?? args.fileId;

    const arrayBuffer = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const edited = await applyPptxReplacements(buffer, args.replacements);

    const baseName = (args.name ?? filename).replace(/\.pptx$/i, '');
    const outFilename = `${baseName}_v2.pptx`;
    const mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

    return dualWrite({
      buffer: edited,
      filename: outFilename,
      baseName,
      mimeType,
      outputPath: args.outputPath ?? '',
      outputType: 'pptx',
      manifest,
      ctx,
    });
  } catch (err) {
    logger.error({ err, connectorId: manifest.id, fileId: args.fileId }, 'editPresentation failed');
    return connectorRestError();
  }
}

/**
 * Edit a Google Doc by copying it and applying the edits to the copy.
 *
 * Used when connector-service refuses to hand over the .docx (415), which
 * happens on composio_managed connectors: Composio holds the OAuth grant and
 * never releases the token, so there are no bytes to download and redline.
 *
 * Two honest differences from the redline path, both surfaced rather than
 * hidden. The Docs API cannot create tracked changes, so edits are applied
 * outright — the original is untouched because we edit a copy. And
 * replaceAllText matches every occurrence of the search text, so the
 * context_before / context_after that disambiguate one instance in OOXML have
 * no equivalent; the service returns per-edit occurrence counts, and an edit
 * that matched nothing is reported instead of passing as applied.
 */
async function editDocumentNative(
  args: EditDocumentArgs,
  manifest: ConnectorManifest,
  ctx: StandardToolContext & { invocationId?: string },
): Promise<GenerateFileResult | typeof CONNECTOR_AUTH_ERROR> {
  const tenantId = ctx.tenantId;
  const baseName = `document_edited`;

  const resp = await fetchConnector(
    manifest,
    `/api/connectors/${manifest.id}/documents/${encodeURIComponent(args.doc_id)}/copy-and-edit?tenantId=${encodeURIComponent(tenantId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: baseName,
        edits: args.edits.map((e) => ({ find: e.find, replace: e.replace })),
      }),
    },
  );
  if (resp.status === 401 || resp.status === 403) return CONNECTOR_AUTH_ERROR;
  if (resp.status !== 202) {
    logger.warn(
      { status: resp.status, connectorId: manifest.id, doc_id: args.doc_id },
      'editDocument native copy-and-edit failed',
    );
    return connectorRestError(resp.status);
  }

  const { jobId } = (await resp.json()) as { jobId: string };
  const result = await pollConnectorJob(jobId, manifest, tenantId);
  if ((result as unknown) === CONNECTOR_AUTH_ERROR) return CONNECTOR_AUTH_ERROR;

  const data = result as {
    documentId: string;
    name: string;
    webViewUrl: string;
    unmatched?: string[];
  };

  if (data.unmatched?.length) {
    logger.warn(
      { connectorId: manifest.id, doc_id: args.doc_id, unmatched: data.unmatched },
      'editDocument native: some edits matched no text in the document',
    );
  }

  return registerConnectorNative({
    baseName: data.name || baseName,
    outputType: 'gdoc',
    connectorId: manifest.id,
    connectorFileId: data.documentId,
    webViewUrl: data.webViewUrl,
    ctx,
  });
}

async function editPresentationSlides(
  args: EditPresentationArgs,
  manifest: ConnectorManifest,
  ctx: StandardToolContext & { invocationId?: string },
): Promise<GenerateFileResult | typeof CONNECTOR_AUTH_ERROR> {
  const tenantId = ctx.tenantId;
  const baseName = args.name ?? `presentation_v2`;

  const resp = await fetchConnector(
    manifest,
    `/api/connectors/${manifest.id}/presentations/${encodeURIComponent(args.fileId)}/copy-and-replace?tenantId=${tenantId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: baseName, replacements: args.replacements }),
    },
  );
  if (resp.status === 401) return CONNECTOR_AUTH_ERROR;
  if (resp.status === 202) {
    const { jobId } = await resp.json() as { jobId: string };
    const result = await pollConnectorJob(jobId, manifest, tenantId);
    if ((result as unknown) === CONNECTOR_AUTH_ERROR) return CONNECTOR_AUTH_ERROR;
    const data = result as { presentationId: string; name: string; webViewUrl: string };
    return registerConnectorNative({
      baseName,
      outputType: 'gslides',
      connectorId: manifest.id,
      connectorFileId: data.presentationId,
      webViewUrl: data.webViewUrl,
      ctx: ctx as StandardToolContext & { invocationId?: string },
    });
  }
  if (!resp.ok) throw new Error(`Failed to edit presentation: ${resp.status}`);

  // 201 sync path (backward compat during rollout)
  const data = await resp.json() as { presentationId: string; name: string; webViewUrl: string };

  return registerConnectorNative({
    baseName,
    outputType: 'gslides',
    connectorId: manifest.id,
    connectorFileId: data.presentationId,
    webViewUrl: data.webViewUrl,
    ctx: ctx as StandardToolContext & { invocationId?: string },
  });
}

async function applyPptxReplacements(
  buffer: Buffer,
  replacements: Array<{ find: string; replace: string }>,
): Promise<Buffer> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);

  const slideFiles = Object.keys(zip.files).filter(
    name => /^ppt\/slides\/slide\d+\.xml$/.test(name),
  );

  for (const slideFile of slideFiles) {
    let xml = await zip.files[slideFile].async('string');
    for (const { find, replace } of replacements) {
      xml = applyPptxTextReplacement(xml, find, replace);
    }
    zip.file(slideFile, xml);
  }

  return zip.generateAsync({ type: 'nodebuffer' });
}

function applyPptxTextReplacement(xml: string, find: string, replace: string): string {
  return xml.replace(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/g, (para) => {
    const runs = [...para.matchAll(/<a:r\b[^>]*>[\s\S]*?<\/a:r>/g)];
    if (!runs.length) return para;
    const joined = runs.map(r => r[0].match(/<a:t[^>]*>([\s\S]*?)<\/a:t>/)?.[1] ?? '').join('').replace(/\s+/g, ' ');
    const findNorm = find.replace(/\s+/g, ' ');
    if (!joined.includes(findNorm)) return para;
    const rPr = runs[0][0].match(/<a:rPr[\s\S]*?<\/a:rPr>/)?.[0] ?? '';
    const newText = joined.split(findNorm).join(escapeXml(replace));
    const firstRunStart = para.indexOf(runs[0][0]);
    const lastRunEnd = para.lastIndexOf(runs[runs.length - 1][0]) + runs[runs.length - 1][0].length;
    const before = para.slice(0, firstRunStart);
    const after = para.slice(lastRunEnd);
    return before + `<a:r>${rPr}<a:t xml:space="preserve">${newText}</a:t></a:r>` + after;
  });
}

// ── registerConnectorNative ────────────────────────────────────────────────────

/**
 * Register a file the team created IN the connector — a deck or doc written
 * into the user's Drive — so it becomes a `file_output` card on the thread.
 * The funnel every connector-native site shares.
 *
 * The write that created the file already succeeded, and nothing here may
 * fail it: every refusal falls back to `{ filename, webViewUrl }`, the link
 * the person got before cards existed. What the fallback must NOT do is
 * pass as a card — `cardAppended` is set only from the platform's own
 * answer, and the host note only on `cardAppended: true`.
 */
async function registerConnectorNative(opts: {
  baseName: string;
  outputType: string;
  connectorId: string;
  connectorFileId: string;
  webViewUrl: string;
  ctx: StandardToolContext & { invocationId?: string };
}): Promise<GenerateFileResult> {
  const ext = opts.outputType === 'xlsx' ? 'xlsx'
    : opts.outputType === 'pptx' ? 'pptx'
    : opts.outputType === 'gslides' || opts.outputType === 'gdoc' ? '' // Google-native files have no extension
    : 'docx';
  const fallbackFilename = ext ? `${opts.baseName}.${ext}` : opts.baseName;
  const fallback: GenerateFileResult = { filename: fallbackFilename, webViewUrl: opts.webViewUrl };

  const pbUrl = getPlatformBackendUrl();
  if (!pbUrl) return fallback;

  // Two agent id spaces (ADR-039): `ctx.agentId` is the RUNTIME id, and
  // `generated_files.agent_id` is a foreign key to platform-backend's
  // `internal_agents.id`. Translated here, at the one boundary that crosses
  // into the other database. No mapping means no registration: the runtime
  // id matches zero rows there, and a wrong-space id is never sent.
  const internalAgentId = await resolveInternalAgentId(opts.ctx.tenantId, opts.ctx.agentId, 'document-tools');
  if (!internalAgentId) return fallback;

  try {
    const resp = await fetch(`${pbUrl}/api/generated-files/register-connector-native`, {
      method: 'POST',
      headers: { ...pbAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: internalAgentId,
        tenantId: opts.ctx.tenantId,
        baseName: opts.baseName,
        outputType: opts.outputType,
        conversationId: opts.ctx.threadId,
        connectorId: opts.connectorId,
        connectorFileId: opts.connectorFileId,
        webViewUrl: opts.webViewUrl,
        // The turn this call runs in, stamped on the card so the turn's reply
        // can be checked against the cards the turn actually produced.
        ...(opts.ctx.turnId ? { turnId: opts.ctx.turnId } : {}),
      }),
    });
    if (resp.ok) {
      const data = await resp.json() as { id?: string; cardAppended?: boolean };
      return {
        generatedFileId: data.id,
        filename: fallbackFilename,
        webViewUrl: opts.webViewUrl,
        ...cardFields(fallbackFilename, data.cardAppended === true),
      };
    }
    // At error, with what the platform said: the fallback below turns this
    // into a link and no card, which nobody is looking for, and the next
    // break in this door has to show in the error stream rather than as a
    // missing card.
    const body = await resp.text().catch(() => '');
    logger.error(
      {
        event: 'connector_native_registration_failed',
        status: resp.status,
        body: body.slice(0, 2000),
        tenantId: opts.ctx.tenantId,
        threadId: opts.ctx.threadId,
        outputType: opts.outputType,
        connectorId: opts.connectorId,
      },
      'registerConnectorNative: the platform refused the registration; the file keeps its link and gets no card',
    );
  } catch (err) {
    logger.warn({ err }, 'registerConnectorNative: failed');
  }
  return fallback;
}

// ── applyTrackedChanges ────────────────────────────────────────────────────────

interface Edit {
  find: string;
  replace: string;
  context_before: string;
  context_after: string;
  reason?: string;
}

async function applyTrackedChanges(buffer: Buffer, edits: Edit[]): Promise<Buffer> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);
  const docXmlFile = zip.file('word/document.xml');
  if (!docXmlFile) return buffer;

  let xml = await docXmlFile.async('string');
  let editId = 100;
  // Full ISO 8601 timestamp with Z suffix — required by OOXML spec for w:date.
  const now = new Date().toISOString();

  for (const edit of edits) {
    const normalise = (s: string) =>
      s.replace(/\s+/g, ' ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
    const findNorm = normalise(edit.find);
    const escapedFind = findNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const runRe = new RegExp(
      `(<w:r(?:\\b[^>]*)?>(?:<w:rPr>[\\s\\S]*?<\\/w:rPr>)?)` +
      `(<w:t(?:[^>]*)?>)` +
      `((?:[\\s\\S]*?))` +
      escapedFind +
      `((?:[\\s\\S]*?))` +
      `(<\\/w:t>)` +
      `(<\\/w:r>)`,
      'g',
    );

    let matched = false;
    xml = xml.replace(runRe, (_, rOpenWithRpr, tOpen, before, after, tClose, rClose) => {
      matched = true;
      const rPrMatch = rOpenWithRpr.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
      const rPr = rPrMatch ? rPrMatch[0] : '';

      const del =
        `<w:del w:id="${editId}" w:author="Liftoff" w:date="${now}">` +
        `<w:r>${rPr}<w:delText xml:space="preserve">${escapeXml(findNorm)}</w:delText></w:r>` +
        `</w:del>`;
      const ins =
        `<w:ins w:id="${editId + 1}" w:author="Liftoff" w:date="${now}">` +
        `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(edit.replace)}</w:t></w:r>` +
        `</w:ins>`;
      editId += 2;

      let result = '';
      if (before) result += `${rOpenWithRpr}${tOpen}${before}${tClose}${rClose}`;
      result += del + ins;
      if (after) result += `${rOpenWithRpr}${tOpen}${after}${tClose}${rClose}`;
      return result;
    });

    if (!matched) {
      logger.warn({ find: edit.find }, 'editDocument: no run found containing text, edit skipped');
    }
  }

  zip.file('word/document.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function extractPptxFlatText(buffer: Buffer): Promise<{ text: string; slideCount: number }> {
  const JSZip = (await import('jszip')).default;
  const { XMLParser } = await import('fast-xml-parser');
  const zip = await JSZip.loadAsync(buffer);

  const slideFiles = Object.keys(zip.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = parseInt(a.match(/\d+/)?.[0] ?? '0');
      const nb = parseInt(b.match(/\d+/)?.[0] ?? '0');
      return na - nb;
    });

  const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, textNodeName: '_text' });

  function collectTextNodes(obj: unknown): string[] {
    if (Array.isArray(obj)) return obj.flatMap(collectTextNodes);
    if (obj && typeof obj === 'object') {
      const results: string[] = [];
      for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
        if (key === 't') {
          const texts = Array.isArray(val) ? val : [val];
          for (const t of texts) {
            if (typeof t === 'string') {
              results.push(t);
            } else if (t && typeof t === 'object' && '_text' in (t as Record<string, unknown>)) {
              const inner = (t as Record<string, unknown>)['_text'];
              if (typeof inner === 'string') results.push(inner);
            }
          }
        } else {
          results.push(...collectTextNodes(val));
        }
      }
      return results;
    }
    return [];
  }

  const parts: string[] = [];
  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await zip.files[slideFiles[i]].async('string');
    const parsed = parser.parse(xml);
    const texts = collectTextNodes(parsed).filter(t => t.trim());
    parts.push(`--- SLIDE ${i + 1} ---\n${texts.join('\n')}`);
  }

  return { text: parts.join('\n\n'), slideCount: slideFiles.length };
}

// ── dualWrite: POST to PB generated-files + connector upload ─────────────────

interface DualWriteOptions {
  buffer: Buffer;
  filename: string;
  baseName: string;
  mimeType: string;
  outputPath: string;
  outputType: 'xlsx' | 'docx' | 'docx_redlined' | 'pptx';
  manifest: ConnectorManifest;
  ctx: StandardToolContext & { invocationId?: string };
}

async function dualWrite(opts: DualWriteOptions): Promise<GenerateFileResult | typeof CONNECTOR_AUTH_ERROR> {
  const { buffer, filename, baseName, mimeType, outputPath, outputType, manifest, ctx } = opts;
  const pbUrl = getPlatformBackendUrl();
  const csUrl = getConnectorServiceUrl();
  let generatedFileId: string | undefined;
  let downloadUrl: string | undefined;
  let version: number | undefined;
  let cardAppended: boolean | undefined;

  // Step 1: Register with Platform Backend.
  //
  // Two agent id spaces (ADR-039): `ctx.agentId` is the RUNTIME id, and
  // `generated_files.agent_id` is a foreign key to platform-backend's
  // `internal_agents.id` — the same boundary registerConnectorNative crosses.
  // Translated here; no mapping means no registration, and the connector
  // upload below still goes ahead, because the file the person asked for is
  // not conditional on the platform's bookkeeping for it.
  const internalAgentId = pbUrl
    ? await resolveInternalAgentId(ctx.tenantId, ctx.agentId, 'document-tools')
    : null;
  if (pbUrl && internalAgentId) {
    try {
      const formData = new FormData();
      formData.append('agentId', internalAgentId);
      formData.append('tenantId', ctx.tenantId);
      formData.append('baseName', baseName);
      formData.append('outputType', outputType);
      if (ctx.threadId) formData.append('conversationId', ctx.threadId);
      // Same field as the connector-native registration, same reason.
      if (ctx.turnId) formData.append('turnId', ctx.turnId);
      formData.append('file', new Blob([buffer], { type: mimeType }), filename);

      const pbResp = await fetch(`${pbUrl}/api/generated-files`, {
        method: 'POST',
        headers: pbAuthHeaders(),
        body: formData as unknown as RequestInit['body'],
      });

      if (pbResp.ok) {
        const pbData = (await pbResp.json()) as { id?: string; downloadUrl?: string; version?: number; cardAppended?: boolean };
        generatedFileId = pbData.id;
        downloadUrl = pbData.downloadUrl;
        version = pbData.version;
        cardAppended = pbData.cardAppended === true;
      } else {
        // At error, with what the platform said, for the same reason as the
        // connector-native door: the fallback is a file with no card, which
        // nobody is looking for.
        const body = await pbResp.text().catch(() => '');
        logger.error(
          {
            event: 'generated_file_registration_failed',
            status: pbResp.status,
            body: body.slice(0, 2000),
            tenantId: ctx.tenantId,
            threadId: ctx.threadId,
            outputType,
          },
          'dualWrite: the platform refused the upload; the file still goes to the connector and gets no card',
        );
      }
    } catch (err) {
      logger.warn({ err, outputType }, 'dualWrite: PB generated-files POST threw');
    }
  }

  // Step 2: Upload to cloud storage connector
  let connectorFileId: string | undefined;
  let connectorPath: string | undefined;
  let webViewUrl: string | undefined;

  if (csUrl) {
    try {
      const uploadForm = new FormData();
      uploadForm.append('file', new Blob([buffer], { type: mimeType }), filename);
      uploadForm.append('tenantId', ctx.tenantId);
      uploadForm.append('destinationPath', outputPath);
      uploadForm.append('filename', filename);
      uploadForm.append('mimeType', mimeType);

      const uploadResp = await fetchConnector(
        manifest,
        `/api/connectors/${manifest.id}/files`,
        {
          method: 'POST',
          body: uploadForm as unknown as RequestInit['body'],
        },
      );

      if (uploadResp.ok) {
        const uploadData = (await uploadResp.json()) as {
          fileId?: string;
          path?: string;
          webViewUrl?: string;
        };
        connectorFileId = uploadData.fileId;
        connectorPath = uploadData.path;
        webViewUrl = uploadData.webViewUrl;

        // Step 3: PATCH generated-file with connector back-reference
        if (generatedFileId && pbUrl) {
          fetch(`${pbUrl}/api/generated-files/${generatedFileId}`, {
            method: 'PATCH',
            headers: { ...pbAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
              connectorId: manifest.id,
              connectorFileId,
              connectorPath,
              webViewUrl,
            }),
          }).catch(err => logger.warn({ err }, 'dualWrite: PB PATCH failed (non-fatal)'));
        }
      } else {
        logger.warn({ status: uploadResp.status, connectorId: manifest.id, outputType }, 'dualWrite: connector upload failed');
      }
    } catch (err) {
      logger.warn({ err, connectorId: manifest.id, outputType }, 'dualWrite: connector upload threw');
    }
  }

  return {
    generatedFileId,
    filename,
    version,
    downloadUrl,
    webViewUrl,
    ...(cardAppended === undefined ? {} : cardFields(filename, cardAppended)),
  };
}
