// Slack Connector Client
// Per Section 11 & 12: Real Slack API implementation

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
import { tryComposioProxy, bearerFor } from './composio-transport.js';

// Slack API response type
interface SlackApiResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export class SlackClient implements CompensationClient {
  readonly connector = 'slack';
  private credentialProvider: CredentialProvider;
  private baseUrl = 'https://slack.com/api';

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private async request<T>(method: string, data?: Record<string, any>): Promise<T> {
    // Always fetch fresh credentials per request — never cache. The provider
    // delegates to credentialService.getCredentials, which handles refresh.
    const credentials = await this.credentialProvider();

    // composio_managed routing — see clients/composio-transport.ts.
    // Slack's API uses method names as paths (e.g., conversations.list);
    // pass as `/${method}` for Composio's proxy.
    const composio = await tryComposioProxy<T>(credentials, {
      method: 'POST',
      path: `/${method}`,
      body: data,
    });
    if (composio.handled) {
      const result = composio.data as unknown as SlackApiResponse;
      if (!result.ok) {
        logger.error('Slack API error (composio proxy)', { method, error: result.error });
        throw new Error(`Slack API error: ${result.error}`);
      }
      return result as T;
    }

    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearerFor(credentials, 'slack')}`,
        'Content-Type': 'application/json',
      },
      body: data ? JSON.stringify(data) : undefined,
    });

    const result = await response.json() as SlackApiResponse;

    if (!result.ok) {
      logger.error('Slack API error', { method, error: result.error });
      throw new Error(`Slack API error: ${result.error}`);
    }

    return result as T;
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, any>): Promise<ExternalRecord> {
    logger.info('Slack read', { entityType, entityId });

    switch (entityType) {
      case 'channels': {
        const p = payload ?? {};
        const params: Record<string, unknown> = { limit: p.limit ?? 100 };
        if (p.cursor) params.cursor = p.cursor;
        if (p.types) params.types = p.types;
        const result = await this.request<{
          ok: boolean;
          channels: Array<Record<string, any>>;
          response_metadata?: { next_cursor?: string };
        }>('conversations.list', params);
        return {
          id: 'channels',
          data: { channels: result.channels, nextPageToken: result.response_metadata?.next_cursor },
        };
      }

      case 'messages': {
        const p = payload ?? {};
        const channel = p.channel as string | undefined;
        if (!channel) throw new Error('channel is required for list_messages');
        const params: Record<string, unknown> = { channel, limit: p.limit ?? 50 };
        if (p.cursor) params.cursor = p.cursor;
        if (p.oldest) params.oldest = p.oldest;
        if (p.latest) params.latest = p.latest;
        const result = await this.request<{
          ok: boolean;
          messages: Array<Record<string, any>>;
          response_metadata?: { next_cursor?: string };
        }>('conversations.history', params);
        return {
          id: 'messages',
          data: { messages: result.messages, nextPageToken: result.response_metadata?.next_cursor },
        };
      }

      case 'message': {
        // entityId format: "channel:timestamp"
        if (!entityId) throw new Error('entityId required for message read');
        const [channel, ts] = entityId.split(':');
        const result = await this.request<{
          ok: boolean;
          messages: Array<Record<string, any>>;
        }>('conversations.history', {
          channel,
          latest: ts,
          inclusive: true,
          limit: 1,
        });

        const message = result.messages?.[0];
        if (!message) {
          throw new Error('Message not found');
        }

        return {
          id: entityId,
          data: message,
          versionToken: message.ts,
          lastModified: new Date(parseFloat(message.ts) * 1000),
        };
      }

      case 'channel': {
        if (!entityId) throw new Error('entityId required for channel read');
        const result = await this.request<{
          ok: boolean;
          channel: Record<string, any>;
        }>('conversations.info', { channel: entityId });

        return {
          id: entityId,
          data: result.channel,
        };
      }

      case 'thread': {
        // entityId format: "channelId:messageTs"
        if (!entityId) throw new Error('entityId required for thread read');
        const [channel, ts] = entityId.split(':');
        const result = await this.request<{
          ok: boolean;
          messages: Array<Record<string, any>>;
        }>('conversations.replies', { channel, ts });

        const messages = result.messages ?? [];
        return {
          id: entityId,
          data: {
            channel,
            ts,
            messageCount: messages.length,
            messages: messages.map((m: Record<string, any>) => ({
              ts: m.ts,
              userId: m.user,
              text: m.text,
              isThreadRoot: m.ts === ts,
              reactions: m.reactions,
              replyCount: m.reply_count,
              timestamp: new Date(parseFloat(m.ts as string) * 1000).toISOString(),
            })),
          },
          versionToken: messages.length > 0 ? messages[messages.length - 1].ts : undefined,
        };
      }

      default:
        throw new Error(`Unsupported entity type: ${entityType}`);
    }
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    // Channels are what a person picks when a team is told where to post. The
    // call already existed for the tool surface (`read('channels')`); `list`
    // just never offered it, so a channel picker was told the workspace had
    // none. Excludes archived channels: a team cannot post to one, so offering
    // it would only produce a destination that fails later.
    if (entityType === 'channel' || entityType === 'channels') {
      const params: Record<string, unknown> = {
        limit: filters?.limit ?? 200,
        exclude_archived: true,
        types: 'public_channel,private_channel',
      };
      if (filters?.pageToken) params.cursor = filters.pageToken;

      const result = await this.request<{
        ok: boolean;
        channels?: Array<Record<string, any>>;
        response_metadata?: { next_cursor?: string };
      }>('conversations.list', params);

      const cursor = result.response_metadata?.next_cursor || undefined;
      return {
        records: (result.channels ?? []).map(c => ({
          id: String(c.id ?? ''),
          data: c,
        })),
        hasMore: !!cursor,
        nextPageToken: cursor,
      };
    }

    if (entityType !== 'Message') return { records: [], hasMore: false, unsupported: true };
    const oldest = filters?.since
      ? String(filters.since.getTime() / 1000)
      : undefined;
    const params: Record<string, unknown> = { limit: filters?.limit ?? 100 };
    if (oldest) params.oldest = oldest;
    if (filters?.pageToken) params.cursor = filters.pageToken;
    // List from the general channel if no specific channel; Slack requires a channel.
    // Callers that need cross-channel polling should iterate channels separately.
    const result = await this.request<{
      ok: boolean;
      messages?: Array<Record<string, unknown>>;
      response_metadata?: { next_cursor?: string };
    }>('conversations.history', params);
    const nextCursor = result.response_metadata?.next_cursor;
    return {
      records: (result.messages ?? []).map(m => ({
        id: String(m['ts']),
        data: m,
        lastModified: m['ts'] ? new Date(parseFloat(m['ts'] as string) * 1000) : undefined,
      })),
      nextPageToken: nextCursor || undefined,
      hasMore: !!nextCursor,
    };
  }

  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Slack create', { entityType });

    try {
      switch (entityType) {
        case 'message': {
          const result = await this.request<{
            ok: boolean;
            ts: string;
            channel: string;
          }>('chat.postMessage', data);

          return {
            success: true,
            id: `${result.channel}:${result.ts}`,
            data: { ts: result.ts, channel: result.channel },
          };
        }

        case 'channel': {
          const result = await this.request<{
            ok: boolean;
            channel: { id: string };
          }>('conversations.create', data);

          return {
            success: true,
            id: result.channel.id,
            data: result.channel,
          };
        }

        default:
          return {
            success: false,
            id: '',
            error: `Unsupported entity type: ${entityType}`,
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

  async update(
    entityType: string,
    entityId: string,
    data: Record<string, any>
  ): Promise<UpdateResult> {
    logger.info('Slack update', { entityType, entityId });

    try {
      switch (entityType) {
        case 'message': {
          const [channel, ts] = entityId.split(':');
          const result = await this.request<{
            ok: boolean;
            ts: string;
          }>('chat.update', {
            channel,
            ts,
            ...data,
          });

          return {
            success: true,
            versionToken: result.ts,
          };
        }

        case 'channel': {
          // Rename channel
          if (data.name) {
            await this.request<{ ok: boolean }>('conversations.rename', {
              channel: entityId,
              name: data.name,
            });
          }

          // Set topic
          if (data.topic) {
            await this.request<{ ok: boolean }>('conversations.setTopic', {
              channel: entityId,
              topic: data.topic,
            });
          }

          // Set purpose
          if (data.purpose) {
            await this.request<{ ok: boolean }>('conversations.setPurpose', {
              channel: entityId,
              purpose: data.purpose,
            });
          }

          return { success: true };
        }

        default:
          return {
            success: false,
            error: `Unsupported entity type: ${entityType}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async delete(entityType: string, entityId: string): Promise<DeleteResult> {
    logger.info('Slack delete', { entityType, entityId });

    try {
      switch (entityType) {
        case 'message': {
          const [channel, ts] = entityId.split(':');
          await this.request<{ ok: boolean }>('chat.delete', { channel, ts });
          return { success: true };
        }

        case 'channel': {
          await this.request<{ ok: boolean }>('conversations.archive', {
            channel: entityId,
          });
          return { success: true };
        }

        default:
          return {
            success: false,
            error: `Unsupported entity type: ${entityType}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async restore(
    entityType: string,
    entityId: string,
    snapshot: Record<string, any>
  ): Promise<UpdateResult> {
    logger.info('Slack restore from snapshot', { entityType, entityId });

    // For messages, restore means updating to previous text
    if (entityType === 'message') {
      return this.update(entityType, entityId, {
        text: snapshot.text,
        blocks: snapshot.blocks,
      });
    }

    return {
      success: false,
      error: `Cannot restore Slack ${entityType}`,
    };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string,
    originalResponse: Record<string, any>
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Slack semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'send':
      case 'create':
        if (entityType === 'message') {
          // Delete the sent message
          const id = entityId || `${originalResponse.channel}:${originalResponse.ts}`;
          return this.delete('message', id);
        }
        if (entityType === 'channel') {
          // Archive the created channel
          return this.delete('channel', entityId || originalResponse.channel?.id);
        }
        break;

      case 'archive':
        // Unarchive
        try {
          await this.request<{ ok: boolean }>('conversations.unarchive', {
            channel: entityId,
          });
          return { success: true };
        } catch (error) {
          return { success: false, error: (error as Error).message };
        }

      default:
        return {
          success: false,
          error: `Cannot reverse Slack action: ${originalAction}`,
        };
    }

    return { success: false, error: 'Unknown entity type' };
  }
}
