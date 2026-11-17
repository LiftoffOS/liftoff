// Gong Connector Client
//
// Gong is a composio_managed connector: its OAuth grant is held by Composio
// (getCredentials returns accessToken: '' + connectorConfig.composioConnectedAccountId),
// so every REST call routes through Composio's tools.proxyExecute via
// tryComposioProxy — identical to the Jira/Atlassian client. Composio knows the
// connected account's toolkit base (api.gong.io) so we pass bare Gong API paths
// (e.g. /v2/calls) and Composio resolves the host.
//
// Reactive use: Gong exposes NO Composio trigger (verified against Composio's
// /api/v3/triggers_types — 0 results), so the reactive path is polling. The
// scheduler calls list('Call', { since }) on its interval; each call is
// normalized (src/normalizers/gong.normalizer.ts) and published like any other
// polled record. NOTE: the polling buildClient must supply connectorConfig in
// the credential object for tryComposioProxy to engage (see scheduler.ts).
//
// Gong Calls API: GET /v2/calls?fromDateTime&toDateTime[&cursor]
//   → { requestId, records: { cursor? }, calls: [ { id, started, title, ... } ] }
// Cursor pagination: records.cursor on the response is passed back as ?cursor.

import {
  CompensationClient,
  CredentialProvider,
  CreateResult,
  UpdateResult,
  DeleteResult,
  ExternalRecord,
  ListFilters,
  ListResult,
} from './types.js';
import { logger } from '../infra/logging.js';
import { tryComposioProxy } from './composio-transport.js';

interface GongCall {
  id?: string;
  url?: string;
  title?: string;
  scheduled?: string;
  started?: string;
  duration?: number;
  primaryUserId?: string;
  direction?: string;
  system?: string;
  scope?: string;
  language?: string;
  workspaceId?: string;
  meetingUrl?: string;
}

interface GongCallsResponse {
  requestId?: string;
  records?: { cursor?: string; totalRecords?: number };
  calls?: GongCall[];
}

export class GongClient implements CompensationClient {
  readonly connector = 'gong';

  constructor(private readonly credentialProvider: CredentialProvider) {}

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    path: string,
    queryParams?: Record<string, string>,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const credentials = await this.credentialProvider();

    // composio_managed routing — Composio resolves the gong toolkit base
    // (api.gong.io) from the connected account, so pass the bare path.
    const composio = await tryComposioProxy<T>(credentials, {
      method,
      path,
      body,
      query: queryParams,
    });
    if (composio.handled) return composio.data;

    // Gong has no usable bearer token outside Composio (composio_managed auth),
    // so there is no direct-fetch fallback. If the proxy did not engage, the
    // caller did not supply connectorConfig.composioConnectedAccountId.
    throw new Error(
      'Gong requires Composio proxy routing, but no composioConnectedAccountId ' +
        'was present on the credentials. Ensure the polling credential provider ' +
        'forwards connectorConfig for composio_managed connectors.',
    );
  }

  /**
   * list('Call', { since }) — incremental pull of Gong calls.
   *
   * fromDateTime defaults to the last 24h when no `since` is supplied (first
   * sync). Gong requires ISO-8601 with offset; Date.toISOString() (…Z) is
   * accepted. Cursor pagination via response.records.cursor.
   */
  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    if (entityType !== 'Call') return { records: [], hasMore: false, unsupported: true };

    const fromDateTime = (filters?.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000)).toISOString();
    const query: Record<string, string> = { fromDateTime };
    if (filters?.pageToken) query.cursor = filters.pageToken;

    const result = await this.request<GongCallsResponse>('GET', '/v2/calls', query);
    const calls = result.calls ?? [];
    const nextCursor = result.records?.cursor;

    return {
      records: calls
        .filter((c) => c.id !== undefined && c.id !== null)
        .map((c) => ({ id: String(c.id), data: c as unknown as Record<string, unknown> })),
      nextPageToken: nextCursor,
      hasMore: Boolean(nextCursor),
    };
  }

  /**
   * read('Call', id) — fetch a single call's metadata. Tool-call reads for
   * Gong normally flow through Composio MCP; this exists for interface
   * completeness and the connector-service execute path.
   */
  async read(
    entityType: string,
    entityId: string | undefined,
    payload?: Record<string, any>,
  ): Promise<ExternalRecord> {
    const id = entityId ?? (payload?.id as string | undefined);
    if (entityType !== 'Call' || !id) {
      throw new Error(`Gong read: unsupported entityType "${entityType}" or missing id`);
    }
    const result = await this.request<GongCallsResponse>('GET', '/v2/calls', { 'filter[callIds]': id });
    const call = (result.calls ?? [])[0];
    if (!call) throw new Error(`Gong read: call ${id} not found`);
    return { id, data: call as unknown as Record<string, unknown> };
  }

  // Gong is read-only call intelligence — no write operations.
  async create(entityType: string): Promise<CreateResult> {
    logger.warn({ entityType }, 'Gong create() not supported (read-only connector)');
    return { success: false, id: '', error: 'Gong does not support create' };
  }

  async update(
    entityType: string,
    _entityId: string | undefined,
    _data: Record<string, any>,
  ): Promise<UpdateResult> {
    logger.warn({ entityType }, 'Gong update() not supported (read-only connector)');
    return { success: false, error: 'Gong does not support update' };
  }

  async delete(
    entityType: string,
    _entityId: string | undefined,
    _payload?: Record<string, any>,
  ): Promise<DeleteResult> {
    logger.warn({ entityType }, 'Gong delete() not supported (read-only connector)');
    return { success: false, error: 'Gong does not support delete' };
  }

  // ── CompensationClient — snapshot / inverse (no-ops for a read-only source) ──
  async restore(
    entityType: string,
    _entityId: string | undefined,
    _snapshot: Record<string, any>,
  ): Promise<UpdateResult> {
    logger.warn({ entityType }, 'Gong restore() not supported (read-only connector)');
    return { success: false, error: 'Gong does not support restore' };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    _entityId: string | undefined,
    _originalResponse: Record<string, any>,
  ): Promise<DeleteResult | UpdateResult> {
    logger.warn({ entityType, originalAction }, 'Gong semanticInverse() not supported (read-only)');
    return { success: false, error: 'Gong is read-only; no inverse for ' + originalAction };
  }
}
