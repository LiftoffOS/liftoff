// Connector CRUD HTTP router.
//
// Ported from platform-backend/src/connectors/router.ts. Adapts:
//   - `log` → `logger` (infra/logging.ts). Platform-backend's logAudit
//     helper is inlined as logger.info with an `audit: true` attribute so
//     the same records land in structured logs.
//   - `pool.query` → withTenantScope (app.tenant_id) via crud/service.ts.
//   - `req.user.uid` → `x-account-id` header — the web tier
//     (platform-backend) validates Firebase and passes the canonical
//     account id on every X-Service-Auth call (Fix 4 convention).
//   - `GET /available` uses the local catalog
//     (listConnectorCapabilities + getFunctionalConnectorTypes) instead
//     of an RPC round-trip.
//   - Disconnect publishes `connector.deleted` on the shared
//     control-plane-events topic via events/publisher.ts. Credential
//     revocation calls credentialService.revokeCredentials +
//     deleteConnectorCredential to scrub Postgres + Secret Manager.
//
// Mount path: /api/connectors (see server.ts, mounted AFTER oauth/apikey/
// keypair so those more-specific prefixes win on route matching).

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { logger } from '../infra/logging.js';
import { connectorCrudService } from './service.js';
import { clearCustomApiVerification } from '../custom-api/repository.js';
import { enqueueImmediate, enqueueBackfill } from '../polling/scheduler.js';
import {
  CONNECTOR_DISPLAY_NAMES,
  getConnectorScopes,
  getOAuthProvider,
  type ConnectorType,
} from '../types.js';
import {
  getFunctionalConnectorTypes,
  listConnectorCapabilities,
} from '../catalog/capabilities.js';
import { publishEvent } from '../events/publisher.js';
import { publishAuditEvent } from '../events/audit-publisher.js';
import { credentialService, isReconnectRequiredOAuthError, OAuthRefreshError } from '../credentials/service.js';
import { markConnectorReconnectRequired } from '../oauth/connector-ops.js';
import {
  composioProxyRequest,
  composioProxyBinaryDownload,
  composioProxyBinaryUpload,
} from '../oauth/composio-client.js';
import { makeGoogleFetcher, makeGoogleApiFetcher } from '../credentials/google-fetcher.js';
import { handleRouteError } from '../infra/route-error.js';
import { createJob } from '../jobs/service.js';
import { deleteConnectorCredential, getConnectorCredential } from '../secrets/client.js';
import { GoogleDriveClient } from '../clients/google-drive.js';
import { GoogleSlidesClient } from '../clients/google-slides.js';
import { GoogleDocsClient } from '../clients/google-docs.js';
import { GoogleSheetsClient } from '../clients/google-sheets.js';
import { getClientFactory } from '../clients/adapter.js';
import { ComposioGenericPollClient } from '../clients/composio-generic-poll-client.js';
import { listViaComposioTool } from '../clients/composio-entity-list.js';
import { CONNECTORS } from '../catalog/connectors.js';
import { getPollSpec } from '../polling/composio-poll-spec.js';
import type { CompensationClient } from '../clients/types.js';
import { GoogleMailClient } from '../clients/google-mail.js';
import { MicrosoftOneDriveClient } from '../clients/microsoft-onedrive.js';
import { DropboxClient } from '../clients/dropbox.js';
import { BoxClient } from '../clients/box.js';
import { ZendeskClient } from '../clients/zendesk.js';
import { IntercomComposioClient } from '../clients/intercom-composio.js';
import { ConfluenceClient } from '../clients/confluence.js';
import { NotionMCPClient } from '../clients/notion-mcp.js';
import { MicrosoftOneNoteClient } from '../clients/microsoft-onenote.js';
import { MicrosoftSharePointClient } from '../clients/microsoft-sharepoint.js';
import { PerConnectorIdCredentialStore } from '../mcp/credential-store.js';
import { tryComposioProxy } from '../clients/composio-transport.js';
import type { ConnectorCredentials as ClientCredentials } from '../clients/types.js';

export const connectorCrudRouter = Router();

function getTenantId(req: Request): string | null {
  const q = req.query.tenantId;
  if (typeof q === 'string' && q.length > 0) return q;
  const body = req.body as { tenantId?: unknown } | undefined;
  if (body && typeof body.tenantId === 'string' && body.tenantId.length > 0) {
    return body.tenantId;
  }
  return null;
}

function getAccountId(req: Request): string | null {
  const h = req.header('x-account-id');
  if (typeof h === 'string' && h.length > 0) return h;
  return null;
}

function logAudit(
  event: string,
  accountId: string | null,
  payload: Record<string, unknown>,
): void {
  // Keep stdout for ops dashboards.
  logger.info({ audit: true, event, accountId, ...payload }, event);

  // Workspace-visible audit: human-initiated + tenant-scoped only. The
  // publish runs detached so the call site stays synchronous — existing
  // callers at crud/router.ts:165/231/1467/1524 don't await this. Errors
  // are logged and swallowed; the OAuth callback / API user already got
  // their success response.
  if (!accountId) return;
  const tenantId = typeof payload.tenantId === 'string' ? payload.tenantId : null;
  if (!tenantId) return;
  const resourceId =
    (typeof payload.connectorId === 'string' && payload.connectorId) || tenantId;

  // Pick only the safe, intended fields — never `...payload`, which could
  // leak transient flags or future-added sensitive fields.
  const newState: Record<string, unknown> = {};
  if (payload.connectorId !== undefined) newState.connectorId = payload.connectorId;
  if (payload.connectorType !== undefined) newState.connectorType = payload.connectorType;
  if ((payload as { externalAccountId?: unknown }).externalAccountId !== undefined) {
    newState.externalAccountId = (payload as { externalAccountId: unknown }).externalAccountId;
  }
  if ((payload as { externalAccountLabel?: unknown }).externalAccountLabel !== undefined) {
    newState.externalAccountLabel = (payload as { externalAccountLabel: unknown }).externalAccountLabel;
  }
  if ((payload as { needsReconnect?: unknown }).needsReconnect !== undefined) {
    newState.needsReconnect = (payload as { needsReconnect: unknown }).needsReconnect;
  }
  if ((payload as { previousStatus?: unknown }).previousStatus !== undefined) {
    newState.previousStatus = (payload as { previousStatus: unknown }).previousStatus;
  }
  if ((payload as { newStatus?: unknown }).newStatus !== undefined) {
    newState.newStatus = (payload as { newStatus: unknown }).newStatus;
  }

  publishAuditEvent({
    tenantId,
    userId: accountId,
    eventType: event,
    resourceId,
    newState,
  }).catch((err: unknown) => {
    logger.warn({ err, event }, 'audit publish failed');
  });
}

function isValidConnectorType(type: string): type is ConnectorType {
  return type in CONNECTOR_DISPLAY_NAMES;
}

function providerLabel(type: ConnectorType): string {
  const oauthProvider = getOAuthProvider(type);
  if (oauthProvider) {
    // Capitalise e.g. 'google' → 'Google'.
    return oauthProvider.charAt(0).toUpperCase() + oauthProvider.slice(1);
  }
  if (type === 'salesforce') return 'Salesforce';
  if (type === 'snowflake') return 'Snowflake';
  if (type === 'databricks') return 'Databricks';
  return 'Unknown';
}


// ──────────────────────────────────────────────────────────────────────
// GET /available — full catalog + metadata
// ──────────────────────────────────────────────────────────────────────

