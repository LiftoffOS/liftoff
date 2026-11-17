// Google Mail (Gmail) Connector Client
// Implements CompensationClient for send, reply, draft, forward, and delete operations

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
import { makeConnectorTransport, type HttpMethod } from './connector-transport.js';

// ── Gmail message decoding helpers ──────────────────────────────────────────

interface GmailPart {
  mimeType?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
}

// Walks the MIME part tree preferring text/plain, falling back to text/html.
// Gmail encodes all body content as base64url (RFC 4648 §5).
function decodeGmailBody(part: GmailPart | undefined): string | undefined {
  if (!part) return undefined;

  if (part.mimeType === 'text/plain' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64').toString('utf-8');
  }

  if (part.parts) {
    // Prefer text/plain within a multipart message
    for (const sub of part.parts) {
      if (sub.mimeType === 'text/plain') {
        const body = decodeGmailBody(sub);
        if (body) return body;
      }
    }
    // Fall back to text/html or recurse into nested multipart
    for (const sub of part.parts) {
      if (sub.mimeType === 'text/html' && sub.body?.data) {
        return Buffer.from(sub.body.data, 'base64').toString('utf-8');
      }
      const body = decodeGmailBody(sub);
      if (body) return body;
    }
  }

  // html at top level
  if (part.mimeType === 'text/html' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64').toString('utf-8');
  }

  return undefined;
}

function getGmailHeader(headers: Array<{ name: string; value: string }>, name: string): string | undefined {
  return headers.find(h => h.name === name)?.value;
}

function normalizeGmailMessage(msg: Record<string, unknown>): Record<string, unknown> {
  const payload = msg.payload as GmailPart | undefined;
  const headers: Array<{ name: string; value: string }> = payload?.headers ?? [];
  const labelIds = msg.labelIds as string[] | undefined;
  return {
    messageId: msg.id,
    threadId: msg.threadId,
    from: getGmailHeader(headers, 'From'),
    to: getGmailHeader(headers, 'To'),
    cc: getGmailHeader(headers, 'Cc'),
    subject: getGmailHeader(headers, 'Subject'),
    date: getGmailHeader(headers, 'Date'),
    inReplyTo: getGmailHeader(headers, 'In-Reply-To'),
    messageIdHeader: getGmailHeader(headers, 'Message-ID'),
    internalDate: msg.internalDate
      ? new Date(Number(msg.internalDate as string)).toISOString()
      : undefined,
    body: decodeGmailBody(payload),
    snippet: msg.snippet,
    isUnread: labelIds?.includes('UNREAD') ?? false,
    isStarred: labelIds?.includes('STARRED') ?? false,
    isImportant: labelIds?.includes('IMPORTANT') ?? false,
    isInbox: labelIds?.includes('INBOX') ?? false,
    hasAttachments: payload?.parts?.some(p => p.filename && p.body?.attachmentId) ?? false,
  };
}

// ────────────────────────────────────────────────────────────────────────────

/**
 * Build an RFC 2822 MIME message from structured fields and return it as a
 * base64url-encoded string suitable for the Gmail API `raw` field.
 */
