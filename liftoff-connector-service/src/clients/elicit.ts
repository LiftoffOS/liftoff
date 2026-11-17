// Elicit Connector Client (native, first-party).
//
// Elicit is an AI research assistant. This client wraps Elicit's REST API
// (https://elicit.com/api/v1) so the tool-gateway can dispatch the
// ELICIT_FUNCTIONS tool set. Auth is a user-supplied API key (`elk_live_...`,
// Pro plan) sent as `Authorization: Bearer`. The key is persisted to
// connector.config by the api-key connect flow (apikey-router, no composioField
// → direct vault) and read here as connectorConfig.apiKey.
//
// entityType routing (set on each ConnectorFunction in connector-functions-registry):
//   papers              → POST /search               (search_papers, read-op)
//   trials              → POST /search/trials        (search_clinical_trials, read-op)
//   report              → POST /reports              (create_report, create-op)
//                       → GET  /reports/{reportId}   (get_report, read-op)
//   reports             → GET  /reports              (list_reports, read-op)
//   systematic_review   → POST /systematic-reviews             (create_systematic_review, create-op)
//                       → GET  /systematic-reviews/{reviewId}  (get_systematic_review, read-op)
//   systematic_reviews  → GET  /systematic-reviews             (list_systematic_reviews, read-op)
//
// Reports + systematic reviews are asynchronous: create returns an id + status
// 'processing'; the agent polls get_report / get_systematic_review until
// status is 'completed'. Nothing here is destructive — Elicit exposes no delete.

import {
  CompensationClient,
  CredentialProvider,
  ConnectorCredentials,
  ExternalRecord,
  CreateResult,
  UpdateResult,
  DeleteResult,
  ListFilters,
  ListResult,
} from './types.js';
import { logger } from '../infra/logging.js';

const ELICIT_BASE_URL = 'https://elicit.com';