connectorCrudRouter.get('/available', (_req: Request, res: Response) => {
  try {
    const functional = new Set(getFunctionalConnectorTypes());
    const capabilities = listConnectorCapabilities();
    const capByType = new Map(capabilities.map((c) => [c.connectorType, c]));

    const available = Object.entries(CONNECTOR_DISPLAY_NAMES).map(
      ([type, name]) => {
        const ct = type as ConnectorType;
        const cap = capByType.get(ct);
        return {
          type,
          name,
          provider: providerLabel(ct),
          scopes: getConnectorScopes(ct),
          supportsOAuth: getOAuthProvider(ct) !== null,
          hasMcpConfig: cap?.hasMcpConfig ?? false,
          isVendorHostedMcp: cap?.isVendorHostedMcp ?? false,
          functional: functional.has(type),
        };
      },
    );

    res.json({ connectors: available });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ──────────────────────────────────────────────────────────────────────
// GET / — list
// ──────────────────────────────────────────────────────────────────────

connectorCrudRouter.get('/', async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }
    const connectors = await connectorCrudService.listByTenant(tenantId);
    res.json({ connectors });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST / — create a new connector row (non-OAuth path)
// ──────────────────────────────────────────────────────────────────────

connectorCrudRouter.post('/', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as {
      tenantId?: unknown;
      type?: unknown;
      name?: unknown;
      config?: unknown;
      status?: unknown;
    };
    const tenantId = typeof body.tenantId === 'string' ? body.tenantId : null;
    const type = typeof body.type === 'string' ? body.type : null;
    const name = typeof body.name === 'string' ? body.name : undefined;
    const config =
      body.config && typeof body.config === 'object'
        ? (body.config as Record<string, unknown>)
        : undefined;
    // status is optional; defaults to 'pending'. Non-OAuth callers must
    // pass 'active' since there is no callback to flip the status later.
    let status: 'pending' | 'active' | undefined;
    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || (body.status !== 'pending' && body.status !== 'active')) {
        return res
          .status(400)
          .json({ error: 'Invalid initial status; allowed: pending, active' });
      }
      status = body.status;
    }

    if (!tenantId || !type) {
      return res
        .status(400)
        .json({ error: 'tenantId and type are required' });
    }
    if (!isValidConnectorType(type)) {
      return res.status(400).json({ error: 'Invalid connector type' });
    }

    const connector = await connectorCrudService.create({
      tenantId,
      type,
      name: name ?? connectorCrudService.getDisplayName(type),
      config,
      ...(status ? { status } : {}),
    });

    logAudit('connector.created', getAccountId(req), {
      connectorId: connector.id,
      connectorType: type,
      tenantId,
    });

    res.status(201).json(connector);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /_resolve — bulk id → type lookup (service-to-service)
//
// Used by platform-backend's integration-enrichment resolver to translate
// stored connector UUIDs into canonical connector types at agent event
// publish time. Includes disconnected rows so historical ids still resolve
// — the tenant runtime then maps the type to the CURRENT live connector
// after a reconnect.
//
// Registered before /:connectorId/* so the literal `_resolve` segment is
// not interpreted as a connector id.
// ──────────────────────────────────────────────────────────────────────

connectorCrudRouter.post('/_resolve', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { tenantId?: unknown; ids?: unknown };
    const tenantId = typeof body.tenantId === 'string' ? body.tenantId : null;
    const ids =
      Array.isArray(body.ids) && body.ids.every((v) => typeof v === 'string')
        ? (body.ids as string[])
        : null;
    if (!tenantId || !ids) {
      return res.status(400).json({ error: 'tenantId and ids[] are required' });
    }
    if (ids.length > 1000) {
      return res.status(400).json({ error: 'ids[] cannot exceed 1000 entries per call' });
    }
    const rows = await connectorCrudService.resolveTypesByIds(tenantId, ids);
    res.json({ connectors: rows });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ──────────────────────────────────────────────────────────────────────
// GET /jobs/:jobId — async job status polling
// Must be registered BEFORE /:connectorId/* so jobId is not consumed as connectorId.
// ──────────────────────────────────────────────────────────────────────

connectorCrudRouter.get('/jobs/:jobId', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const tenantId = req.query.tenantId as string;
    if (!tenantId) return res.status(400).json({ error: 'tenantId required' });

    const { getJob } = await import('../jobs/service.js');
    const job = await getJob(tenantId, jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // input is intentionally omitted — may contain PII from slide/doc content
    return res.json({
      id: job.id,
      status: job.status,
      result: job.result ?? null,
      error: job.error ?? null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  } catch (err) {
    handleRouteError(res, err, 'GET /jobs/:jobId');
  }
});

// ──────────────────────────────────────────────────────────────────────
// GET /:connectorId/files/:fileId/content — file download proxy
// Supports google_drive, google_slides, microsoft_onedrive,
// microsoft_sharepoint, dropbox, box.
//
// `?exportAs=text` asks for a Google-native file as text rather than as an
// Office binary. Callers split cleanly on this: the knowledge extractor, the
// build-time attachment machinery and the runtime's readDocument tool all
// parse whatever arrives straight into a string, while editDocument and
// editPresentation need the real .docx/.pptx bytes to rewrite. It is a
// parameter rather than a global switch because both answers are correct for
// their caller.
//
// It is also the only shape a composio_managed connector can serve: Composio
// signs requests server-side and hands back a decoded body, so binary cannot
// survive the hop. See serveComposioFileContent.
// ──────────────────────────────────────────────────────────────────────

// Google-native files hold no bytes of their own; Drive materialises them into
// a format the caller picks. Two maps, one per answer to "what will you do
// with this".
const GOOGLE_NATIVE_BINARY_EXPORT: Record<string, string> = {
  'application/vnd.google-apps.presentation':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.google-apps.document':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.google-apps.spreadsheet':
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const GOOGLE_NATIVE_TEXT_EXPORT: Record<string, string> = {
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.document': 'text/plain',
  // CSV, not a spreadsheet binary. Nothing downstream can read .xlsx — not the
  // knowledge extractor, not the runtime's readDocument — so a spreadsheet
  // asked for as text has always come back as either nothing or mojibake.
  'application/vnd.google-apps.spreadsheet': 'text/csv',
};

const EXPORT_MIME_EXTENSIONS: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'text/plain': '.txt',
  'text/csv': '.csv',
};

/**
 * A `Content-Disposition` value that Node will actually accept.
 *
 * A document's title is the user's text, and Node rejects any header value
 * outside Latin-1: an em dash, a curly quote, an ellipsis or an emoji makes
 * `res.setHeader` throw ERR_INVALID_CHAR, the route's error handler returns
 * 500, and the file is not slow or forbidden but permanently unreadable —
 * reported to the caller as the connector being down.
 *
 * So a title never reaches a header raw. RFC 6266 carries both forms: an
 * ASCII-safe `filename` any client can read, and a `filename*` holding the
 * real UTF-8 name for clients that understand it. Both are emitted, in that
 * order, so a client reading only the first still gets a usable name.
 */
export function contentDisposition(filename: string): string {
  const name = filename.length > 0 ? filename : 'download';
  // Printable ASCII only, minus the two characters that would end the quoted
  // string early. Anything else becomes '_' rather than being dropped, so the
  // name keeps its shape and two different titles stay different.
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Swap a file's extension for the one matching what we exported it as. */
function withExportExtension(filename: string, exportMime: string): string {
  return filename.replace(/\.[^.]+$/, '') + (EXPORT_MIME_EXTENSIONS[exportMime] ?? '');
}

/** Bodies that survive Composio's proxy intact, because they are text. */
function isTextualMime(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml'
  );
}

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const GRAPH_API = 'https://graph.microsoft.com/v1.0';

/** Microsoft connectors whose files are Graph driveItems. */
const MICROSOFT_GRAPH_FILE_TYPES = new Set(['microsoft_onedrive', 'microsoft_sharepoint']);
const GOOGLE_DRIVE_FILE_TYPES = new Set(['google_drive', 'google_slides', 'google_docs']);

/**
 * Separator for a drive-qualified file id: `<driveId>|<itemId>`.
 *
 * A Graph driveItem id is only unique WITHIN its drive, and the tools that
 * hand a file id to an agent (list_files) and the tool that later reads it
 * (read_document) are separate calls with no shared state — the id string is
 * the entire channel between them. Without the drive travelling inside it, a
 * SharePoint item can only ever be looked up against `/me/drive`, which is the
 * user's personal OneDrive, where it does not exist. That is why SharePoint
 * documents were unreachable: the lookup was well-formed and simply pointed at
 * the wrong drive.
 *
 * `|` is safe: Graph drive ids are base64url-ish (`b!` + [A-Za-z0-9_-]) and
 * item ids are alphanumeric, so neither can contain it.
 */
const DRIVE_QUALIFIED_ID_SEP = '|';

/**
 * List Microsoft 365 files through Composio's proxy.
 *
 * Emits ids as `<driveId>|<itemId>`. That is the load-bearing detail: the id
 * this returns is the exact string the model later hands to read_document, and
 * a bare Graph item id does not say which drive it belongs to.
 *
 * SharePoint without a drive/site is a search across the sites the user can
 * see, which Graph exposes as /sites?search= — but a document library listing
 * needs a drive, so callers that want files pass driveId or siteId. OneDrive
 * needs neither: /me/drive is unambiguous.
 */
async function listMicrosoftFilesViaComposio(args: {
  connectedAccountId: string;
  connectorType: string;
  query?: string;
  driveId?: string;
  siteId?: string;
  limit?: number;
}): Promise<{ files: Array<Record<string, unknown>>; nextPageToken?: string }> {
  const { connectedAccountId, connectorType, query, driveId, siteId } = args;
  const top = String(args.limit ?? 100);

  let drivePrefix: string;
  if (driveId) drivePrefix = `/drives/${encodeURIComponent(driveId)}`;
  else if (siteId) drivePrefix = `/sites/${encodeURIComponent(siteId)}/drive`;
  else if (connectorType === 'microsoft_sharepoint') {
    // No drive context: answer with the document libraries the user can reach
    // rather than silently listing their personal OneDrive, which is what the
    // native client did and why SharePoint files were never findable.
    const sites = await composioProxyRequest<{ value?: Array<Record<string, unknown>> }>({
      connectedAccountId,
      method: 'GET',
      endpoint: `${GRAPH_API}/sites`,
      queryParams: { search: query || '*', $top: top },
    });
    return {
      files: (sites?.value ?? []).map((s) => ({
        id: `site:${String(s.id ?? '')}`,
        name: s.displayName ?? s.name ?? '',
        mimeType: 'application/vnd.liftoff.sharepoint-site',
        webViewUrl: s.webUrl ?? '',
        isSite: true,
      })),
    };
  } else drivePrefix = '/me/drive';

  // Resolve the concrete drive id once so every returned item can carry it,
  // even when the caller addressed the drive by site.
  let resolvedDriveId = driveId ?? '';
  if (!resolvedDriveId) {
    const drive = await composioProxyRequest<{ id?: string }>({
      connectedAccountId,
      method: 'GET',
      endpoint: `${GRAPH_API}${drivePrefix}`,
      queryParams: { $select: 'id' },
    });
    resolvedDriveId = drive?.id ?? '';
  }

  const endpoint = query
    ? `${GRAPH_API}${drivePrefix}/root/search(q='${encodeURIComponent(query)}')`
    : `${GRAPH_API}${drivePrefix}/root/children`;

  const listed = await composioProxyRequest<{
    value?: Array<Record<string, unknown>>;
    '@odata.nextLink'?: string;
  }>({
    connectedAccountId,
    method: 'GET',
    endpoint,
    queryParams: { $top: top },
  });

  const files = (listed?.value ?? [])
    .filter((item) => !item.folder)
    .map((item) => {
      const itemId = String(item.id ?? '');
      return {
        id: resolvedDriveId ? `${resolvedDriveId}${DRIVE_QUALIFIED_ID_SEP}${itemId}` : itemId,
        name: item.name ?? '',
        mimeType: (item.file as { mimeType?: string } | undefined)?.mimeType ?? '',
        size: item.size,
        modifiedTime: item.lastModifiedDateTime,
        webViewUrl: item.webUrl ?? '',
      };
    });

  const nextLink = listed?.['@odata.nextLink'];
  const nextPageToken = nextLink
    ? new URL(nextLink).searchParams.get('$skiptoken') ?? undefined
    : undefined;

  return { files, nextPageToken };
}

/** Pull the Composio connected-account id out of a credential record. */
function composioConnectedAccountIdOf(creds: { connectorConfig?: Record<string, unknown> }): string | null {
  const cfg = creds.connectorConfig;
  const id = cfg && typeof cfg.composioConnectedAccountId === 'string' ? cfg.composioConnectedAccountId : '';
  return id || null;
}

/**
 * Resolve the Graph path for a driveItem, in precedence order:
 *   1. a drive-qualified id (`<driveId>|<itemId>`) — self-describing, survives
 *      the round trip through the model
 *   2. an explicit `driveId` / `siteId` query param
 *   3. `/me/drive` — correct for OneDrive, and the only sane default there
 *
 * SharePoint with no drive context is rejected rather than silently sent to
 * `/me/drive`: that lookup returns a 404 that reads like "file not found" when
 * the truth is "you looked in the wrong drive", and the wrong-but-plausible
 * error is what made this defect survive.
 */
export function resolveGraphItemTarget(args: {
  connectorType: string;
  fileId: string;
  siteId?: string;
  driveId?: string;
}): { itemPath: string; itemId: string } | { error: string } {
  const sepAt = args.fileId.indexOf(DRIVE_QUALIFIED_ID_SEP);
  if (sepAt > 0) {
    const driveId = args.fileId.slice(0, sepAt);
    const itemId = args.fileId.slice(sepAt + 1);
    if (!itemId) return { error: `Malformed drive-qualified file id: '${args.fileId}'` };
    return { itemPath: `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`, itemId };
  }

  if (args.driveId) {
    return {
      itemPath: `/drives/${encodeURIComponent(args.driveId)}/items/${encodeURIComponent(args.fileId)}`,
      itemId: args.fileId,
    };
  }
  if (args.siteId) {
    return {
      itemPath: `/sites/${encodeURIComponent(args.siteId)}/drive/items/${encodeURIComponent(args.fileId)}`,
      itemId: args.fileId,
    };
  }

  if (args.connectorType === 'microsoft_sharepoint') {
    return {
      error:
        'A SharePoint file needs its drive: pass a drive-qualified id ' +
        `('<driveId>${DRIVE_QUALIFIED_ID_SEP}<itemId>', as list_files returns) or a driveId/siteId ` +
        'query param. Resolving it against /me/drive would search the personal OneDrive instead.',
    };
  }

  return { itemPath: `/me/drive/items/${encodeURIComponent(args.fileId)}`, itemId: args.fileId };
}

const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';

/** RFC 4180: quote a field when it holds a comma, quote or newline. */
function csvCell(value: unknown): string {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Every worksheet of a Google Sheet as CSV, not just the first.
 *
 * `files/{id}/export?mimeType=text/csv` returns ONE worksheet — the first —
 * with no indication that others exist. A workbook with a summary tab in front
 * of the data imports as the summary and nothing else, and the knowledge item
 * that results looks complete: right title, plausible content, silently
 * missing everything a second tab held.
 *
 * The Sheets API enumerates the tabs and returns their values as JSON, which
 * also means this works identically on both credential transports — JSON is
 * exactly what Composio's proxy carries.
 *
 * Each tab is labelled in the output, because a bare concatenation of two
 * grids reads as one table with a corrupt row in the middle.
 */
async function fetchAllWorksheetsAsCsv(
  gFetch: (url: string, init?: RequestInit) => Promise<globalThis.Response>,
  fileId: string,
): Promise<{ csv: string; sheetCount: number } | { error: string; status: number }> {
  const metaResp = await gFetch(
    `${SHEETS_API}/${encodeURIComponent(fileId)}?fields=${encodeURIComponent('sheets(properties(title))')}`,
  );
  if (!metaResp.ok) {
    return { error: 'Could not list the worksheets in this spreadsheet', status: metaResp.status };
  }
  const meta = (await metaResp.json()) as {
    sheets?: Array<{ properties?: { title?: string } }>;
  };
  const titles = (meta.sheets ?? [])
    .map((s) => s.properties?.title)
    .filter((t): t is string => Boolean(t));

  if (titles.length === 0) {
    return { error: 'Spreadsheet reports no worksheets', status: 502 };
  }

  // One round trip for every tab's values.
  const ranges = titles.map((t) => `ranges=${encodeURIComponent(`'${t.replace(/'/g, "''")}'`)}`).join('&');
  const valuesResp = await gFetch(
    `${SHEETS_API}/${encodeURIComponent(fileId)}/values:batchGet?${ranges}&majorDimension=ROWS`,
  );
  if (!valuesResp.ok) {
    return { error: 'Could not read the worksheet contents', status: valuesResp.status };
  }
  const values = (await valuesResp.json()) as {
    valueRanges?: Array<{ values?: unknown[][] }>;
  };

  const blocks = (values.valueRanges ?? []).map((range, i) => {
    const rows = (range.values ?? []).map((row) => row.map(csvCell).join(','));
    const header = titles.length > 1 ? `--- Sheet: ${titles[i]} ---\n` : '';
    return `${header}${rows.join('\n')}`;
  });

  return { csv: blocks.join('\n\n'), sheetCount: titles.length };
}

/**
 * Serve a file from a composio_managed connector.
 *
 * These connectors have no access token to borrow — Composio holds the OAuth
 * grant and returns "REDACTED" for the token itself, so every vendor call has
 * to go through its signed proxy.
 *
 * The Google path below answers with text or an explicit refusal, because a
 * Google-native doc holds no bytes of its own and Drive materialises it into
 * whatever format the caller asks for; text is the shape that survives a
 * decoded JSON body.
 *
 * That is NOT a Composio limitation, and for a long time this function read as
 * though it were: the `startsWith('google_')` gate 501'd every other vendor
 * with a message about Composio not being implemented. Composio's proxy
 * streams a binary response to its own file backend and returns a short-lived
 * signed URL under `binary_data` — our transport was simply dropping the
 * field. Real file bytes (a .docx in OneDrive, a .pptx in a SharePoint
 * library) come back fine through `composioProxyBinaryDownload`, which is what
 * the Microsoft branch uses.
 */
async function serveComposioFileContent(
  res: Response,
  args: {
    connectorType: string;
    connectorId: string;
    tenantId: string;
    fileId: string;
    creds: Awaited<ReturnType<typeof credentialService.getCredentials>>;
    preferText: boolean;
    siteId?: string;
    driveId?: string;
  },
): Promise<Response | void> {
  const { connectorType, connectorId, tenantId, fileId, creds, preferText } = args;

  // The vendor-client credential shape wants a concrete accessToken; a
  // composio_managed connector has none, which is the whole point — the
  // connected-account id inside connectorConfig is what tryComposioProxy
  // dispatches on. Same normalisation /browse does when it builds its
  // credential provider.
  const proxyCreds: ClientCredentials = {
    ...creds,
    accessToken: creds.accessToken ?? '',
    tenantId,
    connectorId,
  };

  // ── Microsoft 365: real bytes, staged by Composio ────────────────────────
  // An Office file IS its bytes — there is no "export as text" for a .docx the
  // way there is for a Google Doc — so this asks Graph for /content and hands
  // back whatever Composio staged, letting the caller (readDocument's mammoth
  // parse, editDocument's rewrite) do the decoding it already does for the
  // native path.
  if (MICROSOFT_GRAPH_FILE_TYPES.has(connectorType)) {
    const connectedAccountId = composioConnectedAccountIdOf(creds);
    if (!connectedAccountId) {
      return res.status(401).json({ error: 'No Composio connected account for connector', connectorId });
    }

    const target = resolveGraphItemTarget({ connectorType, fileId, siteId: args.siteId, driveId: args.driveId });
    if ('error' in target) {
      return res.status(400).json({ error: target.error, connectorId, fileId });
    }

    // Name first, so the extension is right — readDocument dispatches its
    // parser on the filename, and a .docx served as "<itemId>" parses as
    // nothing.
    let filename = fileId;
    try {
      const meta = await composioProxyRequest<{ name?: string }>({
        connectedAccountId,
        method: 'GET',
        endpoint: `${GRAPH_API}${target.itemPath}`,
        queryParams: { $select: 'name' },
      });
      if (meta?.name) filename = meta.name;
    } catch (err) {
      // Non-fatal: a missing display name costs the parser its extension hint
      // but the bytes are still worth serving, and readDocument falls back to
      // sniffing content-type.
      logger.warn({ err, connectorId, fileId }, 'composio graph: file name lookup failed');
    }

    const binary = await composioProxyBinaryDownload({
      connectedAccountId,
      endpoint: `${GRAPH_API}${target.itemPath}/content`,
    });
    if (!binary) {
      return res.status(502).json({
        error:
          'Composio returned no binary payload for this file. The proxy stages bytes under ' +
          'binary_data; an empty field means the vendor answered with JSON (often a 404 for a ' +
          'drive item addressed against the wrong drive).',
        connectorId,
        fileId,
      });
    }

    const dl = await fetch(binary.url);
    if (!dl.ok || !dl.body) {
      return res.status(502).json({ error: 'Could not fetch the staged file from Composio', connectorId, fileId });
    }
    res.setHeader('Content-Type', binary.contentType ?? dl.headers.get('content-type') ?? 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition(filename));
    return (dl.body as unknown as NodeJS.ReadableStream).pipe(res);
  }

  // Drive is the file plane for every Google-native type; Docs/Sheets/Slides
  // connectors address the same files through it.
  const isDriveBacked = connectorType.startsWith('google_');
  if (!isDriveBacked) {
    return res.status(501).json({
      error: `File download through Composio is not implemented for ${connectorType}`,
      connectorId,
    });
  }

  const meta = await tryComposioProxy<{ name?: string; mimeType?: string }>(proxyCreds, {
    method: 'GET',
    path: `${DRIVE_API}/files/${encodeURIComponent(fileId)}`,
    query: { fields: 'name,mimeType' },
  });
  if (!meta.handled || !meta.data?.mimeType) {
    return res.status(502).json({ error: 'Could not read file metadata through Composio', fileId });
  }

  const sourceMime = meta.data.mimeType;
  const filename = meta.data.name ?? fileId;
  const textExport = GOOGLE_NATIVE_TEXT_EXPORT[sourceMime];

  // A Google-native file, and the caller wants bytes we cannot carry.
  if (textExport && !preferText) {
    return res.status(415).json({
      error:
        'This connector is managed by Composio, which cannot return binary. ' +
        'Request the file with ?exportAs=text.',
      connectorId,
      fileId,
      sourceMimeType: sourceMime,
    });
  }

  // A real uploaded file. Text passes through; anything else is bytes.
  if (!textExport && !isTextualMime(sourceMime)) {
    logger.info(
      { tenantId, connectorId, fileId, sourceMime },
      'composio file download refused — binary body cannot cross the Composio proxy',
    );
    return res.status(415).json({
      error:
        `Cannot download ${sourceMime} through a Composio-managed connector: the proxy ` +
        'returns decoded bodies, so binary content would arrive corrupted. Reconnect this ' +
        'connector with direct OAuth to download binary files.',
      connectorId,
      fileId,
      sourceMimeType: sourceMime,
    });
  }

  // A spreadsheet goes through the Sheets API so every tab comes back, not
  // just whichever one Drive's CSV export happens to pick.
  if (sourceMime === SPREADSHEET_MIME && preferText) {
    const gFetch = makeGoogleApiFetcher(tenantId, connectorId, creds);
    const sheets = await fetchAllWorksheetsAsCsv(gFetch, fileId);
    if ('error' in sheets) {
      return res.status(sheets.status).json({ error: sheets.error, connectorId, fileId });
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      contentDisposition(withExportExtension(filename, 'text/csv')),
    );
    return res.send(sheets.csv);
  }

  const body = textExport
    ? await tryComposioProxy<unknown>(proxyCreds, {
        method: 'GET',
        path: `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export`,
        query: { mimeType: textExport },
      })
    : await tryComposioProxy<unknown>(proxyCreds, {
        method: 'GET',
        path: `${DRIVE_API}/files/${encodeURIComponent(fileId)}`,
        query: { alt: 'media' },
      });

  if (!body.handled) {
    return res.status(502).json({ error: 'Composio proxy did not handle the download', fileId });
  }

  // proxyExecute decodes for us: a text body arrives as a string, a JSON body
  // as an object. Stringify the latter rather than shipping "[object Object]".
  const text = typeof body.data === 'string' ? body.data : JSON.stringify(body.data ?? '');
  const servedMime = textExport ?? sourceMime;

  res.setHeader('Content-Type', `${servedMime}; charset=utf-8`);
  res.setHeader(
    'Content-Disposition',
    contentDisposition(textExport ? withExportExtension(filename, textExport) : filename),
  );
  return res.send(text);
}

connectorCrudRouter.get(
  '/:connectorId/files/:fileId/content',
  async (req: Request, res: Response) => {
    try {
      const { connectorId, fileId } = req.params;
      const tenantId = req.query.tenantId as string;
      if (!tenantId) return res.status(400).json({ error: 'tenantId required' });

      const connector = await connectorCrudService.getById(connectorId, tenantId);
      if (!connector) return res.status(404).json({ error: 'Connector not found' });

      const creds = await credentialService.getCredentials(tenantId, connectorId);
      const preferText = String(req.query.exportAs ?? '').toLowerCase() === 'text';

      // composio_managed connectors have no access token to hand out — Composio
      // signs requests server-side and returns "REDACTED" for the underlying
      // OAuth token (see getComposioCredentials). `/browse` has always known
      // this and routes through the proxy; this route did not, so it answered
      // 401 "No access token for connector" for every Composio-managed Drive
      // file. That is the whole reason knowledge extraction failed: the picker
      // could list files it could never read.
      if (creds.flowKind === 'composio_managed') {
        // `return await`, not `return`: a bare `return promise` inside try/catch
        // hands the promise back before it settles, so a throw in here escapes
        // handleRouteError as an unhandled rejection and the caller waits until
        // it times out instead of getting a 500.
        return await serveComposioFileContent(res, {
          connectorType: connector.type,
          connectorId,
          tenantId,
          fileId,
          creds,
          preferText,
          siteId: req.query.siteId as string | undefined,
          driveId: req.query.driveId as string | undefined,
        });
      }

      if (!creds.accessToken) return res.status(401).json({ error: 'No access token for connector' });

      const gFetch = makeGoogleFetcher(tenantId, connectorId, creds.accessToken);

      let downloadUrl: string;
      let filename: string | undefined;
      let contentType: string | undefined;

      switch (connector.type) {
        case 'google_drive':
        case 'google_slides': {
          const metaResp = await gFetch(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=name,mimeType`,
          );
          if (!metaResp.ok) return res.status(metaResp.status).json({ error: 'File not found' });
          const meta = await metaResp.json() as { name: string; mimeType: string };
          filename = meta.name;

          // Same as the Composio path: Drive's CSV export returns one
          // worksheet, so a text read of a spreadsheet goes through the Sheets
          // API to pick up every tab.
          if (meta.mimeType === SPREADSHEET_MIME && preferText) {
            const sheets = await fetchAllWorksheetsAsCsv(gFetch, fileId);
            if ('error' in sheets) {
              return res.status(sheets.status).json({ error: sheets.error, connectorId, fileId });
            }
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader(
              'Content-Disposition',
              contentDisposition(withExportExtension(filename, 'text/csv')),
            );
            return res.send(sheets.csv);
          }

          const exportMime = preferText
            ? GOOGLE_NATIVE_TEXT_EXPORT[meta.mimeType]
            : GOOGLE_NATIVE_BINARY_EXPORT[meta.mimeType];
          if (exportMime) {
            downloadUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}`;
            contentType = exportMime;
            filename = withExportExtension(filename, exportMime);
          } else {
            downloadUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
            contentType = meta.mimeType;
          }
          break;
        }
        case 'microsoft_onedrive': {
          const metaResp = await fetch(
            `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(fileId)}?select=name,@microsoft.graph.downloadUrl`,
            { headers: { Authorization: `Bearer ${creds.accessToken}` } },
          );
          if (!metaResp.ok) return res.status(metaResp.status).json({ error: 'File not found' });
          const meta = await metaResp.json() as { name: string; '@microsoft.graph.downloadUrl': string };
          filename = meta.name;
          downloadUrl = meta['@microsoft.graph.downloadUrl'];
          break;
        }
        case 'microsoft_sharepoint': {
          // SharePoint files require a siteId — passed as query param by extraction job
          const siteIdParam = req.query.siteId as string | undefined;
          const itemPath = siteIdParam
            ? `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(siteIdParam)}/drive/items/${encodeURIComponent(fileId)}?select=name,@microsoft.graph.downloadUrl`
            : `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(fileId)}?select=name,@microsoft.graph.downloadUrl`;
          const metaResp = await fetch(itemPath, { headers: { Authorization: `Bearer ${creds.accessToken}` } });
          if (!metaResp.ok) return res.status(metaResp.status).json({ error: 'File not found' });
          const meta = await metaResp.json() as { name: string; '@microsoft.graph.downloadUrl': string };
          filename = meta.name;
          downloadUrl = meta['@microsoft.graph.downloadUrl'];
          break;
        }
        case 'dropbox': {
          const dlResp = await fetch('https://content.dropboxapi.com/2/files/download', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${creds.accessToken}`,
              'Dropbox-API-Arg': JSON.stringify({ path: fileId }),
            },
          });
          if (!dlResp.ok) return res.status(dlResp.status).json({ error: 'File not found' });
          filename = JSON.parse(dlResp.headers.get('dropbox-api-result') ?? '{}').name;
          res.setHeader('Content-Disposition', contentDisposition(filename ?? fileId));
          if (dlResp.headers.get('content-type')) res.setHeader('Content-Type', dlResp.headers.get('content-type')!);
          if (!dlResp.body) return res.status(502).json({ error: 'Empty response body from Dropbox' });
          return (dlResp.body as unknown as NodeJS.ReadableStream).pipe(res);
        }
        case 'box': {
          downloadUrl = `https://api.box.com/2.0/files/${encodeURIComponent(fileId)}/content`;
          break;
        }
        default:
          return res.status(400).json({ error: `Unsupported connector type: ${connector.type}` });
      }

      const fileResp = await gFetch(downloadUrl);
      if (!fileResp.ok) return res.status(fileResp.status).json({ error: 'Download failed' });

      const resolvedContentType = contentType ?? fileResp.headers.get('content-type') ?? 'application/octet-stream';
      res.setHeader('Content-Type', resolvedContentType);
      res.setHeader('Content-Disposition', contentDisposition(filename ?? fileId));
      (fileResp.body as unknown as NodeJS.ReadableStream).pipe(res);
    } catch (err) {
      handleRouteError(res, err, 'GET /:connectorId/files/:fileId/content');
    }
  },
);

// ──────────────────────────────────────────────────────────────────────
// POST /:connectorId/files — file upload proxy
// Accepts multipart/form-data with a 'file' field (max 50 MB).
// Supports google_drive, google_slides, microsoft_onedrive,
// microsoft_sharepoint, dropbox, box.
// ──────────────────────────────────────────────────────────────────────

connectorCrudRouter.post(
  '/:connectorId/files',
  multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }).single('file'),
  async (req: Request, res: Response) => {
    try {
      const { connectorId } = req.params;
      const { tenantId, destinationPath, filename, mimeType } = req.body as Record<string, string>;
      if (!tenantId || !req.file) return res.status(400).json({ error: 'tenantId and file required' });

      const connector = await connectorCrudService.getById(connectorId, tenantId);
      if (!connector) return res.status(404).json({ error: 'Connector not found' });
      const creds = await credentialService.getCredentials(tenantId, connectorId);

      const effectiveName = filename || req.file.originalname;
      const effectiveMime = mimeType || req.file.mimetype;

      // ── Microsoft 365 over Composio ────────────────────────────────────────
      // Ahead of the access-token guard: a composio_managed connector never has
      // one, so the guard below would 401 every generate_docx / generate_pptx
      // and the "push a copy back into M365" half of the feature would be dead
      // on arrival. The bytes ride Composio's proxy as binary_body.
      if (creds.flowKind === 'composio_managed' && MICROSOFT_GRAPH_FILE_TYPES.has(connector.type)) {
        const connectedAccountId = composioConnectedAccountIdOf(creds);
        if (!connectedAccountId) {
          return res.status(401).json({ error: 'No Composio connected account for connector', connectorId });
        }

        const driveId = (req.body.driveId as string | undefined) || undefined;
        const siteId = (req.body.siteId as string | undefined) || undefined;
        // Upload addresses a PATH, not an item id, so it takes the drive
        // prefix directly rather than going through resolveGraphItemTarget.
        let drivePrefix: string;
        if (driveId) drivePrefix = `/drives/${encodeURIComponent(driveId)}`;
        else if (siteId) drivePrefix = `/sites/${encodeURIComponent(siteId)}/drive`;
        else if (connector.type === 'microsoft_sharepoint') {
          return res.status(400).json({
            error:
              'A SharePoint upload needs a driveId or siteId; without one the file would land in ' +
              'the personal OneDrive rather than the document library.',
            connectorId,
          });
        } else drivePrefix = '/me/drive';

        const targetPath = destinationPath ? `${destinationPath}/${effectiveName}` : effectiveName;
        // Graph's simple upload: PUT /{drive}/root:/{path}:/content
        const endpoint =
          `${GRAPH_API}${drivePrefix}/root:/${targetPath.split('/').map(encodeURIComponent).join('/')}:/content`;

        const uploaded = await composioProxyBinaryUpload({
          connectedAccountId,
          method: 'PUT',
          endpoint,
          content: req.file.buffer,
          contentType: effectiveMime,
        });
        const data = (uploaded.data ?? {}) as {
          id?: string;
          parentReference?: { path?: string };
          webUrl?: string;
        };
        return res.status(201).json({
          fileId: data.id,
          path: data.parentReference?.path ?? '/',
          webViewUrl: data.webUrl,
        });
      }

      // ── Google Drive over Composio ─────────────────────────────────────────
      // The same carve-out, for the same reason: the comment above names
      // "every generate_docx / generate_pptx", and the fix beneath it covered
      // Microsoft only. A Composio-managed Drive reached the token guard and
      // answered 401 "No access token for connector" on every .docx/.pptx a
      // team wrote — while the download route beside this one had already
      // branched on flowKind for every type. Drive's multipart upload cannot
      // ride `binary_body` (one part, one content type), so the bytes go up as
      // `uploadType=media` — raw body, Drive assigns a name — and one metadata
      // PATCH names the file and places it, the same two-call shape the native
      // Docs and Slides jobs use for placement.
      if (creds.flowKind === 'composio_managed' && GOOGLE_DRIVE_FILE_TYPES.has(connector.type)) {
        const connectedAccountId = composioConnectedAccountIdOf(creds);
        if (!connectedAccountId) {
          return res.status(401).json({ error: 'No Composio connected account for connector', connectorId });
        }
        const uploaded = await composioProxyBinaryUpload({
          connectedAccountId,
          method: 'POST',
          endpoint: `https://www.googleapis.com/upload/drive/v3/files?uploadType=media&fields=id`,
          content: req.file.buffer,
          contentType: effectiveMime,
        });
        const created = (uploaded.data ?? {}) as { id?: string };
        if (!created.id) {
          return res.status(502).json({ error: 'Drive upload returned no file id', connectorId });
        }
        const proxyCreds = { ...creds, accessToken: creds.accessToken ?? '', tenantId, connectorId };
        const named = await tryComposioProxy<{ id?: string; name?: string; webViewLink?: string }>(proxyCreds, {
          method: 'PATCH',
          path: `${DRIVE_API}/files/${encodeURIComponent(created.id)}`,
          query: {
            fields: 'id,name,webViewLink',
            ...(destinationPath ? { addParents: destinationPath } : {}),
          },
          body: { name: effectiveName },
        });
        const data = named.handled ? (named.data ?? {}) : {};
        return res.status(201).json({
          fileId: created.id,
          path: destinationPath ?? '/',
          webViewUrl: data.webViewLink ?? `https://drive.google.com/file/d/${encodeURIComponent(created.id)}/view`,
        });
      }
      if (!creds.accessToken) return res.status(401).json({ error: 'No access token for connector' });
      const gFetch = makeGoogleFetcher(tenantId, connectorId, creds.accessToken);
      // Copy into a fresh Uint8Array<ArrayBuffer> so TypeScript accepts it as
      // BlobPart / BodyInit. Node Buffer may share a SharedArrayBuffer.
      const buffer = new Uint8Array(req.file.buffer);

      switch (connector.type) {
        case 'google_drive':
        case 'google_slides': {
          const metadata = {
            name: effectiveName,
            ...(destinationPath ? { parents: [destinationPath] } : {}),
          };
          const form = new FormData();
          form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
          form.append('file', new Blob([buffer], { type: effectiveMime }), effectiveName);
          const uploadResp = await gFetch(
            'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
            { method: 'POST', body: form },
          );
          if (!uploadResp.ok) return res.status(uploadResp.status).json({ error: 'Upload failed' });
          const data = await uploadResp.json() as { id: string; name: string; webViewLink?: string };
          return res.status(201).json({ fileId: data.id, path: destinationPath ?? '/', webViewUrl: data.webViewLink });
        }
        case 'microsoft_onedrive':
        case 'microsoft_sharepoint': {
          const drivePath = destinationPath ? `${destinationPath}/${effectiveName}` : effectiveName;
          const uploadResp = await fetch(
            `https://graph.microsoft.com/v1.0/me/drive/root:/${encodeURIComponent(drivePath)}:/content`,
            { method: 'PUT', headers: { Authorization: `Bearer ${creds.accessToken}`, 'Content-Type': effectiveMime }, body: buffer },
          );
          if (!uploadResp.ok) return res.status(uploadResp.status).json({ error: 'Upload failed' });
          const data = await uploadResp.json() as { id: string; name: string; parentReference?: { path?: string }; webUrl?: string };
          return res.status(201).json({ fileId: data.id, path: data.parentReference?.path ?? '/', webViewUrl: data.webUrl });
        }
        case 'dropbox': {
          const dropboxPath = `/${destinationPath ? `${destinationPath}/` : ''}${effectiveName}`;
          const uploadResp = await fetch('https://content.dropboxapi.com/2/files/upload', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${creds.accessToken}`,
              'Content-Type': 'application/octet-stream',
              'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath, mode: 'overwrite' }),
            },
            body: buffer,
          });
          if (!uploadResp.ok) return res.status(uploadResp.status).json({ error: 'Upload failed' });
          const data = await uploadResp.json() as { id: string; path_display: string };
          return res.status(201).json({ fileId: data.id, path: data.path_display });
        }
        case 'box': {
          const form = new FormData();
          form.append('attributes', JSON.stringify({ name: effectiveName, parent: { id: destinationPath ?? '0' } }));
          form.append('file', new Blob([buffer], { type: effectiveMime }), effectiveName);
          const uploadResp = await fetch('https://upload.box.com/api/2.0/files/content', {
            method: 'POST',
            headers: { Authorization: `Bearer ${creds.accessToken}` },
            body: form,
          });
          if (!uploadResp.ok) return res.status(uploadResp.status).json({ error: 'Upload failed' });
          const data = await uploadResp.json() as { entries?: Array<{ id: string; name: string; shared_link?: { url?: string } }> };
          const entry = data.entries?.[0];
          return res.status(201).json({ fileId: entry?.id, path: `/${effectiveName}`, webViewUrl: entry?.shared_link?.url });
        }
        default:
          return res.status(400).json({ error: `Unsupported connector type: ${connector.type}` });
      }
    } catch (err) {
      handleRouteError(res, err, 'POST /:connectorId/files');
    }
  },
);

// ──────────────────────────────────────────────────────────────────────
// GET /:connectorId/presentations/:presentationId — structured JSON
// Reads a Google Slides presentation via the Slides API.
// ──────────────────────────────────────────────────────────────────────

connectorCrudRouter.get(
  '/:connectorId/presentations/:presentationId',
  async (req: Request, res: Response) => {
    try {
      const { connectorId, presentationId } = req.params;
      const tenantId = req.query.tenantId as string;
      if (!tenantId) return res.status(400).json({ error: 'tenantId required' });

      const connector = await connectorCrudService.getById(connectorId, tenantId);
      if (!connector) return res.status(404).json({ error: 'Connector not found' });
      const creds = await credentialService.getCredentials(tenantId, connectorId);

      const gFetch = makeGoogleApiFetcher(tenantId, connectorId, creds);

      const slidesResp = await gFetch(
        `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}`,
      );
      if (!slidesResp.ok) return res.status(slidesResp.status).json({ error: 'Presentation not found' });
      const presentation = await slidesResp.json() as {
        presentationId: string;
        title: string;
        slides: Array<{
          objectId: string;
          pageElements?: Array<{
            shape?: { text?: { textElements?: Array<{ textRun?: { content?: string } }> } };
            table?: { tableRows?: Array<{ tableCells?: Array<{ text?: { textElements?: Array<{ textRun?: { content?: string } }> } }> }> };
          }>;
        }>;
      };

      const extractText = (textElements?: Array<{ textRun?: { content?: string } }>): string =>
        (textElements ?? [])
          .map(el => el.textRun?.content ?? '')
          .join('')
          .replace(/\n$/, '');

      const slides = (presentation.slides ?? []).map((slide, index) => {
        const texts: string[] = [];
        const tables: Array<{ headers: string[]; rows: string[][] }> = [];

        for (const el of slide.pageElements ?? []) {
          if (el.shape?.text) {
            const t = extractText(el.shape.text.textElements);
            if (t) texts.push(t);
          }
          if (el.table) {
            const tableRows = el.table.tableRows ?? [];
            const rows = tableRows.map(row =>
              (row.tableCells ?? []).map(cell => extractText(cell.text?.textElements)),
            );
            if (rows.length > 0) {
              tables.push({ headers: rows[0], rows: rows.slice(1) });
            }
          }
        }

        return { index, bodyText: texts.join('\n'), tables };
      });

      return res.json({
        fileId: presentationId,
        name: presentation.title,
        slideCount: slides.length,
        slides,
        mimeType: 'application/vnd.google-apps.presentation',
      });
    } catch (err) {
      handleRouteError(res, err, 'GET /:connectorId/presentations/:presentationId');
    }
  },
);

// ──────────────────────────────────────────────────────────────────────
// POST /:connectorId/presentations/:presentationId/copy-and-replace
// Copies a Google Slides presentation and performs text replacements.
// ──────────────────────────────────────────────────────────────────────

connectorCrudRouter.post(
  '/:connectorId/presentations/:presentationId/copy-and-replace',
  async (req: Request, res: Response) => {
    try {
      const { connectorId, presentationId } = req.params;
      const tenantId = req.query.tenantId as string;
      if (!tenantId) return res.status(400).json({ error: 'tenantId required' });

      const connector = await connectorCrudService.getById(connectorId, tenantId);
      if (!connector) return res.status(404).json({ error: 'Connector not found' });
      // Pre-flight only: the job handler fetches its own credentials, but
      // resolving them here turns an unusable connector into a 409 at submit
      // time rather than a job that fails minutes later where nobody is
      // looking. The value is deliberately unused.
      await credentialService.getCredentials(tenantId, connectorId);

      const body = req.body as { name?: string; replacements?: Array<{ find: string; replace: string }> };

      const jobId = await createJob({
        tenantId,
        connectorId,
        operation: 'copy_and_replace',
        input: { connectorId, tenantId, presentationId, body },
      });

      return res.status(202).json({
        jobId,
        statusUrl: `/api/connectors/jobs/${jobId}?tenantId=${encodeURIComponent(tenantId)}`,
      });
    } catch (err) {
      handleRouteError(res, err, 'POST /:connectorId/presentations/:presentationId/copy-and-replace');
    }
  },
);

// ──────────────────────────────────────────────────────────────────────
// POST /:connectorId/documents/create
// Creates a rich Google Docs document using the Docs batchUpdate API:
// TITLE/HEADING named styles, bullets, and table text. Returns 202 + jobId.
// ──────────────────────────────────────────────────────────────────────

connectorCrudRouter.post(
  '/:connectorId/documents/create',
  async (req: Request, res: Response) => {
    try {
      const { connectorId } = req.params;
      const tenantId = req.query.tenantId as string;
      if (!tenantId) return res.status(400).json({ error: 'tenantId required' });

      const connector = await connectorCrudService.getById(connectorId, tenantId);
      if (!connector) return res.status(404).json({ error: 'Connector not found' });
      // Pre-flight only: the job handler fetches its own credentials, but
      // resolving them here turns an unusable connector into a 409 at submit
      // time rather than a job that fails minutes later where nobody is
      // looking. The value is deliberately unused.
      await credentialService.getCredentials(tenantId, connectorId);

      const body = req.body as { title?: string; sections?: unknown };
      if (!body.title) return res.status(400).json({ error: 'title required' });
      if (!Array.isArray(body.sections)) return res.status(400).json({ error: 'sections must be an array' });

      const jobId = await createJob({
        tenantId,
        connectorId,
        operation: 'create_google_doc',
        input: { connectorId, tenantId, body },
      });

      return res.status(202).json({
        jobId,
        statusUrl: `/api/connectors/jobs/${jobId}?tenantId=${encodeURIComponent(tenantId)}`,
      });
    } catch (err) {
      handleRouteError(res, err, 'POST /:connectorId/documents/create');
    }
  },
);

// ──────────────────────────────────────────────────────────────────────
// POST /:connectorId/documents/:documentId/copy-and-edit
// Copies a Google Doc and applies find/replace edits to the copy. Returns
// 202 + jobId.
//
// The native counterpart to the runtime's editDocument, which downloads a
// .docx and redlines it. That needs bytes, which a composio_managed connector
// cannot provide. Same shape as presentations/copy-and-replace.
// ──────────────────────────────────────────────────────────────────────

connectorCrudRouter.post(
  '/:connectorId/documents/:documentId/copy-and-edit',
  async (req: Request, res: Response) => {
    try {
      const { connectorId, documentId } = req.params;
      const tenantId = req.query.tenantId as string;
      if (!tenantId) return res.status(400).json({ error: 'tenantId required' });

      const connector = await connectorCrudService.getById(connectorId, tenantId);
      if (!connector) return res.status(404).json({ error: 'Connector not found' });
      // Pre-flight only: the job handler fetches its own credentials, but
      // resolving them here turns an unusable connector into a 409 at submit
      // time rather than a job that fails minutes later where nobody is
      // looking. The value is deliberately unused.
      await credentialService.getCredentials(tenantId, connectorId);

      const body = req.body as { name?: string; edits?: Array<{ find: string; replace: string }> };
      if (!Array.isArray(body.edits) || body.edits.length === 0) {
        // A copy with no edits is not what this endpoint is for, and returning
        // 202 for it would report work that was never requested.
        return res.status(400).json({ error: 'edits must be a non-empty array' });
      }

      const jobId = await createJob({
        tenantId,
        connectorId,
        operation: 'copy_and_edit_document',
        input: { connectorId, tenantId, documentId, body },
      });

      return res.status(202).json({
        jobId,
        statusUrl: `/api/connectors/jobs/${jobId}?tenantId=${encodeURIComponent(tenantId)}`,
      });
    } catch (err) {
      handleRouteError(res, err, 'POST /:connectorId/documents/:documentId/copy-and-edit');
    }
  },
);

// ──────────────────────────────────────────────────────────────────────
// POST /:connectorId/presentations/create-from-template
// Copies a Google Slides template for its theme, then populates it with
// structured slide content from scratch via a single batchUpdate.
// ──────────────────────────────────────────────────────────────────────

connectorCrudRouter.post(
  '/:connectorId/presentations/create-from-template',
  async (req: Request, res: Response) => {
    try {
      const { connectorId } = req.params;
      const tenantId = req.query.tenantId as string;
      if (!tenantId) return res.status(400).json({ error: 'tenantId required' });

      const connector = await connectorCrudService.getById(connectorId, tenantId);
      if (!connector) return res.status(404).json({ error: 'Connector not found' });
      // Pre-flight only: the job handler fetches its own credentials, but
      // resolving them here turns an unusable connector into a 409 at submit
      // time rather than a job that fails minutes later where nobody is
      // looking. The value is deliberately unused.
      await credentialService.getCredentials(tenantId, connectorId);

      const body = req.body as { templateFileId?: string; name?: string; title?: string; slides?: unknown };
      if (!body.name) return res.status(400).json({ error: 'name required' });
      if (!body.title) return res.status(400).json({ error: 'title required' });
      if (!Array.isArray(body.slides)) return res.status(400).json({ error: 'slides must be an array' });

      const jobId = await createJob({
        tenantId,
        connectorId,
        operation: 'create_from_template',
        input: { connectorId, tenantId, body },
      });

      return res.status(202).json({
        jobId,
        statusUrl: `/api/connectors/jobs/${jobId}?tenantId=${encodeURIComponent(tenantId)}`,
      });
    } catch (err) {
      handleRouteError(res, err, 'POST /:connectorId/presentations/create-from-template');
    }
  },
);

// ──────────────────────────────────────────────────────────────────────
// GET /:connectorId/browse — knowledge file picker
// Called by platform-backend knowledge module to populate the file picker.
// Accepts: tenantId (required), query?, cursor?, mimeTypes? (comma-joined),
//          folderId?
// Returns: { results: BrowseResult[], nextCursor: string | null }
// ──────────────────────────────────────────────────────────────────────

interface BrowseResult {
  id: string;
  title: string;
  url: string | null;
  contentType: string;
  excerpt: string | null;
  metadata: Record<string, unknown>;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(text: string, max = 300): string | null {
  if (!text) return null;
  return text.length > max ? text.slice(0, max) + '...' : text;
}

// Storage- and wiki-shaped connectors, used ONLY by the hierarchical folder
// walk further down, which needs to know whether a "children of this folder"
// request is meaningful. Browse itself no longer consults a list like this: it
// asks the client registry.
//
// An earlier version of this file carried five such sets (help centre, storage,
// wiki, chat, table) as browse's front door, and every connector missing from
// them answered 200-with-empty. That is the worst available answer, because
// "we never implemented this" and "your account is empty" arrive at the picker
// looking identical, and a required destination then blocks a hire with nothing
// on screen explaining why.
const STORAGE_TYPES = new Set<string>(['google_drive', 'microsoft_onedrive', 'dropbox', 'box', 'microsoft_sharepoint', 'google_docs']);
const WIKI_TYPES = new Set<string>(['atlassian_confluence', 'notion', 'microsoft_onenote']);

/** What "browse this connector" means when the caller names no entityType.
 *
 *  This is one datum per connector, not a dispatch chain: the name of the thing
 *  at the top of that connector's hierarchy. It genuinely differs, and getting
 *  it wrong is silent. Collapsing all of these to a single 'folder' default
 *  shipped a picker that listed ONLY folders for Google Drive — because Drive's
 *  client reads 'folder' as a mimeType filter — so the knowledge page could no
 *  longer select a file at all, and every wiki connector answered "cannot
 *  enumerate" because none of them has a 'folder'.
 *
 *  A connector absent from this map falls back to its poll spec's first entity,
 *  then to 'file', which is the right guess for the storage-shaped connectors
 *  that dominate the remainder. */
export const DEFAULT_BROWSE_ENTITY: Record<string, string> = {
  // Storage: 'file' lists files AND folders, which is what a file picker needs.
  // 'folder' would restrict the listing to folders and hide every file.
  google_drive: 'file',
  microsoft_onedrive: 'file',
  dropbox: 'file',
  box: 'file',
  // 'file' lists files AND folders here too. Defaulting Google Docs to 'folder'
  // filtered every document out of the picker, so a person choosing where
  // output goes could see folders but a person choosing which document to read
  // saw nothing at all — in the same modal, on the same connection. What the
  // pick MEANS is the picker's business; browse's business is to show what is
  // there.
  google_docs: 'file',
  google_sheets: 'spreadsheet',
  // Help centres and wikis, each with its own word for a top-level container.
  zendesk: 'category',
  intercom: 'collection',
  atlassian_confluence: 'space',
  notion: 'page',
  microsoft_onenote: 'notebook',
  microsoft_sharepoint: 'site',
};

export function defaultBrowseEntity(
  connectorType: string,
  pollSpec?: { entities: Array<{ entityType: string }> },
): string {
  return DEFAULT_BROWSE_ENTITY[connectorType]
    ?? pollSpec?.entities[0]?.entityType
    ?? 'file';
}

export function mapToBrowseResult(connectorType: string, record: { id: string; data: Record<string, unknown> }): BrowseResult {
  const data = record.data;
  switch (connectorType) {
    case 'microsoft_excel': {
      return {
        id: record.id,
        title: (data.name as string) ?? record.id,
        url: (data.webUrl as string) ?? null,
        contentType: 'spreadsheet',
        excerpt: (data.parentReference as { path?: string } | undefined)?.path ?? null,
        metadata: { lastModified: data.lastModifiedDateTime ?? null },
      };
    }
    // Airtable, Coda and Baserow all nest a table under a parent, so each
    // carries a qualifiedName built at list time. "Tasks" repeats across bases
    // and docs, and an unqualified list of them cannot be chosen from.
    case 'discord':
    case 'airtable':
    case 'coda':
    case 'baserow': {
      return {
        id: record.id,
        title: (data.qualifiedName as string) ?? (data.name as string) ?? record.id,
        url: (data.browserLink as string) ?? null,
        contentType: 'table',
        excerpt: (data.description as string) ?? null,
        metadata: {},
      };
    }
    case 'google_docs': {
      // Read the row, do not assume the connector. This said 'folder' for
      // everything, which was true while the client only ever returned folders
      // and became a lie the moment it also returned documents: the picker
      // draws an expand chevron on anything typed 'folder', so every document
      // in the list offered to open into children it does not have.
      const isFolder = data.mimeType === 'application/vnd.google-apps.folder';
      return {
        id: record.id,
        title: (data.name as string) ?? record.id,
        url: (data.webViewLink as string) ?? null,
        contentType: isFolder ? 'folder' : 'document',
        excerpt: null,
        metadata: { modifiedTime: data.modifiedTime ?? null },
      };
    }
    case 'google_sheets': {
      const owner = (data.owners as Array<{ displayName?: string }> | undefined)?.[0]?.displayName;
      return {
        id: record.id,
        title: (data.name as string) ?? record.id,
        url: (data.webViewLink as string) ?? null,
        contentType: 'spreadsheet',
        // Owner and last-modified are the two things that tell apart four
        // spreadsheets sharing a name, which is the normal case in a shared
        // drive rather than the exception.
        excerpt: owner ? `Owned by ${owner}` : null,
        metadata: { modifiedTime: data.modifiedTime ?? null },
      };
    }
    case 'slack': {
      // `#name` because that is how a person recognises a channel; the bare
      // name reads like a folder in a list of folders.
      const name = (data.name as string) ?? '';
      return {
        id: record.id,
        title: name ? `#${name}` : record.id,
        url: null,
        contentType: 'channel',
        excerpt: (data.purpose as { value?: string } | undefined)?.value
          ?? (data.topic as { value?: string } | undefined)?.value
          ?? null,
        // is_private drives nothing here yet, but a picker that cannot tell a
        // public channel from a private one is one bad pick away from posting
        // customer detail into a shared room.
        metadata: { isPrivate: Boolean(data.is_private), isMember: Boolean(data.is_member) },
      };
    }
    case 'microsoft_teams': {
      return {
        id: record.id,
        title: (data.displayName as string) ?? record.id,
        url: (data.webUrl as string) ?? null,
        contentType: 'channel',
        excerpt: (data.description as string) ?? null,
        metadata: { membershipType: data.membershipType ?? null },
      };
    }
    case 'zendesk': {
      const zMeta = (data.metadata as Record<string, unknown>) ?? {};
      return {
        id: record.id,
        title: (data.title as string) ?? '',
        url: (data.url as string) ?? (data.html_url as string) ?? null,
        contentType: (data.contentType as string) ?? 'article',
        excerpt: data.body ? truncate(stripHtml((data.body as string) ?? '')) : null,
        metadata: { ...zMeta },
      };
    }
    case 'intercom': {
      const iMeta = (data.metadata as Record<string, unknown>) ?? {};
      return {
        id: record.id,
        title: (data.title as string) ?? '',
        url: (data.url as string) ?? null,
        contentType: (data.contentType as string) ?? 'article',
        excerpt: data.body ? truncate(stripHtml((data.body as string) ?? '')) : null,
        metadata: { ...iMeta },
      };
    }
    case 'google_drive': {
      const isFolder = data.mimeType === 'application/vnd.google-apps.folder';
      return {
        id: record.id,
        title: (data.name as string) ?? '',
        url: (data.webViewLink as string) ?? null,
        contentType: isFolder ? 'folder' : 'document',
        excerpt: null,
        metadata: { mimeType: data.mimeType },
      };
    }
    case 'microsoft_onedrive': {
      const isFolder = !!(data.folder);
      const fileData = data.file as Record<string, unknown> | undefined;
      return {
        id: record.id,
        title: (data.name as string) ?? '',
        url: (data.webViewLink as string) ?? (data.webUrl as string) ?? null,
        contentType: isFolder ? 'folder' : 'document',
        excerpt: null,
        metadata: { mimeType: fileData?.mimeType ?? null },
      };
    }
    case 'dropbox': {
      const isFolder = data['.tag'] === 'folder';
      const path = data.path_display as string | undefined;
      return {
        id: record.id,
        title: (data.name as string) ?? '',
        url: path ? `https://www.dropbox.com/${isFolder ? 'home' : 'preview'}${path}` : null,
        contentType: isFolder ? 'folder' : 'document',
        excerpt: null,
        metadata: { path: data.path_display },
      };
    }
    case 'box': {
      const isFolder = data.type === 'folder';
      return {
        id: record.id,
        title: (data.name as string) ?? '',
        url: `https://app.box.com/${isFolder ? 'folder' : 'file'}/${record.id}`,
        contentType: isFolder ? 'folder' : 'document',
        excerpt: null,
        metadata: {},
      };
    }
    case 'microsoft_sharepoint': {
      // Permissive: list() wraps data with {title,url,contentType,metadata}
      // while read() returns the raw Graph driveItem (name/webUrl/folder).
      const folder = data.folder;
      return {
        id: record.id,
        title: (data.title as string) ?? (data.name as string) ?? '',
        url: (data.url as string) ?? (data.webUrl as string) ?? null,
        contentType: (data.contentType as string) ?? (folder ? 'folder' : 'document'),
        excerpt: null,
        metadata: (data.metadata as Record<string, unknown>) ?? {},
      };
    }
    case 'atlassian_confluence': {
      return {
        id: record.id,
        title: (data.title as string) ?? '',
        url: (data.url as string) ?? null,
        contentType: (data.contentType as string) ?? 'folder',
        excerpt: null,
        metadata: (data.metadata as Record<string, unknown>) ?? {},
      };
    }
    case 'notion': {
      // Notion pages/databases — data is the raw Notion object
      const isDatabase = data.object === 'database';
      const titleProp = data.title as Array<{ plain_text?: string }> | undefined;
      const title = titleProp?.[0]?.plain_text
        ?? (data.properties as Record<string, { title?: Array<{ plain_text?: string }> }>)?.title?.title?.[0]?.plain_text
        ?? '';
      return {
        id: record.id,
        title,
        url: (data.url as string) ?? null,
        contentType: isDatabase ? 'collection' : 'document',
        excerpt: null,
        metadata: { objectType: data.object },
      };
    }
    case 'microsoft_onenote': {
      // Permissive: list() wraps with a flat url string while read() returns
      // the raw Graph object whose URL lives at links.oneNoteWebUrl.href.
      const links = data.links as Record<string, { href?: string }> | undefined;
      return {
        id: record.id,
        title: (data.title as string) ?? '',
        url: (data.url as string) ?? links?.oneNoteWebUrl?.href ?? null,
        contentType: (data.contentType as string) ?? 'document',
        excerpt: null,
        metadata: (data.metadata as Record<string, unknown>) ?? {},
      };
    }
    default: {
      // The fallback now carries real traffic: every composio_managed connector
      // with no bespoke client maps through here, and those rows come from 80
      // different vendors. `name` covers most, but a board, a channel and an
      // envelope each pick a different word, and a row whose title resolves to
      // '' renders as a blank line the person cannot identify or meaningfully
      // choose. Falling back to the id keeps a row selectable in the worst case,
      // which beats an empty one.
      const named = ['name', 'title', 'displayName', 'display_name', 'label',
        'subject', 'summary', 'key']
        .map(k => data[k])
        .find(v => typeof v === 'string' && v.trim());

      return {
        id: record.id,
        title: (named as string) ?? record.id,
        url: (data.url as string) ?? (data.webUrl as string) ?? null,
        contentType: 'document',
        excerpt: null,
        metadata: {},
      };
    }
  }
}

connectorCrudRouter.get(
  '/:connectorId/browse',
  async (req: Request, res: Response, _next) => {
    try {
      const tenantId = getTenantId(req);
      if (!tenantId) {
        return res.status(400).json({ error: 'tenantId is required' });
      }

      const { connectorId } = req.params;
      const {
        cursor,
        folderId,
        mimeTypes: mimeTypesParam,
        entityType,
      } = req.query as Record<string, string | undefined>;

      // Look up connector
      const connector = await connectorCrudService.getById(connectorId, tenantId);
      if (!connector) {
        return res.status(404).json({ error: 'Connector not found' });
      }
      if (connector.status !== 'active') {
        return res.status(409).json({ error: 'Connector is not active — please reconnect in Settings.' });
      }

      const connectorType = connector.type as string;

      // Browseability is a property of having a client, not of appearing in a
      // list kept in this file. The five hardcoded type sets that used to live
      // here answered "not browseable" for every connector nobody had thought
      // to add, which is indistinguishable from "your account is empty" once it
      // reaches a picker.
      // Three tiers, most specific first. A connector needs to match only one,
      // and adding a connector to the catalog is usually enough to be served by
      // the third without writing anything.
      //
      //   1. a bespoke client, when one exists
      //   2. a ComposioPollSpec, already driving one data-driven client in the
      //      poll scheduler — browse asks the same question polling does
      //   3. any composio_managed toolkit, by discovering the toolkit's own
      //      list operation (see clients/composio-entity-list.ts)
      //
      // Tier 3 is what makes this scale: 80 catalog connectors declare a
      // toolkitSlug and have no client, and without it they would all answer
      // 200-with-empty — telling people their Airtable, Monday or Todoist
      // account was empty when the call is simply not implemented.
      const clientFactory = getClientFactory(connectorType);
      const pollSpec = clientFactory ? undefined : getPollSpec(connectorType);
      const catalogEntry = CONNECTORS[connectorType];
      const toolkitSlug = !clientFactory && !pollSpec
        && catalogEntry?.mcp?.kind === 'composio_managed'
        ? catalogEntry.mcp.toolkitSlug
        : undefined;

      if (!clientFactory && !pollSpec && !toolkitSlug) {
        return res.json({ results: [], nextCursor: null, unsupported: true });
      }

      // Retrieve credentials
      const creds = await credentialService.getCredentials(tenantId, connectorId);
      // composio_managed connectors (e.g. intercom) carry no raw bearer — the
      // token lives with Composio, keyed by connectorConfig.composioConnectedAccountId.
      if (!creds.accessToken && !creds.apiKey && !creds.connectorConfig?.composioConnectedAccountId) {
        return res.status(401).json({ error: 'No credentials available for connector' });
      }

      // Build filters
      const filters: Record<string, unknown> = {};
      if (cursor) filters.pageToken = cursor;
      if (folderId) filters.folderId = folderId;
      if (mimeTypesParam && connectorType === 'google_drive') {
        filters.mimeTypes = mimeTypesParam.split(',');
      }

      // Instantiate the right client and call list()
      const cp = async () => ({
        accessToken: creds.accessToken ?? creds.apiKey ?? '',
        instanceUrl: creds.instanceUrl,
        // Pass connectorConfig through so the vendor client's tryComposioProxy
        // can detect composio_managed connectors (via composioConnectedAccountId)
        // and route through Composio's signed proxy. Without it, composio_managed
        // Google connectors (Drive/Slides/Docs/Sheets) fall back to direct HTTP
        // with an empty bearer token → 401 on every document-tool/browse call.
        connectorConfig: creds.connectorConfig,
      });

      // The factories take an ExecutorContext because Execute has one. Browse is
      // not executing a named function, so most of that context does not exist
      // here. Only the fields a constructor actually reads carry real values;
      // the rest are empty rather than plausible-looking fakes.
      // Tier 3 has no CompensationClient to build — it talks to the toolkit
      // directly — so it answers here rather than joining the client path below.
      if (toolkitSlug) {
        const connectedAccountId = creds.connectorConfig?.composioConnectedAccountId;
        if (typeof connectedAccountId !== 'string' || !connectedAccountId) {
          return res.status(409).json({
            error: `${connectorType} is not linked to Composio — please reconnect in Settings.`,
          });
        }

        const listed = await listViaComposioTool({
          toolkitSlug,
          connectedAccountId,
          tenantId,
          entityType: entityType ?? defaultBrowseEntity(connectorType),
          filters,
        });

        if (listed.unsupported) {
          return res.json({ results: [], nextCursor: null, unsupported: true });
        }
        return res.json({
          results: listed.records.map(r =>
            mapToBrowseResult(connectorType, r as { id: string; data: Record<string, unknown> }),
          ),
          nextCursor: listed.nextPageToken ?? null,
        });
      }

      let client: CompensationClient;
      if (clientFactory) {
        client = clientFactory(
          {
            tenantId,
            connectorId,
            connectorType,
            connectorConfig: creds.connectorConfig ?? {},
            functionName: '__browse__',
            input: {},
            idempotencyKey: '',
            traceId: '',
            credentials: creds,
          } as unknown as Parameters<typeof clientFactory>[0],
          cp,
        );
      } else {
        const connectedAccountId = creds.connectorConfig?.composioConnectedAccountId;
        if (typeof connectedAccountId !== 'string' || !connectedAccountId) {
          return res.status(409).json({
            error: `${connectorType} is not linked to Composio — please reconnect in Settings.`,
          });
        }
        client = new ComposioGenericPollClient(pollSpec!, tenantId, connectedAccountId);
      }

      const listResult = await client.list(
        entityType ?? defaultBrowseEntity(connectorType, pollSpec),
        filters,
      );

      // "I cannot enumerate that" is not "you have none". Carried separately all
      // the way out so the picker can tell the customer which one it is.
      if (listResult.unsupported) {
        return res.json({ results: [], nextCursor: null, unsupported: true });
      }


      const results: BrowseResult[] = listResult.records.map(r =>
        mapToBrowseResult(connectorType, r as { id: string; data: Record<string, unknown> }),
      );

      return res.json({
        results,
        nextCursor: listResult.nextPageToken ?? null,
        pollCursor: listResult.pollCursor ?? null,
      });
    } catch (err) {
      if (isReconnectRequiredOAuthError(err)) {
        if (err instanceof OAuthRefreshError) {
          await markConnectorReconnectRequired(err.tenantId, err.connectorId, err.vendor);
        }
        if (!res.headersSent) {
          res.status(401).json({ error: 'Connector re-authorization required — please reconnect in Settings.' });
        }
        return;
      }
      logger.error({ err }, 'GET /:connectorId/browse: unhandled error');
      if (!res.headersSent) {
        res.status(500).json({ error: (err as Error).message ?? 'Browse failed' });
      }
    }
  },
);

// ──────────────────────────────────────────────────────────────────────
// GET /:connectorId/files — cloud-storage FILE LISTING for the agent
// document tools (tenant-runtime document-tool-handlers.listFiles).
//
// Distinct from /browse (the knowledge-plane picker → BrowseResult): this
// returns the ListFilesResult shape the document tools expect —
// { files: [{ id, name, mimeType, size, modifiedAt, webViewUrl }], nextPageToken }.
// Delegates to the connector client's list('file', …). Status codes mirror
// /browse so tenant-runtime can classify accurately: 404 (no connector),
// 409 (inactive → reconnect), 401 (no creds / OAuth refresh required).
// ──────────────────────────────────────────────────────────────────────

interface FileListEntry {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
  modifiedAt?: string;
  webViewUrl?: string;
}

// Connector types whose client.list('file', …) returns real cloud-storage files.
// (google_docs / google_sheets clients currently stub list() → empty; they still
// pass through here rather than 404, so the caller reads an empty list, not an
// error.)
const FILE_LIST_TYPES = new Set<string>([
  'google_drive', 'google_slides', 'google_docs', 'google_sheets',
  'microsoft_onedrive', 'dropbox', 'box', 'microsoft_sharepoint',
]);

connectorCrudRouter.get(
  '/:connectorId/files',
  async (req: Request, res: Response) => {
    try {
      const tenantId = getTenantId(req);
      if (!tenantId) {
        return res.status(400).json({ error: 'tenantId is required' });
      }
      const { connectorId } = req.params;
      const {
        path: folderId,
        query,
        mimeTypes: mimeTypesParam,
        limit,
      } = req.query as Record<string, string | undefined>;

      const connector = await connectorCrudService.getById(connectorId, tenantId);
      if (!connector) {
        return res.status(404).json({ error: 'Connector not found' });
      }
      if (connector.status !== 'active') {
        return res.status(409).json({ error: 'Connector is not active — please reconnect in Settings.' });
      }

      const connectorType = connector.type as string;
      // Non file-listing connector types → empty (mirrors /browse's non-browseable path).
      if (!FILE_LIST_TYPES.has(connectorType)) {
        return res.json({ files: [], nextPageToken: null });
      }

      const creds = await credentialService.getCredentials(tenantId, connectorId);
      if (!creds.accessToken && !creds.apiKey && !creds.connectorConfig?.composioConnectedAccountId) {
        return res.status(401).json({ error: 'No credentials available for connector' });
      }
      const cp = async () => ({
        accessToken: creds.accessToken ?? creds.apiKey ?? '',
        instanceUrl: creds.instanceUrl,
        // Pass connectorConfig through so the vendor client's tryComposioProxy
        // can detect composio_managed connectors (via composioConnectedAccountId)
        // and route through Composio's signed proxy. Without it, composio_managed
        // Google connectors (Drive/Slides/Docs/Sheets) fall back to direct HTTP
        // with an empty bearer token → 401 on every document-tool/browse call.
        connectorConfig: creds.connectorConfig,
      });

      // Filters: set both pageSize and limit — Drive-family clients read pageSize,
      // Slides reads limit — so the caps line up regardless of client.
      const filters: Record<string, unknown> = {};
      if (folderId) filters.folderId = folderId;
      if (query) filters.query = query;
      if (limit) { filters.pageSize = Number(limit); filters.limit = Number(limit); }
      if (mimeTypesParam) filters.mimeTypes = mimeTypesParam.split(',');

      // ── Microsoft 365 over Composio ────────────────────────────────────────
      // The native Microsoft clients build their own `Bearer ${accessToken}`
      // requests, and a composio_managed connector has no token — they would
      // send `Bearer ` and 401. Route through the proxy instead, and emit
      // DRIVE-QUALIFIED ids so the file the model is handed can actually be
      // opened again later (see DRIVE_QUALIFIED_ID_SEP).
      if (creds.flowKind === 'composio_managed' && MICROSOFT_GRAPH_FILE_TYPES.has(connectorType)) {
        const connectedAccountId = composioConnectedAccountIdOf(creds);
        if (!connectedAccountId) {
          return res.status(401).json({ error: 'No Composio connected account for connector' });
        }
        const listed = await listMicrosoftFilesViaComposio({
          connectedAccountId,
          connectorType,
          query,
          driveId: (req.query.driveId as string | undefined) || undefined,
          siteId: (req.query.siteId as string | undefined) || undefined,
          limit: limit ? Number(limit) : undefined,
        });
        return res.json({ files: listed.files, nextPageToken: listed.nextPageToken ?? null });
      }

      let listResult: { records: Array<{ id: string; data: Record<string, unknown> }>; nextPageToken?: string };
      switch (connectorType) {
        case 'google_drive': listResult = await new GoogleDriveClient(cp).list('file', filters); break;
        case 'google_slides': listResult = await new GoogleSlidesClient(cp).list('file', filters); break;
        case 'google_docs': listResult = await new GoogleDocsClient(cp).list('file', filters); break;
        case 'google_sheets': listResult = await new GoogleSheetsClient(cp).list('file', filters); break;
        case 'microsoft_onedrive': listResult = await new MicrosoftOneDriveClient(cp).list('file', filters); break;
        case 'dropbox': listResult = await new DropboxClient(cp).list('file', filters); break;
        case 'microsoft_sharepoint': listResult = await new MicrosoftSharePointClient(cp).list('file', filters); break;
        default: listResult = await new BoxClient(cp).list('file', filters); break; // box
      }

      // Map each record's `data` → FileMetadata. Field names vary by client
      // (drive: modifiedTime/webViewLink/size/mimeType; slides: modifiedAt/webViewUrl),
      // so accept either.
      const files: FileListEntry[] = listResult.records.map((r) => {
        const d = r.data as Record<string, unknown>;
        const sizeRaw = d.size;
        return {
          id: r.id,
          name: (d.name as string) ?? (d.title as string) ?? r.id,
          mimeType: (d.mimeType as string) ?? undefined,
          size: sizeRaw != null && sizeRaw !== '' ? Number(sizeRaw) : undefined,
          modifiedAt: (d.modifiedTime as string) ?? (d.modifiedAt as string) ?? undefined,
          webViewUrl: (d.webViewLink as string) ?? (d.webViewUrl as string) ?? (d.url as string) ?? undefined,
        };
      });

      return res.json({ files, nextPageToken: listResult.nextPageToken ?? null });
    } catch (err) {
      if (isReconnectRequiredOAuthError(err)) {
        if (err instanceof OAuthRefreshError) {
          await markConnectorReconnectRequired(err.tenantId, err.connectorId, err.vendor);
        }
        if (!res.headersSent) {
          res.status(401).json({ error: 'Connector re-authorization required — please reconnect in Settings.' });
        }
        return;
      }
      logger.error({ err }, 'GET /:connectorId/files: unhandled error');
      if (!res.headersSent) {
        res.status(500).json({ error: (err as Error).message ?? 'File listing failed' });
      }
    }
  },
);

// ──────────────────────────────────────────────────────────────────────
// GET /:connectorId/items/:externalId — refresh a single item's metadata
// Returns a BrowseResult (same shape /browse rows use) by calling
// client.read() and running the response through mapToBrowseResult. Used
// by the platform-backend sync path to refresh individually-picked
// file_select items, which don't live under any watched folder and so
// are never reached by the folder re-walk in syncItems.
// ──────────────────────────────────────────────────────────────────────

connectorCrudRouter.get(
  '/:connectorId/items/:externalId',
  async (req: Request, res: Response) => {
    try {
      const tenantId = getTenantId(req);
      if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });

      const { connectorId, externalId } = req.params;
      const contentType = (req.query.contentType as string | undefined) ?? 'document';

      const connector = await connectorCrudService.getById(connectorId, tenantId);
      if (!connector) return res.status(404).json({ error: 'Connector not found' });
      if (connector.status !== 'active') {
        return res.status(409).json({ error: 'Connector is not active — please reconnect in Settings.' });
      }

      const connectorType = connector.type as string;
      if (!STORAGE_TYPES.has(connectorType) && !WIKI_TYPES.has(connectorType)) {
        return res.status(400).json({ error: `Item refresh not supported for ${connectorType}` });
      }

      const creds = await credentialService.getCredentials(tenantId, connectorId);
      if (!creds.accessToken && !creds.apiKey && !creds.connectorConfig?.composioConnectedAccountId) {
        return res.status(401).json({ error: 'No credentials available for connector' });
      }

      const cp = async () => ({
        accessToken: creds.accessToken ?? creds.apiKey ?? '',
        instanceUrl: creds.instanceUrl,
        // Pass connectorConfig through so the vendor client's tryComposioProxy
        // can detect composio_managed connectors (via composioConnectedAccountId)
        // and route through Composio's signed proxy. Without it, composio_managed
        // Google connectors (Drive/Slides/Docs/Sheets) fall back to direct HTTP
        // with an empty bearer token → 401 on every document-tool/browse call.
        connectorConfig: creds.connectorConfig,
      });

      const isFolder = contentType === 'folder' || contentType === 'collection';

      let record: { id: string; data: Record<string, unknown> };
      switch (connectorType) {
        case 'google_drive':
          record = await new GoogleDriveClient(cp).read(isFolder ? 'folder' : 'file', externalId);
          break;
        case 'microsoft_onedrive':
          record = await new MicrosoftOneDriveClient(cp).read(isFolder ? 'folder' : 'file', externalId);
          break;
        case 'box':
          record = await new BoxClient(cp).read(isFolder ? 'folder' : 'file', externalId);
          break;
        case 'dropbox':
          record = await new DropboxClient(cp).read(isFolder ? 'folder' : 'file', externalId);
          break;
        case 'microsoft_sharepoint': {
          // BrowseResult.id is "item:{siteId}:{driveItemId}"; driveItem read
          // wants "{siteId}:{driveItemId}". Restore the prefix on the way out.
          const stripped = externalId.startsWith('item:') ? externalId.slice('item:'.length) : externalId;
          const raw = await new MicrosoftSharePointClient(cp).read('driveItem', stripped);
          record = { id: `item:${stripped}`, data: raw.data };
          break;
        }
        case 'microsoft_onenote': {
          // BrowseResult.id for OneNote is "{notebook|section|page}:{id}";
          // read takes the bare id. Restore the prefix on the way out so
          // the caller's externalId still matches.
          const sep = externalId.indexOf(':');
          const prefix = sep > 0 ? externalId.slice(0, sep) : 'page';
          const rawId = sep > 0 ? externalId.slice(sep + 1) : externalId;
          const validTypes: Record<string, 'notebook' | 'section' | 'page'> = {
            notebook: 'notebook', section: 'section', page: 'page',
          };
          const entityType = validTypes[prefix] ?? 'page';
          const raw = await new MicrosoftOneNoteClient(cp).read(entityType, rawId);
          record = { id: externalId, data: raw.data };
          break;
        }
        case 'atlassian_confluence': {
          // mapToBrowseResult for Confluence reads `data.url` directly and has
          // no way to resolve the Atlassian site host; ConfluenceClient.list()
          // converts the relative webui to an absolute URL, so do the same
          // here for parity.
          const client = new ConfluenceClient(cp);
          const raw = await client.read('page', externalId);
          const absoluteUrl = await client.absoluteWebUrl(raw.data);
          record = { id: raw.id, data: { ...raw.data, url: absoluteUrl } };
          break;
        }
        case 'notion': {
          const credentialStore = new PerConnectorIdCredentialStore(tenantId, connectorId);
          record = await new NotionMCPClient({ tenantId, credentialStore }).read(
            isFolder ? 'database' : 'page',
            externalId,
          );
          break;
        }
        default:
          return res.status(400).json({ error: `Item refresh not supported for ${connectorType}` });
      }

      const result = mapToBrowseResult(connectorType, record);
      return res.json(result);
    } catch (err) {
      if (isReconnectRequiredOAuthError(err)) {
        if (err instanceof OAuthRefreshError) {
          await markConnectorReconnectRequired(err.tenantId, err.connectorId, err.vendor);
        }
        if (!res.headersSent) {
          res.status(401).json({ error: 'Connector re-authorization required — please reconnect in Settings.' });
        }
        return;
      }
      if (isVendorNotFoundError(err)) {
        if (!res.headersSent) {
          res.status(404).json({ error: 'not_found' });
        }
        return;
      }
      logger.error({ err }, 'GET /:connectorId/items/:externalId: unhandled error');
      if (!res.headersSent) {
        res.status(500).json({ error: (err as Error).message ?? 'Item refresh failed' });
      }
    }
  },
);

// Detect "the upstream vendor says this item is gone" across the eight
// storage/wiki clients. Each client's request helper throws
// `Error('<Vendor> API error: <status> - <body>')`; Dropbox uses 409 with a
// `path/not_found` body. We match on the message rather than a status field
// because none of the client request helpers currently attach the HTTP
// status to the Error object.
function isVendorNotFoundError(err: unknown): boolean {
  const msg = (err as Error | undefined)?.message ?? '';
  if (!msg) return false;
  if (/\b404\b/.test(msg)) return true;
  if (/not[_\s-]?found/i.test(msg)) return true; // Dropbox 409 path/not_found, Notion "object_not_found", etc.
  return false;
}

// ──────────────────────────────────────────────────────────────────────
// GET /:connectorId/content/:externalId — article content extraction
// Returns { html: string, title: string } for article-type connectors.
// Used by the platform-backend extraction job.
// ──────────────────────────────────────────────────────────────────────

const ARTICLE_CONTENT_TYPES = new Set<string>(['zendesk', 'intercom', 'atlassian_confluence', 'microsoft_onenote']);

connectorCrudRouter.get(
  '/:connectorId/content/:externalId',
  async (req: Request, res: Response) => {
    try {
      const tenantId = getTenantId(req);
      if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });

      const { connectorId, externalId } = req.params;
      const contentType = (req.query.contentType as string | undefined) ?? 'article';

      const connector = await connectorCrudService.getById(connectorId, tenantId);
      if (!connector) return res.status(404).json({ error: 'Connector not found' });

      const connectorType = connector.type as string;
      if (!ARTICLE_CONTENT_TYPES.has(connectorType)) {
        return res.status(400).json({ error: `Content extraction not supported for ${connectorType}` });
      }

      const creds = await credentialService.getCredentials(tenantId, connectorId);
      if (!creds.accessToken && !creds.apiKey && !creds.connectorConfig?.composioConnectedAccountId) {
        return res.status(401).json({ error: 'No credentials available for connector' });
      }

      const cp = async () => ({
        accessToken: creds.accessToken ?? creds.apiKey ?? '',
        instanceUrl: creds.instanceUrl,
        // Pass connectorConfig through so the vendor client's tryComposioProxy
        // can detect composio_managed connectors (via composioConnectedAccountId)
        // and route through Composio's signed proxy. Without it, composio_managed
        // Google connectors (Drive/Slides/Docs/Sheets) fall back to direct HTTP
        // with an empty bearer token → 401 on every document-tool/browse call.
        connectorConfig: creds.connectorConfig,
      });

      let html = '';
      let title = '';

      if (connectorType === 'zendesk') {
        const client = new ZendeskClient(cp);
        const record = await client.read(contentType, externalId);
        html = (record.data.body as string) ?? '';
        title = (record.data.title as string) ?? '';
      } else if (connectorType === 'intercom') {
        const connectedAccountId = creds.connectorConfig?.composioConnectedAccountId;
        if (typeof connectedAccountId !== 'string' || !connectedAccountId) {
          return res.status(409).json({ error: 'Intercom connection is not linked to Composio — reconnect required' });
        }
        const client = new IntercomComposioClient({ tenantId, connectedAccountId });
        const record = await client.read('article', externalId);
        html = (record.data.body as string) ?? '';
        title = (record.data.title as string) ?? '';
      } else if (connectorType === 'atlassian_confluence') {
        const client = new ConfluenceClient(cp);
        const record = await client.read('page', externalId);
        const body = record.data.body as Record<string, unknown> | undefined;
        html = (body?.storage as Record<string, unknown>)?.value as string ?? '';
        title = (record.data.title as string) ?? '';
      } else if (connectorType === 'microsoft_onenote') {
        // Strip type prefix (page:id → id)
        const rawId = externalId.startsWith('page:') ? externalId.slice('page:'.length) : externalId;
        const client = new MicrosoftOneNoteClient(cp);
        // GET /me/onenote/pages/{id} returns JSON metadata (no content field).
        // HTML content requires GET /me/onenote/pages/{id}/content → text/html.
        const [meta, pageHtml] = await Promise.all([
          client.read('page', rawId),
          client.readPageHtml(rawId),
        ]);
        html = pageHtml;
        title = (meta.data.title as string) ?? '';
      }

      return res.json({ html, title });
    } catch (err) {
      logger.error({ err }, 'GET /:connectorId/content/:externalId: unhandled error');
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// ──────────────────────────────────────────────────────────────────────
// POST /:connectorId/webhooks — register a folder-level webhook subscription
// DELETE /:connectorId/webhooks/:subscriptionId — deregister a webhook
// GET /:connectorId/webhooks/signing-keys — return Box HMAC signing keys
// ──────────────────────────────────────────────────────────────────────

connectorCrudRouter.post(
  '/:connectorId/webhooks',
  async (req: Request, res: Response, next) => {
    try {
      const tenantId = getTenantId(req);
      if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });
      const { connectorId } = req.params;
      const { externalId, notificationUrl, channelToken } = req.body as {
        externalId: string;
        notificationUrl: string;
        channelToken: string;
      };
      if (!externalId || !notificationUrl || !channelToken) {
        return res.status(400).json({ error: 'externalId, notificationUrl, and channelToken are required' });
      }

      const connector = await connectorCrudService.getById(connectorId, tenantId);
      if (!connector) return res.status(404).json({ error: 'Connector not found' });
      const creds = await credentialService.getCredentials(tenantId, connectorId);
      // connectorConfig is forwarded so client classes can detect
      // composio_managed routing via creds.connectorConfig.composioConnectedAccountId
      // and switch to Composio proxy transport without callers needing
      // to think about it.
      const cp = async () => ({
        accessToken: creds.accessToken ?? creds.apiKey ?? '',
        instanceUrl: creds.instanceUrl,
        connectorConfig: creds.connectorConfig,
      });

      let subscriptionId: string;
      let expiresAt: string | null = null;

      const connectorType = connector.type as string;

      // composio_managed branch — generic over connector type. For ANY
      // connector bound via Composio (gmail, drive, calendar, slack,
      // outlook, jira, etc.), Google/Microsoft/Slack all reject our
      // direct webhook arming because the OAuth client project doesn't
      // match (Composio owns the client). Composio's trigger system is
      // the only path that works: composio.triggers.create(slug,
      // {connectedAccountId, triggerConfig}) registers a poll or webhook
      // trigger on their side, and Composio HTTP-POSTs to our project-
      // level webhook URL (<this deployment>/api/internal/
      // composio-webhook). Which slug to register per connector type
      // lives in the COMPOSIO_TRIGGER_BY_CONNECTOR_TYPE registry —
      // adding a new connector with event support is one row there +
      // a matching row on tenant-runtime's dispatch table.
      const cfg = creds.connectorConfig as { composioConnectedAccountId?: string } | undefined;
      const composioConnectedAccountId =
        typeof cfg?.composioConnectedAccountId === 'string' ? cfg.composioConnectedAccountId : '';
      if (composioConnectedAccountId) {
        const { COMPOSIO_TRIGGER_BY_CONNECTOR_TYPE } = await import('../oauth/composio-trigger-registry.js');
        const spec = COMPOSIO_TRIGGER_BY_CONNECTOR_TYPE[connectorType];
        if (!spec) {
          return res.status(400).json({
            error: `composio_managed connector type '${connectorType}' has no event trigger registered ` +
              `(see oauth/composio-trigger-registry.ts). Tool calls still work; this endpoint is only ` +
              `for arming event delivery.`,
          });
        }
        const { createComposioTriggerInstance } = await import('../oauth/composio-client.js');
        const trig = await createComposioTriggerInstance({
          tenantId,
          slug: spec.slug,
          connectedAccountId: composioConnectedAccountId,
          triggerConfig: spec.triggerConfig,
        });
        // Composio triggers don't expire — they run as long as the
        // connected account is ACTIVE. Synthesize a watch-row shape so
        // TR's existing gmail_watch_subscriptions / equivalent tables
        // accept the response without schema changes:
        //   subscriptionId = composio triggerId (for future disable/delete)
        //   expirationMs   = 1 year out (well past Google's 7-day watch
        //                    window so the rearm cron never targets it)
        //   historyId      = '' (Composio delivers full message
        //                    payloads, not vendor-specific cursors)
        const oneYearMs = Date.now() + 365 * 24 * 60 * 60 * 1000;
        return res.json({
          subscriptionId: trig.triggerId,
          expiresAt: new Date(oneYearMs).toISOString(),
          historyId: '',
          expirationMs: oneYearMs,
        });
      }

      if (connectorType === 'google_drive') {
        const client = new GoogleDriveClient(cp);
        const result = await client.registerWebhook(externalId, channelToken, notificationUrl);
        subscriptionId = result.subscriptionId;
        expiresAt = result.expiresAt;
      } else if (connectorType === 'microsoft_onedrive') {
        const client = new MicrosoftOneDriveClient(cp);
        const result = await client.registerWebhook(externalId, channelToken, notificationUrl);
        subscriptionId = result.subscriptionId;
        expiresAt = result.expiresAt;
      } else if (connectorType === 'microsoft_sharepoint') {
        // externalId is either:
        //   site:{siteId}           — root of a site drive (itemId = '')
        //   item:{siteId}:{itemId}  — specific drive item
        let spSiteId: string;
        let spItemId: string;
        if (externalId.startsWith('item:')) {
          const parts = externalId.split(':');
          spSiteId = parts[1] ?? '';
          spItemId = parts[2] ?? '';
        } else if (externalId.startsWith('site:')) {
          spSiteId = externalId.slice('site:'.length);
          spItemId = '';
        } else {
          spSiteId = '';
          spItemId = externalId;
        }
        const client = new MicrosoftSharePointClient(cp);
        const result = await client.registerWebhook(spSiteId, spItemId, channelToken, notificationUrl);
        subscriptionId = result.subscriptionId;
        expiresAt = result.expiresAt;
      } else if (connectorType === 'box') {
        const client = new BoxClient(cp);
        const result = await client.registerWebhook(externalId, notificationUrl);
        subscriptionId = result.subscriptionId;
      } else if (connectorType === 'google_mail') {
        // composio_managed Gmail can't go through Google's native
        // users.watch — Google enforces that the Pub/Sub topic project
        // match the OAuth client project (Composio's, not ours), so
        // we use Composio triggers instead (handled in the composio
        // branch above for ALL composio_managed connectors). The
        // direct-OAuth Gmail path stays as the fallback for the day
        // we ever flip Gmail back off composio_managed.
        const client = new GoogleMailClient(cp);
        const result = await client.registerWebhook(externalId, channelToken, notificationUrl);
        subscriptionId = result.subscriptionId;
        expiresAt = result.expirationMs ? new Date(result.expirationMs).toISOString() : null;
        return res.json({ subscriptionId, expiresAt, historyId: result.historyId, expirationMs: result.expirationMs });
      } else {
        return res.status(400).json({ error: `Webhooks not supported for connector type: ${connectorType}` });
      }

      res.json({ subscriptionId, expiresAt });
    } catch (err) {
      logger.error({ err }, 'POST /:connectorId/webhooks: error');
      next(err);
    }
  },
);

// WS-9.2 — Gmail history-list endpoint for the TR push receiver.
//
// Given startHistoryId, fetches every message added since and returns
// normalized envelopes. Mounted under the same auth-scope as the other
// per-connector endpoints; tenant_id required.
connectorCrudRouter.post(
  '/:connectorId/gmail/history',
  async (req: Request, res: Response, next) => {
    try {
      const tenantId = getTenantId(req);
      if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });
      const { connectorId } = req.params;
      const { startHistoryId } = req.body as { startHistoryId?: string };
      if (!startHistoryId) return res.status(400).json({ error: 'startHistoryId is required' });

      const connector = await connectorCrudService.getById(connectorId, tenantId);
      if (!connector) return res.status(404).json({ error: 'Connector not found' });
      if ((connector.type as string) !== 'google_mail') {
        return res.status(400).json({ error: 'Connector is not google_mail' });
      }

      const creds = await credentialService.getCredentials(tenantId, connectorId);
      const cp = async () => ({ accessToken: creds.accessToken ?? creds.apiKey ?? '', instanceUrl: creds.instanceUrl, connectorConfig: creds.connectorConfig });
      const client = new GoogleMailClient(cp);
      const result = await client.getHistorySince(startHistoryId);
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'POST /:connectorId/gmail/history: error');
      next(err);
    }
  },
);

