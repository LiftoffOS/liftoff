// Mailchimp Marketing API Client
// REST client for the Mailchimp Marketing API v3.
// Auth: HTTP Basic with anystring:<apikey>
// Data center extracted from API key suffix (e.g. "abc-us6" → dc "us6")

import {
  CompensationClient,
  CredentialProvider,
  ExternalRecord,
  CreateResult,
  UpdateResult,
  DeleteResult,
  ListFilters,
  ListResult,
} from './types.js';
import { logger } from '../infra/logging.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract the Mailchimp data center from an API key.
 * API keys have the format: <random>-<dc>   e.g. "abc123-us6"
 * Returns the suffix after the last hyphen.
 */
export function extractDataCenter(apiKey: string): string {
  const parts = apiKey.split('-');
  if (parts.length < 2) {
    throw new Error(
      `Invalid Mailchimp API key format — expected "<key>-<dc>", got: "${apiKey}"`
    );
  }
  return parts[parts.length - 1];
}

/**
 * Build a Base64-encoded Basic Auth header value.
 * Mailchimp accepts any username; convention is "anystring" or "key".
 */
export function buildBasicAuthHeader(apiKey: string): string {
  const credentials = `anystring:${apiKey}`;
  return `Basic ${Buffer.from(credentials).toString('base64')}`;
}

// ─── Credential shape for Mailchimp (API-key based) ──────────────────────────

/**
 * CredentialProvider for Mailchimp must return an accessToken that is the raw API key.
 * No OAuth refresh is needed — API keys do not expire.
 */

// ─── Client ──────────────────────────────────────────────────────────────────

export class MailchimpClient implements CompensationClient {
  readonly connector = 'mailchimp';
  private credentialProvider: CredentialProvider;

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  // ── Internal request helper ───────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const credentials = await this.credentialProvider();
    const apiKey = credentials.accessToken;
    const dc = extractDataCenter(apiKey);
    const baseUrl = `https://${dc}.api.mailchimp.com/3.0`;
    const url = `${baseUrl}${path}`;

    const headers: Record<string, string> = {
      Authorization: buildBasicAuthHeader(apiKey),
      'Content-Type': 'application/json',
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    // 429 rate limit — surface as a structured error so callers can retry
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After') ?? '60';
      throw new Error(
        `Mailchimp rate limit exceeded. Retry after ${retryAfter}s.`
      );
    }

