// Microsoft Outlook Mail Connector Client
// Per Section 11 & 12: Microsoft Graph API implementation for Mail

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
import { OAuthRefreshError } from '../credentials/service.js';
import { tryComposioProxy, bearerFor } from './composio-transport.js';

/**
 * Microsoft Graph signals "this token cannot perform this operation, reconnect
 * with new scopes" via 403 + ErrorAccessDenied with body language like
 * "insufficient privileges" or via OAuth-style `insufficient_scope`. We detect
 * either shape and surface it through the codebase's standard reconnect-required
 * channel (OAuthRefreshError → isReconnectRequiredOAuthError → job error =
 * 'reconnect_required'), which the frontend already renders as a reconnect
 * prompt. Avoids needing a new ConnectorStatus enum value or DB write path.
 */
function isInsufficientScope(status: number, body: string): boolean {
  if (status !== 403) return false;
  const lower = body.toLowerCase();
  return (
    lower.includes('insufficient_scope') ||
    lower.includes('insufficient privileges') ||
    lower.includes('erroraccessdenied')
  );
}

// ── Outlook message normalisation ────────────────────────────────────────────
// Graph API returns body.content as a decoded plain-text or HTML string —
// no base64 decoding required (unlike Gmail's MIME payload encoding).

interface OutlookEmailAddress {
  emailAddress?: { address?: string; name?: string };
}

function normalizeOutlookMessage(msg: Record<string, unknown>): Record<string, unknown> {
  const from = msg.from as OutlookEmailAddress | undefined;
  const toRecipients = (msg.toRecipients as OutlookEmailAddress[] | undefined) ?? [];
  const ccRecipients = (msg.ccRecipients as OutlookEmailAddress[] | undefined) ?? [];
  const body = msg.body as { content?: string; contentType?: string } | undefined;
  return {
    messageId: msg.id,
    conversationId: msg.conversationId,
    subject: msg.subject,
    from: from?.emailAddress?.address,
    fromName: from?.emailAddress?.name,
    to: toRecipients.map(r => r.emailAddress?.address).filter(Boolean).join(', '),
    cc: ccRecipients.map(r => r.emailAddress?.address).filter(Boolean).join(', '),
    receivedAt: msg.receivedDateTime,
    body: body?.content,        // decoded plain text or HTML — no base64
    bodyType: body?.contentType,
    isRead: msg.isRead,
    hasAttachments: msg.hasAttachments,
    changeKey: msg.changeKey,
  };
}

// ────────────────────────────────────────────────────────────────────────────

export class MicrosoftOutlookMailClient implements CompensationClient {
  readonly connector = 'microsoft_outlook_mail';
  private credentialProvider: CredentialProvider;
  private baseUrl = 'https://graph.microsoft.com/v1.0';

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

    // composio_managed routing — see clients/composio-transport.ts.
    // Composio's Outlook toolkit base is https://graph.microsoft.com;
    // prepend /v1.0 to match our direct baseUrl path-portion.
    const composio = await tryComposioProxy<T>(credentials, {
      method: method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
      path: `/v1.0${path}`,
      body,
      query: options.query,
    });
    if (composio.handled) return composio.data;

    let url = `${this.baseUrl}${path}`;