function buildRawMessage(fields: {
  from?: string;
  to?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject?: string;
  body?: string;
  contentType?: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const lines: string[] = [];
  const mime = fields.contentType === 'html' ? 'text/html' : 'text/plain';

  if (fields.from) {
    lines.push(`From: ${fields.from}`);
  }
  if (fields.to) {
    const toList = Array.isArray(fields.to) ? fields.to.join(', ') : fields.to;
    lines.push(`To: ${toList}`);
  }
  if (fields.cc) {
    const ccList = Array.isArray(fields.cc) ? fields.cc.join(', ') : fields.cc;
    lines.push(`Cc: ${ccList}`);
  }
  if (fields.bcc) {
    const bccList = Array.isArray(fields.bcc) ? fields.bcc.join(', ') : fields.bcc;
    lines.push(`Bcc: ${bccList}`);
  }
  if (fields.subject) {
    lines.push(`Subject: ${fields.subject}`);
  }
  if (fields.inReplyTo) {
    lines.push(`In-Reply-To: ${fields.inReplyTo}`);
  }
  if (fields.references) {
    lines.push(`References: ${fields.references}`);
  }
  lines.push(`Content-Type: ${mime}; charset=UTF-8`);
  lines.push(''); // blank line separates headers from body
  lines.push(fields.body || '');

  const raw = lines.join('\r\n');
  // base64url encode (RFC 4648 §5)
  return Buffer.from(raw, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export class GoogleMailClient implements CompensationClient {
  readonly connector = 'google_mail';
  private credentialProvider: CredentialProvider;
  private baseUrl = 'https://www.googleapis.com/gmail/v1';

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, any>,
    options: { query?: Record<string, string> } = {}
  ): Promise<T> {
    // Always fetch fresh credentials per request — never cache. The provider
    // delegates to credentialService.getCredentials, which handles refresh.
    const credentials = await this.credentialProvider();

    // ONE transport, chosen once, from the credentials. This method used to
    // hold the choice itself — try the Composio proxy, else build a bearer
    // fetch — and that shape, repeated across 63 clients, is what let `list()`
    // sidestep it and send an empty bearer for an hour without anyone seeing.
    // The absolute vendor URL is passed because Composio's per-toolkit proxy
    // bases are inconsistent (gmail is a bare host, googledrive bakes in
    // `/drive/v3`), so only the absolute form is right across toolkits.
    const transport = makeConnectorTransport(credentials, this.connector);
    const response = await transport({
      method: method.toUpperCase() as HttpMethod,
      url: `${this.baseUrl}${path}`,
      body,
      query: options.query,
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('Gmail API error', { status: response.status, error, path });
      throw new Error(`Gmail API error: ${response.status} - ${error}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  // ── Read ────────────────────────────────────────────────────────────

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, any>): Promise<ExternalRecord> {
    logger.info('Gmail read', { entityType, entityId });

    switch (entityType) {
      case 'gmail_messages': {
        // Legacy entityType retained for any direct read('gmail_messages')
        // caller. The agent-facing `list_messages` tool now routes through
        // GoogleMailClient.list() via the adapter's useListMethod path; the
        // query handling there is the source of truth.
        const p = payload ?? {};
        const query: Record<string, string> = { maxResults: String(p.maxResults ?? 100) };
        if (p.labelIds) query.labelIds = (p.labelIds as string[]).join(',');
        if (p.pageToken) query.pageToken = String(p.pageToken);
        if (p.query) query.q = String(p.query);
        const result = await this.request<{ messages?: Array<Record<string, any>>; nextPageToken?: string }>(
          'GET', '/users/me/messages', undefined, { query }
        );
        return { id: 'gmail_messages', data: { messages: result.messages ?? [], nextPageToken: result.nextPageToken } };
      }

      case 'drafts': {
        const p = payload ?? {};
        const query: Record<string, string> = { maxResults: String(p.maxResults ?? 100) };
        const result = await this.request<{ drafts?: Array<Record<string, any>>; nextPageToken?: string }>(
          'GET', '/users/me/drafts', undefined, { query }
        );
        return { id: 'drafts', data: { drafts: result.drafts ?? [], nextPageToken: result.nextPageToken } };
      }

      case 'message': {
        if (!entityId) throw new Error('entityId required for message');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/users/me/messages/${entityId}`,
          undefined,
          { query: { format: 'full' } }
        );
        return {
          id: entityId,
          data: normalizeGmailMessage(data),
          versionToken: data.historyId as string | undefined,
          lastModified: data.internalDate ? new Date(Number(data.internalDate)) : undefined,
        };
      }

      case 'search': {
        // entityId is used as the search query when called via read
        const query = entityId ?? '';
        const data = await this.request<Record<string, any>>(
          'GET',
          '/users/me/messages',
          undefined,
          { query: { q: query, maxResults: '20' } }
        );
        return {
          id: 'search',
          data,
        };
      }

      case 'labels': {
        const data = await this.request<Record<string, any>>(
          'GET',
          '/users/me/labels'
        );
        return {
          id: 'labels',
          data,
        };
      }

      case 'thread': {
        if (!entityId) throw new Error('entityId required for thread');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/users/me/threads/${entityId}`,
          undefined,
          { query: { format: 'full' } }
        );
        const messages = ((data.messages ?? []) as Record<string, unknown>[]).map(normalizeGmailMessage);
        return {
          id: entityId,
          data: {
            threadId: data.id,
            snippet: data.snippet,
            messageCount: messages.length,
            messages, // oldest-first (Gmail API returns in chronological order)
          },
          versionToken: data.historyId as string | undefined,
        };
      }

      case 'label': {
        if (!entityId) throw new Error('entityId required for label');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/users/me/labels/${entityId}`
        );
        return {
          id: entityId,
          data,
        };
      }

      case 'draft': {
        if (!entityId) throw new Error('entityId required for draft');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/users/me/drafts/${entityId}`,
          undefined,
          { query: { format: 'full' } }
        );
        return {
          id: entityId,
          data,
        };
      }

      default:
        throw new Error(`Unsupported entity type: ${entityType}`);
    }
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    if (entityType !== 'Email') return { records: [], hasMore: false, unsupported: true };

    // Goes through `request()` — the SAME transport read/search/thread use —
    // rather than its own `fetch`. This method had its own, and that is the
    // whole defect: for a composio_managed connector `credentials.accessToken`
    // is deliberately the empty string (credentials/service.ts returns it with
    // "No usable bearer token: vendor clients route through
    // composio.tools.proxyExecute"), so the raw call sent `Authorization:
    // Bearer ` and Gmail answered 401 on EVERY poll.
    //
    // Nothing noticed for two reasons worth remembering. The read paths
    // proxied correctly, so an agent handed a thread could read it and only
    // being WOKEN was broken; and the 401 surfaced as a plain Error rather
    // than an OAuthRefreshError, so the connector never left `active` and the
    // Connections page went on showing it connected.
    const query: Record<string, string> = { maxResults: String(filters?.limit ?? 100) };

    const qParts: string[] = [];
    if (filters?.since) {
      qParts.push(`after:${Math.floor(filters.since.getTime() / 1000)}`);
    }
    if (filters?.q) qParts.push(`(${filters.q})`);
    if (qParts.length > 0) query.q = qParts.join(' ');

    if (filters?.pageToken) query.pageToken = filters.pageToken;

    const body = await this.request<{
      messages?: Array<{ id: string; threadId: string }>;
      nextPageToken?: string;
    }>('GET', '/users/me/messages', undefined, { query });

    return {
      records: (body.messages ?? []).map(m => ({ id: m.id, data: m as unknown as Record<string, unknown> })),
      nextPageToken: body.nextPageToken,
      hasMore: !!body.nextPageToken,
    };
  }

  // ── Create (send / draft / reply / forward) ────────────────────────

  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Gmail create', { entityType });

    try {
      switch (entityType) {
        // Send a new email immediately
        case 'message': {
          const raw = buildRawMessage(data);
          const payload: Record<string, any> = { raw };
          if (data.threadId) payload.threadId = data.threadId;

          const result = await this.request<{ id: string; threadId: string }>(
            'POST',
            '/users/me/messages/send',
            payload
          );

          return { success: true, id: result.id, data: result };
        }

        // Reply to an existing message (send immediately)
        case 'reply': {
          const raw = buildRawMessage({
            from: data.from,
            to: data.to,
            cc: data.cc,
            bcc: data.bcc,
            subject: data.subject,
            body: data.body,
            contentType: data.contentType,
            inReplyTo: data.inReplyTo || data.messageId,
            references: data.references || data.messageId,
          });
          const payload: Record<string, any> = { raw };
          if (data.threadId) payload.threadId = data.threadId;

          const result = await this.request<{ id: string; threadId: string }>(
            'POST',
            '/users/me/messages/send',
            payload
          );

          return { success: true, id: result.id, data: result };
        }

        // Forward an email (send immediately with forwarded content)
        case 'forward': {
          const raw = buildRawMessage({
            from: data.from,
            to: data.to,
            cc: data.cc,
            bcc: data.bcc,
            subject: data.subject,
            body: data.body,
            contentType: data.contentType,
          });
          const payload: Record<string, any> = { raw };
          if (data.threadId) payload.threadId = data.threadId;

          const result = await this.request<{ id: string; threadId: string }>(
            'POST',
            '/users/me/messages/send',
            payload
          );

          return { success: true, id: result.id, data: result };
        }

        // Create a draft (does NOT send)
        case 'draft': {
          const raw = buildRawMessage(data);
          const draftPayload: Record<string, any> = { message: { raw } };
          if (data.threadId) draftPayload.message.threadId = data.threadId;

          const result = await this.request<{ id: string; message: { id: string; threadId: string } }>(
            'POST',
            '/users/me/drafts',
            draftPayload
          );

          return { success: true, id: result.id, data: result };
        }

        // Create a label
        case 'label': {
          const result = await this.request<{ id: string; name: string }>(
            'POST',
            '/users/me/labels',
            {
              name: data.name,
              labelListVisibility: data.labelListVisibility || 'labelShow',
              messageListVisibility: data.messageListVisibility || 'show',
            }
          );

          return { success: true, id: result.id, data: result };
        }

        default:
          return { success: false, id: '', error: `Unsupported entity type: ${entityType}` };
      }
    } catch (error) {
      return { success: false, id: '', error: (error as Error).message };
    }
  }

  // ── Update (modify labels, update draft) ───────────────────────────

  async update(
    entityType: string,
    entityId: string,
    data: Record<string, any>
  ): Promise<UpdateResult> {
    logger.info('Gmail update', { entityType, entityId });

    try {
      switch (entityType) {
        case 'message': {
          // Modify message labels
          const result = await this.request<{ id: string; labelIds: string[] }>(
            'POST',
            `/users/me/messages/${entityId}/modify`,
            {
              addLabelIds: data.addLabelIds || [],
              removeLabelIds: data.removeLabelIds || [],
            }
          );

          return { success: true, data: result };
        }

        case 'draft': {
          const raw = buildRawMessage(data);
          const draftPayload: Record<string, any> = { message: { raw } };
          if (data.threadId) draftPayload.message.threadId = data.threadId;

          const result = await this.request<{ id: string }>(
            'PUT',
            `/users/me/drafts/${entityId}`,
            draftPayload
          );

          return { success: true, data: result };
        }

        case 'label': {
          const result = await this.request<{ id: string }>(
            'PATCH',
            `/users/me/labels/${entityId}`,
            data
          );

          return { success: true, data: result };
        }

        default:
          return { success: false, error: `Unsupported entity type: ${entityType}` };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  // ── Delete (trash message, delete draft/label) ─────────────────────

  async delete(entityType: string, entityId: string): Promise<DeleteResult> {
    logger.info('Gmail delete', { entityType, entityId });

    try {
      switch (entityType) {
        case 'message': {
          // Trash (not permanent delete) — recoverable and safer
          await this.request<Record<string, any>>(
            'POST',
            `/users/me/messages/${entityId}/trash`
          );
          return { success: true };
        }

        case 'draft': {
          await this.request<void>(
            'DELETE',
            `/users/me/drafts/${entityId}`
          );
          return { success: true };
        }

        case 'label': {
          await this.request<void>(
            'DELETE',
            `/users/me/labels/${entityId}`
          );
          return { success: true };
        }

        default:
          return { success: false, error: `Unsupported entity type: ${entityType}` };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  // ── Restore from snapshot ──────────────────────────────────────────

  async restore(
    entityType: string,
    entityId: string,
    snapshot: Record<string, any>
  ): Promise<UpdateResult> {
    logger.info('Gmail restore from snapshot', { entityType, entityId });

    if (entityType === 'message') {
      // Restore label state from snapshot
      const currentLabels: string[] = snapshot.currentLabelIds || [];
      const snapshotLabels: string[] = snapshot.labelIds || [];
      const addLabelIds = snapshotLabels.filter((l: string) => !currentLabels.includes(l));
      const removeLabelIds = currentLabels.filter((l: string) => !snapshotLabels.includes(l));

      return this.update('message', entityId, { addLabelIds, removeLabelIds });
    }

    if (entityType === 'message_trashed') {
      // Untrash a trashed message
      const result = await this.request<Record<string, any>>(
        'POST',
        `/users/me/messages/${entityId}/untrash`
      );
      return { success: true, data: result };
    }

    return {
      success: false,
      error: `Cannot restore Gmail ${entityType}`,
    };
  }

  // ── Semantic inverse ───────────────────────────────────────────────

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string,
    originalResponse: Record<string, any>
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Gmail semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        if (entityType === 'message' || entityType === 'reply' || entityType === 'forward') {
          const id = originalResponse.id || entityId;
          return this.delete('message', id);
        }
        if (entityType === 'draft') {
          const id = originalResponse.id || entityId;
          return this.delete('draft', id);
        }
        if (entityType === 'label') {
          const id = originalResponse.id || entityId;
          return this.delete('label', id);
        }
        break;

      case 'delete':
        if (entityType === 'message') {
          return this.restore('message_trashed', entityId, {});
        }
        return {
          success: false,
          error: 'Cannot restore permanently deleted Gmail items',
        };

      case 'update':
        return {
          success: false,
          error: 'Update reversal requires pre-action snapshot',
        };

      default:
        return {
          success: false,
          error: `Cannot reverse Gmail action: ${originalAction}`,
        };
    }

    return { success: false, error: 'Unknown entity type' };
  }

  /**
   * WS-9.2 — arm Gmail users.watch for this mailbox. Watch expires every
   * 7 days (re-armed every 12h via the gmail-watch-rearm cron). The watch
   * publishes history-id notifications to the supplied Pub/Sub topic;
   * tenant-runtime receives those via Pub/Sub push, fetches new messages
   * via users.history.list, normalizes, and republishes to
   * connector-events-{env}.
   *
   * The Gmail variant of this signature reinterprets the third param as
   * the Pub/Sub topic name (`projects/{project}/topics/{topic}`) — the
   * caller (tenant-runtime's armGmailWatchFor) knows its own GCP project
   * trivially; connector-service is shared / tenant-agnostic and must
   * not guess. The `GMAIL_WATCH_TOPIC` env var remains as a fallback so
   * legacy single-tenant deployments keep working without a TR-side
   * code change.
   */
  async registerWebhook(
    externalId: string,
    _channelToken: string,
    topicNameOrUrl: string,
  ): Promise<{ subscriptionId: string; expirationMs: number; historyId: string }> {
    const topicName =
      topicNameOrUrl && topicNameOrUrl.startsWith('projects/')
        ? topicNameOrUrl
        : process.env.GMAIL_WATCH_TOPIC;
    if (!topicName) {
      throw new Error(
        'Gmail registerWebhook: no Pub/Sub topic resolved (caller must pass `projects/{project}/topics/{topic}` ' +
          'or GMAIL_WATCH_TOPIC must be set)',
      );
    }
    const resp = await this.request<{ historyId?: string; expiration?: string }>(
      'POST',
      `/users/${encodeURIComponent(externalId || 'me')}/watch`,
      { topicName, labelIds: ['INBOX'] },
    );
    return {
      subscriptionId: `${externalId || 'me'}:${resp.historyId ?? ''}`,
      expirationMs: Number(resp.expiration ?? 0),
      historyId: String(resp.historyId ?? ''),
    };
  }

  /**
   * WS-9.2 — fetch every Message added since `startHistoryId`. Backs the
   * tenant-runtime Gmail push receiver: each notification gives us only the
   * "something changed" signal; this method enumerates the deltas and
   * returns normalized envelopes ready for republish to connector-events.
   */
  async getHistorySince(
    startHistoryId: string,
  ): Promise<{ messages: Array<{ id: string; normalized: unknown }>; nextHistoryId: string }> {
    const historyResp = await this.request<{
      history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>;
      historyId?: string | number;
    }>(
      'GET',
      `/users/me/history`,
      undefined,
      { query: { startHistoryId, historyTypes: 'messageAdded' } },
    );
    const adds = (historyResp.history ?? []).flatMap((h) => h.messagesAdded ?? []);
    const out: Array<{ id: string; normalized: unknown }> = [];
    for (const a of adds) {
      try {
        const full = await this.request<Record<string, unknown>>(
          'GET',
          `/users/me/messages/${encodeURIComponent(a.message.id)}`,
        );
        out.push({ id: a.message.id, normalized: full });
      } catch {
        // Skip individual fetch failures; the push handler will see them
        // on the next notification when Gmail's history pointer advances.
      }
    }
    return {
      messages: out,
      nextHistoryId: String(historyResp.historyId ?? startHistoryId),
    };
  }
}