    // 204 No Content (DELETE success)
    if (response.status === 204) {
      return {} as T;
    }

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Mailchimp API error', {
        status: response.status,
        path,
        method,
        error: errorText,
      });
      throw new Error(`Mailchimp API error ${response.status}: ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  // ── read ─────────────────────────────────────────────────────────────────

  async read(
    entityType: string,
    entityId: string | undefined,
    payload?: Record<string, unknown>
  ): Promise<ExternalRecord> {
    logger.info('Mailchimp read', { entityType, entityId });

    switch (entityType) {
      case 'campaign': {
        if (!entityId) throw new Error('campaign read requires entityId');
        const data = await this.request<Record<string, unknown>>(
          'GET',
          `/campaigns/${entityId}`
        );
        return {
          id: entityId,
          data,
          lastModified: data.create_time
            ? new Date(data.create_time as string)
            : undefined,
        };
      }

      case 'list_campaigns': {
        // List campaigns — payload may contain status, count, offset
        const params = new URLSearchParams();
        if (payload?.status) params.set('status', payload.status as string);
        if (payload?.count) params.set('count', String(payload.count));
        if (payload?.offset) params.set('offset', String(payload.offset));
        const qs = params.toString();
        const data = await this.request<Record<string, unknown>>(
          'GET',
          `/campaigns${qs ? '?' + qs : ''}`
        );
        return { id: 'list_campaigns', data };
      }

      case 'list_members': {
        // payload must contain listId
        const listId = (payload?.listId ?? payload?.list_id) as string | undefined;
        if (!listId) throw new Error('list_members read requires listId in payload');
        const params = new URLSearchParams();
        if (payload?.count) params.set('count', String(payload.count));
        if (payload?.offset) params.set('offset', String(payload.offset));
        if (payload?.status) params.set('status', payload.status as string);
        const qs = params.toString();
        const data = await this.request<Record<string, unknown>>(
          'GET',
          `/lists/${listId}/members${qs ? '?' + qs : ''}`
        );
        return { id: `list_members:${listId}`, data };
      }

      case 'report': {
        if (!entityId) throw new Error('report read requires entityId (campaign_id)');
        const data = await this.request<Record<string, unknown>>(
          'GET',
          `/reports/${entityId}`
        );
        return { id: entityId, data };
      }

      default:
        throw new Error(`Mailchimp: unsupported read entity type "${entityType}"`);
    }
  }

  /** Enumerate audiences (Mailchimp's "lists"), campaigns, or the members of an
   *  audience.
   *
   *  'audience' is the destination a team is usually being pointed at, so it is
   *  the one worth naming plainly; Mailchimp's own API calls it `/lists`, and
   *  both spellings are accepted here rather than making the caller know which
   *  vocabulary this vendor happens to use.
   *
   *  Members hang off an audience, so they need `filters.folderId` to say
   *  which. Missing it returns empty without the unsupported marker: the
   *  request was underspecified, the client is not lacking. */
  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const count = filters?.limit ?? 100;
    const offset = filters?.pageToken ? Number(filters.pageToken) : 0;
    const page = (total: number) =>
      offset + count < total ? String(offset + count) : undefined;

    const rows = (data: unknown[], idKey = 'id') =>
      data.map(row => {
        const r = row as Record<string, any>;
        return { id: String(r[idKey] ?? ''), data: r };
      });

    const params = new URLSearchParams({ count: String(count), offset: String(offset) });

    switch (entityType) {
      case 'audience':
      case 'audiences':
      case 'list':
      case 'lists': {
        const data = await this.request<Record<string, any>>('GET', `/lists?${params}`);
        const next = page(Number(data.total_items ?? 0));
        return { records: rows(data.lists ?? []), hasMore: !!next, nextPageToken: next };
      }

      case 'campaign':
      case 'campaigns': {
        const data = await this.request<Record<string, any>>('GET', `/campaigns?${params}`);
        const next = page(Number(data.total_items ?? 0));
        return { records: rows(data.campaigns ?? []), hasMore: !!next, nextPageToken: next };
      }

      case 'member':
      case 'members': {
        const listId = (filters as Record<string, unknown> | undefined)?.folderId as string | undefined;
        if (!listId) return { records: [], hasMore: false };
        const data = await this.request<Record<string, any>>(
          'GET',
          `/lists/${listId}/members?${params}`,
        );
        const next = page(Number(data.total_items ?? 0));
        return { records: rows(data.members ?? []), hasMore: !!next, nextPageToken: next };
      }

      default:
        return { records: [], hasMore: false, unsupported: true };
    }
  }

  // ── create ────────────────────────────────────────────────────────────────

  async create(
    entityType: string,
    data: Record<string, unknown>
  ): Promise<CreateResult> {
    logger.info('Mailchimp create', { entityType });

    try {
      switch (entityType) {
        case 'campaign': {
          // data must contain: type, settings (subject_line, from_name, reply_to, list_id)
          const result = await this.request<Record<string, unknown>>(
            'POST',
            '/campaigns',
            data
          );
          return {
            success: true,
            id: result.id as string,
            data: result,
          };
        }

        case 'send_campaign': {
          // Immediately send a campaign — campaign_id must be in data
          const campaignId = data.campaign_id as string;
          if (!campaignId) throw new Error('send_campaign requires campaign_id');
          await this.request<Record<string, unknown>>(
            'POST',
            `/campaigns/${campaignId}/actions/send`
          );
          return { success: true, id: campaignId };
        }

        case 'schedule_campaign': {
          // Schedule a campaign — campaign_id + schedule_time required
          const campaignId = data.campaign_id as string;
          if (!campaignId) throw new Error('schedule_campaign requires campaign_id');
          const scheduleData: Record<string, unknown> = {
            schedule_time: data.schedule_time,
          };
          if (data.timewarp !== undefined) scheduleData.timewarp = data.timewarp;
          await this.request<Record<string, unknown>>(
            'POST',
            `/campaigns/${campaignId}/actions/schedule`,
            scheduleData
          );
          return { success: true, id: campaignId };
        }

        case 'list_member': {
          // Add member to a list — listId must be in data
          const listId = (data.listId ?? data.list_id) as string;
          if (!listId) throw new Error('list_member create requires listId');
          const memberData = { ...data };
          delete memberData.listId;
          delete memberData.list_id;
          const result = await this.request<Record<string, unknown>>(
            'POST',
            `/lists/${listId}/members`,
            memberData
          );
          return {
            success: true,
            id: result.id as string,
            data: result,
          };
        }

        default:
          return {
            success: false,
            id: '',
            error: `Mailchimp: unsupported create entity type "${entityType}"`,
          };
      }
    } catch (error) {
      return {
        success: false,
        id: '',
        error: (error as Error).message,
      };
    }
  }

  // ── update ────────────────────────────────────────────────────────────────

  async update(
    entityType: string,
    entityId: string | undefined,
    data: Record<string, unknown>
  ): Promise<UpdateResult> {
    logger.info('Mailchimp update', { entityType, entityId });

    try {
      switch (entityType) {
        case 'campaign': {
          if (!entityId) throw new Error('campaign update requires entityId');
          const result = await this.request<Record<string, unknown>>(
            'PATCH',
            `/campaigns/${entityId}`,
            data
          );
          return { success: true, data: result };
        }

        case 'list_member': {
          // Update a list member — listId + email (used to build subscriber_hash) required
          const listId = (data.listId ?? data.list_id) as string;
          const email = (data.email_address ?? data.email) as string;
          if (!listId || !email) {
            throw new Error('list_member update requires listId and email_address');
          }
          const subscriberHash = this.md5Hash(email.toLowerCase());
          const updateData = { ...data };
          delete updateData.listId;
          delete updateData.list_id;
          delete updateData.email;
          const result = await this.request<Record<string, unknown>>(
            'PATCH',
            `/lists/${listId}/members/${subscriberHash}`,
            updateData
          );
          return { success: true, data: result };
        }

        default:
          return {
            success: false,
            error: `Mailchimp: unsupported update entity type "${entityType}"`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  // ── delete ────────────────────────────────────────────────────────────────

  async delete(
    entityType: string,
    entityId: string | undefined,
    payload?: Record<string, unknown>
  ): Promise<DeleteResult> {
    logger.info('Mailchimp delete', { entityType, entityId });

    try {
      switch (entityType) {
        case 'campaign': {
          if (!entityId) throw new Error('campaign delete requires entityId');
          await this.request<Record<string, unknown>>(
            'DELETE',
            `/campaigns/${entityId}`
          );
          return { success: true };
        }

        case 'list_member': {
          // Archive a list member — listId + email_address required
          const listId = (
            payload?.listId ?? payload?.list_id ?? entityId
          ) as string;
          const email = (
            payload?.email_address ?? payload?.email
          ) as string;
          if (!listId || !email) {
            throw new Error(
              'list_member delete requires listId and email_address in payload'
            );
          }
          const subscriberHash = this.md5Hash(email.toLowerCase());
          await this.request<Record<string, unknown>>(
            'DELETE',
            `/lists/${listId}/members/${subscriberHash}`
          );
          return { success: true };
        }

        default:
          return {
            success: false,
            error: `Mailchimp: unsupported delete entity type "${entityType}"`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  // ── Compensation ──────────────────────────────────────────────────────────

  async restore(
    entityType: string,
    entityId: string | undefined,
    snapshot: Record<string, unknown>
  ): Promise<UpdateResult> {
    logger.info('Mailchimp restore from snapshot', { entityType, entityId });
    if (entityType === 'campaign' && entityId) {
      return this.update('campaign', entityId, snapshot);
    }
    return {
      success: false,
      error: `Mailchimp restore not supported for entity type "${entityType}"`,
    };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string | undefined,
    originalResponse: Record<string, unknown>
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Mailchimp semantic inverse', {
      entityType,
      originalAction,
      entityId,
    });

    switch (originalAction) {
      case 'create':
        return this.delete(entityType, entityId || (originalResponse.id as string));
      case 'delete':
        return {
          success: false,
          error: 'Cannot restore a deleted/archived Mailchimp resource',
        };
      case 'update':
        return {
          success: false,
          error: 'Update reversal requires a pre-action snapshot',
        };
      default:
        return {
          success: false,
          error: `Unknown action type: ${originalAction}`,
        };
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Compute an MD5 hex digest of a string.
   * Used to build subscriber_hash for Mailchimp list member operations.
   * Node's built-in crypto is used to avoid adding a dependency.
   */
  private md5Hash(value: string): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const { createHash } = require('crypto') as typeof import('crypto');
    return createHash('md5').update(value).digest('hex');
  }
}
