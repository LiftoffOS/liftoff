// Intercom client (Composio-backed). Intercom is composio_managed: agent tool
// calls go through the Composio MCP dispatch path. This structured client serves
// two non-MCP surfaces:
//   1. CRUD router help-center browse/read — list('collection'|'article'),
//      read('article', id) — via the structured Composio actions (which work).
//   2. Reactive scheduler polling — list('Conversation') — via the Composio
//      HTTP PROXY (raw GET /conversations), NOT the structured action.
//
// Why the proxy for conversations: Composio's INTERCOM_LIST_CONVERSATIONS /
// INTERCOM_SEARCH_CONVERSATIONS *actions* fail server-side pydantic validation
// (their ConversationSummary model requires `source` to be a dict, but Intercom
// legitimately returns source:null) — verified against a live account. The
// proxy returns the raw Intercom response untouched (status 200, native shape),
// so it sidesteps Composio's over-strict response model. Composio holds the
// OAuth token; we pass only the connectedAccountId and Composio signs upstream.

import {
  CompensationClient, ExternalRecord, CreateResult, UpdateResult, DeleteResult,
  ListFilters, ListResult,
} from './types.js';
import { getComposio, composioProxyRequest } from '../oauth/composio-client.js';
import { logger } from '../infra/logging.js';

export interface IntercomComposioClientConfig {
  tenantId: string;
  // Composio connected-account id (from connector.config.composioConnectedAccountId).
  connectedAccountId: string;
}

const LIST_ARTICLES_TOOL = 'INTERCOM_LIST_ALL_ARTICLES';
const LIST_COLLECTIONS_TOOL = 'INTERCOM_LIST_ALL_COLLECTIONS';
const RETRIEVE_ARTICLE_TOOL = 'INTERCOM_RETRIEVE_AN_ARTICLE';
const CONVERSATIONS_PER_PAGE = 150;

// Composio wraps the Intercom API response in { successful, data, error }. The
// Intercom list shape is { type: 'list', data: [...] }, so the records live at
// resp.data.data (with a defensive fallback to resp.data when already an array).
function extractList(respData: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(respData)) return respData as Array<Record<string, unknown>>;
  if (respData && typeof respData === 'object') {
    const inner = (respData as { data?: unknown }).data;
    if (Array.isArray(inner)) return inner as Array<Record<string, unknown>>;
  }
  return [];
}

// INTERCOM_LIST_CONVERSATIONS returns { type:'conversation.list', conversations:[...] }.
// Fall back to the generic { data:[...] } / array shapes defensively.
function extractConversations(respData: unknown): Array<Record<string, unknown>> {
  if (respData && typeof respData === 'object') {
    const conv = (respData as { conversations?: unknown }).conversations;
    if (Array.isArray(conv)) return conv as Array<Record<string, unknown>>;
  }
  return extractList(respData);
}

export class IntercomComposioClient implements CompensationClient {
  readonly connector = 'intercom';
  private readonly tenantId: string;
  private readonly connectedAccountId: string;

  constructor(config: IntercomComposioClientConfig) {
    this.tenantId = config.tenantId;
    this.connectedAccountId = config.connectedAccountId;
  }

  private async exec(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const resp = await getComposio().tools.execute(tool, {
      userId: this.tenantId,
      connectedAccountId: this.connectedAccountId,
      arguments: args,
      dangerouslySkipVersionCheck: true,
    });
    if (resp.successful === false) {
      throw new Error(resp.error || `${tool} returned successful=false`);
    }
    return resp.data;
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    try {
      // Reactive scheduler polling (catalog entityType 'Conversation'). Single
      // page per cycle; the scheduler's lastSyncAt window + version dedup
      // (updated_at) handle incrementality — the Datadog pattern. Uses the
      // Composio PROXY (raw GET /conversations) because the structured
      // INTERCOM_LIST_CONVERSATIONS action fails Composio's pydantic validation
      // on source:null. Raw Intercom conversation objects pass through;
      // IntercomNormalizer maps type:'conversation' → Conversation natively.
      if (entityType === 'Conversation') {
        const sinceMs = filters?.since instanceof Date ? filters.since.getTime() : 0;
        const data = await composioProxyRequest<unknown>({
          connectedAccountId: this.connectedAccountId,
          method: 'GET',
          endpoint: '/conversations',
          queryParams: { per_page: CONVERSATIONS_PER_PAGE },
          headers: { 'Intercom-Version': '2.11' },
        });
        const items = extractConversations(data);
        const records: ExternalRecord[] = items
          .filter((c) => {
            const u = Number(c.updated_at ?? c.created_at ?? 0);
            return !sinceMs || u * 1000 >= sinceMs;
          })
          .map((c) => ({ id: String(c.id ?? ''), data: c }));
        return { records, hasMore: false };
      }
      if (entityType === 'article') {
        const items = extractList(await this.exec(LIST_ARTICLES_TOOL, {}));
        const records: ExternalRecord[] = items.map((a) => ({
          id: String(a.id ?? ''),
          data: { ...a, title: a.title ?? '', url: a.url ?? null, contentType: 'article' },
        }));
        return { records, hasMore: false };
      }
      // default: collection browse
      const items = extractList(await this.exec(LIST_COLLECTIONS_TOOL, {}));
      const records: ExternalRecord[] = items.map((c) => ({
        id: String(c.id ?? ''),
        data: { ...c, title: c.name ?? c.title ?? '', url: c.url ?? null, contentType: 'collection' },
      }));
      return { records, hasMore: false };
    } catch (err) {
      logger.warn('Intercom Composio list failed', {
        entityType, tenantId: this.tenantId, error: (err as Error).message,
      });
      throw err;
    }
  }

  async read(entityType: string, externalId: string): Promise<ExternalRecord> {
    if (entityType !== 'article') {
      throw new Error(`IntercomComposioClient.read supports 'article' only, got '${entityType}'`);
    }
    const data = await this.exec(RETRIEVE_ARTICLE_TOOL, { id: Number(externalId) });
    const a = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    return {
      id: String(a.id ?? externalId),
      data: { ...a, title: a.title ?? '', body: a.body ?? '' },
    };
  }

  async create(): Promise<CreateResult> {
    return { success: false, id: '', error: 'intercom help-center is read-only via this client' };
  }
  async update(): Promise<UpdateResult> {
    return { success: false, error: 'intercom help-center is read-only via this client' };
  }
  async delete(): Promise<DeleteResult> {
    return { success: false, error: 'intercom help-center is read-only via this client' };
  }
  async restore(): Promise<UpdateResult> {
    return { success: false, error: 'not supported' };
  }
  async semanticInverse(): Promise<DeleteResult> {
    return { success: false, data: { error: 'not supported' } } as DeleteResult;
  }
}