connectorCrudRouter.patch(
  '/:connectorId/webhooks/:subscriptionId',
  async (req: Request, res: Response, next) => {
    try {
      const tenantId = getTenantId(req);
      if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });
      const { connectorId, subscriptionId } = req.params;

      const connector = await connectorCrudService.getById(connectorId, tenantId);
      if (!connector) return res.status(404).json({ error: 'Connector not found' });
      const creds = await credentialService.getCredentials(tenantId, connectorId);
      // connectorConfig is forwarded so client classes can detect
      // composio_managed routing via creds.connectorConfig.composioConnectedAccountId
      // and switch to Composio proxy transport without callers needing
      // to think about it.
      const cp = async () => ({
        accessToken: creds.accessToken ?? creds.apiKey ?? '',
        instanceUrl: creds.instanceUrl,
        connectorConfig: creds.connectorConfig,
      });

      const connectorType = connector.type as string;
      let expiresAt: string | null = null;

      if (connectorType === 'microsoft_onedrive') {
        const client = new MicrosoftOneDriveClient(cp);
        const result = await client.renewWebhook(subscriptionId);
        expiresAt = result.expiresAt;
      } else if (connectorType === 'microsoft_sharepoint') {
        const client = new MicrosoftSharePointClient(cp);
        const result = await client.renewWebhook(subscriptionId);
        expiresAt = result.expiresAt;
      } else {
        return res.status(400).json({ error: `Webhook renewal not supported for: ${connectorType}` });
      }

      res.json({ subscriptionId, expiresAt });
    } catch (err) {
      logger.error({ err }, 'PATCH /:connectorId/webhooks/:subscriptionId: error');
      next(err);
    }
  },
);