export class ElicitClient implements CompensationClient {
  readonly connector = 'elicit';
  private credentialProvider: CredentialProvider;

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    query?: Record<string, string>,
  ): Promise<T> {
    const c: ConnectorCredentials = await this.credentialProvider();
    const apiKey = String(
      (c.connectorConfig?.apiKey as string | undefined) ?? c.accessToken ?? '',
    ).trim();
    if (!apiKey) throw new Error('Elicit credential missing API key (connectorConfig.apiKey)');

    const q = query && Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : '';
    const res = await fetch(`${ELICIT_BASE_URL}${path}${q}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error('Elicit API error', { status: res.status, path, method });
      throw new Error(`Elicit API ${res.status}: ${text}`);
    }
    return res.status === 204 ? ({} as T) : (res.json() as Promise<T>);
  }

  /** Build a query-string map from a payload, keeping only defined scalar values. */
  private static pickQuery(payload: Record<string, unknown>, keys: string[]): Record<string, string> {
    const q: Record<string, string> = {};
    for (const k of keys) {
      const v = payload[k];
      if (v !== undefined && v !== null && v !== '') q[k] = String(v);
    }
    return q;
  }

  /** Build a request body from a payload, keeping only defined values for the given keys. */
  private static pickBody(payload: Record<string, unknown>, keys: string[]): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    for (const k of keys) {
      if (payload[k] !== undefined) body[k] = payload[k];
    }
    return body;
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<ExternalRecord> {
    const p = payload ?? {};
    switch (entityType) {
      case 'papers': {
        const data = await this.request<Record<string, unknown>>(
          'POST', '/api/v1/search',
          ElicitClient.pickBody(p, ['query', 'searchMode', 'maxResults', 'corpus', 'filters']),
        );
        return { id: 'search', data };
      }
      case 'trials': {
        const data = await this.request<Record<string, unknown>>(
          'POST', '/api/v1/search/trials',
          ElicitClient.pickBody(p, ['query', 'searchMode', 'maxResults', 'trialFilters']),
        );
        return { id: 'search', data };
      }
      case 'report': {
        const reportId = String((p.reportId as string | undefined) ?? entityId ?? '');
        if (!reportId) throw new Error('Elicit get_report: reportId is required');
        const data = await this.request<Record<string, unknown>>(
          'GET', `/api/v1/reports/${encodeURIComponent(reportId)}`,
          undefined, ElicitClient.pickQuery(p, ['include']),
        );
        return { id: reportId, data };
      }
      case 'reports': {
        const data = await this.request<Record<string, unknown>>(
          'GET', '/api/v1/reports',
          undefined, ElicitClient.pickQuery(p, ['limit', 'cursor', 'source', 'status']),
        );
        return { id: 'reports', data };
      }
      case 'systematic_review': {
        const reviewId = String((p.reviewId as string | undefined) ?? entityId ?? '');
        if (!reviewId) throw new Error('Elicit get_systematic_review: reviewId is required');
        const data = await this.request<Record<string, unknown>>(
          'GET', `/api/v1/systematic-reviews/${encodeURIComponent(reviewId)}`,
          undefined, ElicitClient.pickQuery(p, ['include']),
        );
        return { id: reviewId, data };
      }
      case 'systematic_reviews': {
        const data = await this.request<Record<string, unknown>>(
          'GET', '/api/v1/systematic-reviews',
          undefined, ElicitClient.pickQuery(p, ['limit', 'cursor', 'source', 'status']),
        );
        return { id: 'systematic_reviews', data };
      }
      default:
        throw new Error(`Elicit: unsupported read entityType "${entityType}"`);
    }
  }

  /** No reactive polling for Elicit — required by ConnectorClient but unused. */
  /** Enumerate the saved artefacts in an Elicit account: reports and systematic
   *  reviews.
   *
   *  Papers and trials are deliberately NOT listed here. Those endpoints are
   *  searches: they take a query and return matches, so there is no "everything
   *  in the account" to enumerate, and answering with the results of an empty
   *  query would be inventing a collection that does not exist. A caller asking
   *  for them is told this client cannot enumerate them, which is true, rather
   *  than being handed an empty list that reads as "you have no papers". */
  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const query: Record<string, string> = { limit: String(filters?.limit ?? 100) };
    if (filters?.pageToken) query.cursor = filters.pageToken;

    let path: string;
    switch (entityType) {
      case 'report':
      case 'reports':
        path = '/api/v1/reports';
        break;
      case 'systematic_review':
      case 'systematic_reviews':
        path = '/api/v1/systematic-reviews';
        break;
      default:
        return { records: [], hasMore: false, unsupported: true };
    }

    const data = await this.request<Record<string, any>>('GET', path, undefined, query);
    const rows: unknown[] = Array.isArray(data)
      ? data
      : (Object.values(data).find(Array.isArray) as unknown[]) ?? [];
    const cursor = (data.nextCursor ?? data.next_cursor) as string | undefined;

    return {
      records: rows.map(row => {
        const r = row as Record<string, any>;
        return { id: String(r.id ?? r.reviewId ?? r.reportId ?? ''), data: r };
      }),
      hasMore: !!cursor,
      nextPageToken: cursor,
    };
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    try {
      switch (entityType) {
        case 'report': {
          const result = await this.request<{ reportId?: string } & Record<string, unknown>>(
            'POST', '/api/v1/reports',
            ElicitClient.pickBody(data, ['researchQuestion', 'title', 'maxSearchPapers', 'maxExtractPapers', 'isPublic']),
          );
          return { success: true, id: String(result?.reportId ?? ''), data: result };
        }
        case 'systematic_review': {
          const result = await this.request<{ reviewId?: string } & Record<string, unknown>>(
            'POST', '/api/v1/systematic-reviews',
            ElicitClient.pickBody(data, ['researchQuestion', 'protocolDetails', 'searches', 'abstractScreening', 'fulltextScreening', 'extraction', 'generateReport', 'title', 'isPublic']),
          );
          return { success: true, id: String(result?.reviewId ?? ''), data: result };
        }
        default:
          return { success: false, id: '', error: `Elicit: unsupported create entityType "${entityType}"` };
      }
    } catch (error) {
      return { success: false, id: '', error: (error as Error).message };
    }
  }

  async update(entityType: string, _entityId: string | undefined, _data: Record<string, unknown>): Promise<UpdateResult> {
    return { success: false, error: `Elicit: update not supported for "${entityType}"` };
  }

  async delete(entityType: string, _entityId: string | undefined, _payload?: Record<string, unknown>): Promise<DeleteResult> {
    return { success: false, error: `Elicit: delete not supported for "${entityType}"` };
  }

  // Compensation is a no-op for Elicit: it has no destructive/mutating tools to
  // undo (searches are read-only; report/review creation is not reversible via API).
  async restore(entityType: string, _entityId: string | undefined, _snapshot: Record<string, unknown>): Promise<UpdateResult> {
    return { success: false, error: `Elicit: restore not supported for "${entityType}"` };
  }

  async semanticInverse(entityType: string, originalAction: string, _entityId: string | undefined, _originalResponse: Record<string, unknown>): Promise<DeleteResult | UpdateResult> {
    return { success: false, error: `Elicit: cannot invert ${originalAction} on "${entityType}"` };
  }
}