    if (options.query) {
      const params = new URLSearchParams(options.query);
      url += `?${params.toString()}`;
    }

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${bearerFor(credentials, 'microsoft_outlook_mail')}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('Microsoft Outlook Mail API error', { status: response.status, error, path });
      if (isInsufficientScope(response.status, error) && credentials.tenantId && credentials.connectorId) {
        throw new OAuthRefreshError(
          'reconnect_required',
          `Microsoft Outlook Mail 403 insufficient scope on ${path}: ${error}`,
          {
            tenantId: credentials.tenantId,
            connectorId: credentials.connectorId,
            vendor: 'microsoft_outlook_mail',
          },
        );
      }
      throw new Error(`Microsoft Outlook Mail API error: ${response.status} - ${error}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  private mailboxRoot(from?: string): string {
    return from ? `/users/${encodeURIComponent(from)}` : '/me';
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, any>): Promise<ExternalRecord> {
    logger.info('Microsoft Outlook Mail read', { entityType, entityId });

    switch (entityType) {
      case 'mail_messages': {
        const p = payload ?? {};
        const folderId = p.folderId as string | undefined;
        const path = folderId ? `/me/mailFolders/${folderId}/messages` : '/me/messages';
        const query: Record<string, string> = { $top: String(p.pageSize ?? p.top ?? 50) };
        if (p.filter) query.$filter = String(p.filter);
        if (p.skip) query.$skip = String(p.skip);
        const result = await this.request<{ value: Array<Record<string, any>>; '@odata.nextLink'?: string }>(
          'GET', path, undefined, { query }
        );
        return { id: 'mail_messages', data: { messages: result.value, nextPageToken: result['@odata.nextLink'] } };
      }

      case 'mail_drafts': {
        const p = payload ?? {};
        const top = p.top ?? 50;
        const skipQs = p.skip ? `&$skip=${p.skip}` : '';
        const result = await this.request<{ value: Array<Record<string, any>>; '@odata.nextLink'?: string }>(
          'GET',
          `/me/messages?$filter=isDraft eq true&$top=${top}${skipQs}`,
        );
        return {
          id: 'mail_drafts',
          data: { messages: result.value ?? [], hasMore: !!result['@odata.nextLink'] },
        };
      }

      case 'mail_folders': {
        const result = await this.request<{ value: Array<Record<string, any>> }>('GET', '/me/mailFolders');
        return { id: 'mail_folders', data: { folders: result.value } };
      }

      case 'draft':
      case 'message': {
        if (!entityId) throw new Error('entityId required for message');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/me/messages/${entityId}`,
          undefined,
          { query: { $select: 'id,conversationId,subject,body,from,toRecipients,ccRecipients,receivedDateTime,isRead,hasAttachments,changeKey' } }
        );
        return {
          id: entityId,
          data: normalizeOutlookMessage(data),
          versionToken: data.changeKey,
          lastModified: data.lastModifiedDateTime ? new Date(data.lastModifiedDateTime) : undefined,
        };
      }

      case 'conversation': {
        if (!entityId) throw new Error('entityId required for conversation');
        // Fetch all messages sharing the same conversationId, oldest-first
        const data = await this.request<{ value: Array<Record<string, any>> }>(
          'GET',
          '/me/messages',
          undefined,
          {
            query: {
              $filter: `conversationId eq '${entityId}'`,
              $orderby: 'receivedDateTime asc',
              $select: 'id,conversationId,subject,body,from,toRecipients,ccRecipients,receivedDateTime,isRead,hasAttachments',
              $top: '50',
            },
          }
        );
        const messages = (data.value ?? []).map(normalizeOutlookMessage);
        return {
          id: entityId,
          data: {
            conversationId: entityId,
            messageCount: messages.length,
            messages,
          },
        };
      }

      case 'search': {
        if (!entityId) throw new Error('entityId required for search');
        // entityId is the search query string (mirrors Gmail search tool pattern)
        const data = await this.request<{ value: Array<Record<string, any>> }>(
          'GET',
          '/me/messages',
          undefined,
          {
            query: {
              $search: `"${entityId}"`,
              $select: 'id,conversationId,subject,body,from,toRecipients,ccRecipients,receivedDateTime,isRead,hasAttachments',
              $top: '20',
            },
          }
        );
        return {
          id: 'search',
          data: { messages: (data.value ?? []).map(normalizeOutlookMessage) },
        };
      }

      case 'mailFolder': {
        if (!entityId) throw new Error('entityId required for mailFolder');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/me/mailFolders/${entityId}`
        );
        return {
          id: entityId,
          data,
          lastModified: undefined,
        };
      }

      default:
        throw new Error(`Unsupported entity type: ${entityType}`);
    }
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    if (entityType !== 'Email') return { records: [], hasMore: false, unsupported: true };

    // Compose $filter from `since` (receivedDateTime ge ISO) AND caller `q`.
    const filterParts: string[] = [];
    if (filters?.since) filterParts.push(`receivedDateTime ge ${filters.since.toISOString()}`);
    if (filters?.q) filterParts.push(`(${filters.q})`);

    const result = await this.listMessages({
      pageSize: filters?.limit ?? 100,
      skipToken: filters?.pageToken,
      filter: filterParts.length > 0 ? filterParts.join(' and ') : undefined,
    });

    return {
      records: (result.value ?? []).map(m => ({ id: m.id as string, data: m })),
      nextPageToken: result['@odata.nextLink'],
      hasMore: !!result['@odata.nextLink'],
    };
  }

  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Microsoft Outlook Mail create', { entityType });

    const toArray = (val: unknown): string[] => {
      if (!val) return [];
      return Array.isArray(val) ? (val as string[]) : [val as string];
    };

    try {
      switch (entityType) {
        case 'message': {
          // Send immediately via /me/sendMail (POST returns 202, no body)
          await this.request<void>(
            'POST',
            `${this.mailboxRoot(data.from)}/sendMail`,
            {
              message: {
                subject: data.subject,
                body: { contentType: data.contentType ?? 'Text', content: data.body },
                toRecipients: toArray(data.to).map((addr: string) => ({ emailAddress: { address: addr } })),
                ccRecipients: toArray(data.cc).map((addr: string) => ({ emailAddress: { address: addr } })),
              },
              saveToSentItems: true,
            }
          );
          return { success: true, id: '', data: {} };
        }

        case 'reply': {
          // Send reply immediately to the given messageId
          const messageId = (data.messageId ?? data.id) as string;
          await this.request<void>(
            'POST',
            `${this.mailboxRoot(data.from)}/messages/${messageId}/reply`,
            {
              message: {
                body: { contentType: data.contentType ?? 'Text', content: data.body },
                ...(data.to ? { toRecipients: toArray(data.to).map((addr: string) => ({ emailAddress: { address: addr } })) } : {}),
              },
            }
          );
          return { success: true, id: messageId, data: {} };
        }

        case 'reply_draft': {
          // Create a draft reply without sending — two-step: createReply then PATCH body
          const messageId = (data.messageId ?? data.id) as string;
          const root = this.mailboxRoot(data.from);
          const draft = await this.request<{ id: string }>(
            'POST',
            `${root}/messages/${messageId}/createReply`,
            {}
          );
          if (data.body) {
            await this.request<void>(
              'PATCH',
              `${root}/messages/${draft.id}`,
              { body: { contentType: data.contentType ?? 'Text', content: data.body } }
            );
          }
          return { success: true, id: draft.id, data: draft };
        }

        case 'draft': {
          // Create a new draft (not a reply)
          const result = await this.request<{ id: string }>(
            'POST',
            `${this.mailboxRoot(data.from)}/messages`,
            {
              subject: data.subject,
              body: { contentType: data.contentType ?? 'Text', content: data.body },
              toRecipients: toArray(data.to).map((addr: string) => ({ emailAddress: { address: addr } })),
              ccRecipients: toArray(data.cc).map((addr: string) => ({ emailAddress: { address: addr } })),
            }
          );
          return { success: true, id: result.id, data: result };
        }

        case 'mailFolder': {
          const result = await this.request<{ id: string }>(
            'POST',
            '/me/mailFolders',
            { displayName: data.displayName }
          );
          return { success: true, id: result.id, data: result };
        }

        case 'forward': {
          const messageId = (data.messageId ?? data.id) as string;
          await this.request<void>(
            'POST',
            `${this.mailboxRoot(data.from)}/messages/${messageId}/forward`,
            {
              comment: data.body ?? '',
              toRecipients: toArray(data.to).map((addr: string) => ({ emailAddress: { address: addr } })),
            }
          );
          return { success: true, id: messageId, data: {} };
        }

        default:
          return { success: false, id: '', error: `Unsupported entity type: ${entityType}` };
      }
    } catch (error) {
      // OAuthRefreshError must propagate so the job runner can surface
      // 'reconnect_required' through the existing error path. Swallowing it
      // here would hide the signal behind a generic { success: false }.
      if (error instanceof OAuthRefreshError) throw error;
      return { success: false, id: '', error: (error as Error).message };
    }
  }

  async update(
    entityType: string,
    entityId: string,
    data: Record<string, any>
  ): Promise<UpdateResult> {
    logger.info('Microsoft Outlook Mail update', { entityType, entityId });

    try {
      switch (entityType) {
        case 'draft':
        case 'message': {
          const result = await this.request<{ changeKey: string }>(
            'PATCH',
            `/me/messages/${entityId}`,
            data
          );
          return { success: true, versionToken: result.changeKey, data: result };
        }

        default:
          return { success: false, error: `Unsupported entity type: ${entityType}` };
      }
    } catch (error) {
      if (error instanceof OAuthRefreshError) throw error;
      return { success: false, error: (error as Error).message };
    }
  }

  async delete(entityType: string, entityId: string): Promise<DeleteResult> {
    logger.info('Microsoft Outlook Mail delete', { entityType, entityId });

    try {
      switch (entityType) {
        case 'draft':
        case 'message':
        case 'reply_draft': {
          await this.request<void>('DELETE', `/me/messages/${entityId}`);
          return { success: true };
        }

        case 'mailFolder': {
          await this.request<void>('DELETE', `/me/mailFolders/${entityId}`);
          return { success: true };
        }

        default:
          return { success: false, error: `Unsupported entity type: ${entityType}` };
      }
    } catch (error) {
      if (error instanceof OAuthRefreshError) throw error;
      return { success: false, error: (error as Error).message };
    }
  }

  async restore(
    entityType: string,
    entityId: string,
    snapshot: Record<string, any>
  ): Promise<UpdateResult> {
    logger.info('Microsoft Outlook Mail restore from snapshot', { entityType, entityId });

    if (entityType === 'message') {
      return this.update(entityType, entityId, snapshot);
    }

    return { success: false, error: `Cannot restore Microsoft Outlook Mail ${entityType}` };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string,
    originalResponse: Record<string, any>
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Microsoft Outlook Mail semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        if (['message', 'draft', 'reply_draft', 'mailFolder'].includes(entityType)) {
          const id = (originalResponse.id as string | undefined) || entityId;
          return this.delete(entityType === 'reply_draft' ? 'reply_draft' : entityType === 'mailFolder' ? 'mailFolder' : 'message', id);
        }
        // reply sends immediately — cannot unsend
        if (entityType === 'reply') {
          return { success: false, error: 'Cannot unsend a sent reply' };
        }
        if (entityType === 'forward') {
          return { success: false, error: 'Cannot unsend a sent forward' };
        }
        break;

      case 'delete':
        return { success: false, error: 'Cannot restore deleted mail items without backup' };

      case 'update':
        return { success: false, error: 'Update reversal requires pre-action snapshot' };

      default:
        return { success: false, error: `Cannot reverse Microsoft Outlook Mail action: ${originalAction}` };
    }

    return { success: false, error: 'Unknown entity type' };
  }

  // Utility method used by polling/scheduler (not exposed as a tool)
  async listMessages(options: {
    folderId?: string;
    pageSize?: number;
    skipToken?: string;
    filter?: string;
  } = {}): Promise<{ value: Array<Record<string, any>>; '@odata.nextLink'?: string }> {
    const folderId = options.folderId || 'inbox';
    const query: Record<string, string> = {
      $top: (options.pageSize || 50).toString(),
    };

    if (options.filter) {
      query.$filter = options.filter;
    }

    if (options.skipToken) {
      query.$skiptoken = options.skipToken;
    }

    return this.request<{ value: Array<Record<string, any>>; '@odata.nextLink'?: string }>(
      'GET',
      `/me/mailFolders/${folderId}/messages`,
      undefined,
      { query }
    );
  }
}