connectorCrudRouter.delete(
  '/:connectorId/webhooks/:subscriptionId',
  async (req: Request, res: Response, next) => {
    try {
      const tenantId = getTenantId(req);
      if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });
      const { connectorId, subscriptionId } = req.params;

      const connector = await connectorCrudService.getById(connectorId, tenantId);
      if (!connector) return res.status(404).json({ error: 'Connector not found' });
      const creds = await credentialService.getCredentials(tenantId, connectorId);
      // connectorConfig is forwarded so client classes can detect
      // composio_managed routing via creds.connectorConfig.composioConnectedAccountId
      // and switch to Composio proxy transport without callers needing
      // to think about it.
      const cp = async () => ({
        accessToken: creds.accessToken ?? creds.apiKey ?? '',
        instanceUrl: creds.instanceUrl,
        connectorConfig: creds.connectorConfig,
      });

      const connectorType = connector.type as string;
      if (connectorType === 'google_drive') {
        const { resourceId } = req.body as { resourceId?: string };
        const client = new GoogleDriveClient(cp);
        await client.deregisterWebhook(subscriptionId, resourceId ?? '');
      } else if (connectorType === 'microsoft_onedrive') {
        const client = new MicrosoftOneDriveClient(cp);
        await client.deregisterWebhook(subscriptionId);
      } else if (connectorType === 'microsoft_sharepoint') {
        const client = new MicrosoftSharePointClient(cp);
        await client.deregisterWebhook(subscriptionId);
      } else if (connectorType === 'box') {
        const client = new BoxClient(cp);
        await client.deregisterWebhook(subscriptionId);
      } else {
        return res.status(400).json({ error: `Webhook deregistration not supported for: ${connectorType}` });
      }

      res.status(204).end();
    } catch (err) {
      logger.error({ err }, 'DELETE /:connectorId/webhooks/:subscriptionId: error');
      next(err);
    }
  },
);

connectorCrudRouter.get(
  '/:connectorId/webhooks/signing-keys',
  async (req: Request, res: Response, next) => {
    try {
      const tenantId = getTenantId(req);
      if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });
      const { connectorId } = req.params;

      const connector = await connectorCrudService.getById(connectorId, tenantId);
      if (!connector) return res.status(404).json({ error: 'Connector not found' });
      if ((connector.type as string) !== 'box') {
        return res.status(400).json({ error: 'Signing keys are only available for Box connectors' });
      }

      const creds = await credentialService.getCredentials(tenantId, connectorId);
      const cp = async () => ({ accessToken: creds.accessToken ?? creds.apiKey ?? '', instanceUrl: creds.instanceUrl, connectorConfig: creds.connectorConfig });
      const client = new BoxClient(cp);
      const keys = await client.getWebhookSigningKeys();
      res.json(keys);
    } catch (err) {
      logger.error({ err }, 'GET /:connectorId/webhooks/signing-keys: error');
      next(err);
    }
  },
);

// ──────────────────────────────────────────────────────────────────────
// GET /:connectorId — single
// ──────────────────────────────────────────────────────────────────────

connectorCrudRouter.get(
  '/:connectorId',
  async (req: Request, res: Response) => {
    try {
      const tenantId = getTenantId(req);
      if (!tenantId) {
        return res.status(400).json({ error: 'tenantId is required' });
      }
      const { connectorId } = req.params;
      const connector = await connectorCrudService.getById(
        connectorId,
        tenantId,
      );
      if (!connector) {
        return res.status(404).json({ error: 'Connector not found' });
      }
      res.json(connector);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// ──────────────────────────────────────────────────────────────────────
// DELETE /:connectorId — soft-delete + revoke credentials + publish event
// ──────────────────────────────────────────────────────────────────────

connectorCrudRouter.delete(
  '/:connectorId',
  async (req: Request, res: Response) => {
    try {
      const tenantId = getTenantId(req);
      if (!tenantId) {
        return res.status(400).json({ error: 'tenantId is required' });
      }

      const { connectorId } = req.params;
      const existing = await connectorCrudService.getById(
        connectorId,
        tenantId,
      );
      if (!existing) {
        return res.status(404).json({ error: 'Connector not found' });
      }

      const disconnected = await connectorCrudService.disconnect(
        connectorId,
        tenantId,
      );
      if (!disconnected) {
        return res.status(404).json({ error: 'Connector not found' });
      }

      // Best-effort credential scrub. Failures are logged but do NOT
      // undo the soft-delete — the row already carries status='disconnected'
      // and a follow-on reconnect will overwrite the secret + credential row.
      if (existing.type === 'anchor_browser') {
        try {
          const { unregisterAnchorWebhook } = await import('../oauth/anchor-webhook-registration.js');
          const blob = await getConnectorCredential(tenantId, connectorId);
          const apiKey = blob?.apiKey;
          const webhookId = ((blob?.metadata as { extraFields?: { webhook_id?: string } })?.extraFields)?.webhook_id;
          if (apiKey && webhookId) await unregisterAnchorWebhook(apiKey, webhookId);
        } catch (err) {
          logger.warn(
            { err: (err as Error).message, tenantId, connectorId },
            'anchor webhook unregister failed on disconnect',
          );
        }
      }
      try {
        await credentialService.revokeCredentials(tenantId, connectorId);
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, tenantId, connectorId },
          'revoke credentials failed on disconnect',
        );
      }
      try {
        await deleteConnectorCredential(tenantId, connectorId);
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, tenantId, connectorId },
          'delete secret failed on disconnect',
        );
      }
      // A custom API keeps its description through a disconnect, which is what
      // lets a reconnect reuse the row rather than make a duplicate. The
      // verification stamp must not keep with it: the key it was made with was
      // revoked above, so the connection has nothing in custody and cannot go
      // on reporting that the provider accepted a key.
      if (existing.type === 'custom_api_connector') {
        try {
          await clearCustomApiVerification(tenantId, connectorId);
        } catch (err) {
          logger.warn(
            { err: (err as Error).message, tenantId, connectorId },
            'clear custom api verification failed on disconnect',
          );
        }
      }

      logAudit('connector.disconnected', getAccountId(req), {
        connectorId,
        connectorType: existing.type,
        tenantId,
      });

      // Publish to tenant runtime + subscribers.
      await publishEvent({
        entityType: 'connector',
        entityId: connectorId,
        eventType: 'connector.deleted',
        eventVersion: 1,
        tenantId,
        payload: { connectorType: existing.type },
      });

      res.status(204).send();
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// ──────────────────────────────────────────────────────────────────────
// PATCH /:connectorId/status — admin/ops status toggle
// ──────────────────────────────────────────────────────────────────────

connectorCrudRouter.patch(
  '/:connectorId/status',
  async (req: Request, res: Response) => {
    try {
      const tenantId = getTenantId(req);
      if (!tenantId) {
        return res.status(400).json({ error: 'tenantId is required' });
      }
      const { connectorId } = req.params;
      const { status } = (req.body ?? {}) as { status?: unknown };

      const validStatuses = new Set(['active', 'disabled', 'error']);
      if (typeof status !== 'string' || !validStatuses.has(status)) {
        return res.status(400).json({ error: 'Valid status is required' });
      }

      const existing = await connectorCrudService.getById(
        connectorId,
        tenantId,
      );
      if (!existing) {
        return res.status(404).json({ error: 'Connector not found' });
      }

      const updated = await connectorCrudService.updateStatus(
        connectorId,
        tenantId,
        status as 'active' | 'disabled' | 'error',
      );

      logAudit('connector.status_updated', getAccountId(req), {
        connectorId,
        oldStatus: existing.status,
        newStatus: status,
        tenantId,
      });

      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// ──────────────────────────────────────────────────────────────────────
// POST /:connectorId/sync/force — service-to-service re-harvest trigger
// Resets next_sync_at to now() so the scheduler's next tick (≤60 s)
// picks this connector up immediately (used by the harvest re-harvest job).
// verifyServiceAuth is applied at the app level (server.ts) before this
// router is mounted, so no per-route auth middleware is needed here.
// ──────────────────────────────────────────────────────────────────────

connectorCrudRouter.post(
  '/:connectorId/sync/force',
  async (req: Request, res: Response, next) => {
    const { connectorId } = req.params;

    try {
      const connector = await connectorCrudService.getByIdInternal(connectorId);
      if (!connector) {
        res.status(404).json({ error: 'Connector not found' });
        return;
      }
      if (connector.status !== 'active') {
        res.status(409).json({ error: 'Connector is not active' });
        return;
      }
      await enqueueImmediate(connectorId);
      res.status(202).json({ queued: true, connectorId });
    } catch (err) {
      next(err);
    }
  },
);

// POST /:connectorId/sync/backfill — resets last_sync_at to epoch so the next
// poll fetches full history for all entity types. Service-to-service only.
// Used by harvest-service's one-time historical backfill job.
// verifyServiceAuth is applied at the app level before this router is mounted.

connectorCrudRouter.post(
  '/:connectorId/sync/backfill',
  async (req: Request, res: Response, next) => {
    const { connectorId } = req.params;

    try {
      const connector = await connectorCrudService.getByIdInternal(connectorId);
      if (!connector) {
        res.status(404).json({ error: 'Connector not found' });
        return;
      }
      if (connector.status !== 'active') {
        res.status(409).json({ error: 'Connector is not active' });
        return;
      }
      await enqueueBackfill(connectorId);
      res.status(202).json({ queued: true, connectorId, mode: 'backfill' });
    } catch (err) {
      next(err);
    }
  },
);
