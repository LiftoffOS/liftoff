// Microsoft Teams Connector Client
// Per Section 11 & 12: Microsoft Graph API implementation for Teams

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

// Graph constrains channel-message collections far more tightly than the rest
// of the API, and violating either rule is a hard 400 rather than a silent
// clamp:
//
//   $top     — "Maximum allowed $top value is 50."
//   $orderby — NOT SUPPORTED AT ALL. GET /teams/{id}/channels/{id}/messages
//              accepts only $top (plus @odata.nextLink paging); any $orderby is
//              "Query option 'OrderBy' is not allowed" — a 400, in EITHER
//              direction. Ordering/filtering by lastModifiedDateTime exists only
//              on the different aggregate endpoint /teams/{id}/channels/getAllMessages.
//              (api-reference/v1.0/api/channel-list-messages — its only documented
//              query parameter is $top.)
//
// The endpoint already returns newest-first by createdDateTime, which is all the
// callers here need: the read path reverses locally to oldest-first, and the
// reactive poll filters client-side by a `since` watermark (order-independent).
//
// HISTORY: an earlier fix mistook this for an ascending-only restriction and
// switched the queries from `$orderby=… asc` to `… desc`, believing descending
// was allowed. It is not — the desc form 400'd every Teams poll just the same
// (first seen on the first real production connection). This is why there is no
// $orderby anywhere below.
//
// The $top clamp matters because polling/scheduler.ts hands every connector
// `limit: 100`, which is fine for the ~40 connectors whose vendors allow it and
// fatal here. Clamping lives in this client rather than in the scheduler on
// purpose: 50 is a property of Graph, not of the scheduler, and the scheduler
// fans out to every connector. Same shape as the Math.min guards in
// woocommerce.ts and asana.ts.
const GRAPH_MESSAGES_MAX_TOP = 50;

function messagesTop(requested?: number): number {
  if (!Number.isFinite(requested) || (requested as number) <= 0) return GRAPH_MESSAGES_MAX_TOP;
  return Math.min(requested as number, GRAPH_MESSAGES_MAX_TOP);
}

// request() throws Error(`Microsoft Teams API error: ${status} - ${body}`); pull
// the numeric status back out so a caller can branch on it (skip a 403 channel)
// without introducing a second error type.
function statusFromError(err: unknown): number | undefined {
  const m = /Microsoft Teams API error: (\d{3})\b/.exec((err as Error)?.message ?? '');
  return m ? Number(m[1]) : undefined;
}

export class MicrosoftTeamsClient implements CompensationClient {
  readonly connector = 'microsoft_teams';
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
    let url = `${this.baseUrl}${path}`;

    if (options.query) {
      const params = new URLSearchParams(options.query);
      url += `?${params.toString()}`;
    }

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('Microsoft Teams API error', { status: response.status, error, path });
      throw new Error(`Microsoft Teams API error: ${response.status} - ${error}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, any>): Promise<ExternalRecord> {
    logger.info('Microsoft Teams read', { entityType, entityId });

    switch (entityType) {
      case 'teams': {
        const result = await this.request<{ value: Array<Record<string, any>> }>('GET', '/me/joinedTeams');
        return { id: 'teams', data: { teams: result.value } };
      }

      case 'team_channels': {
        const p = payload ?? {};
        const teamId = p.teamId as string | undefined;
        if (!teamId) throw new Error('teamId required for list_channels');
        const result = await this.request<{ value: Array<Record<string, any>> }>('GET', `/teams/${teamId}/channels`);
        return { id: 'team_channels', data: { channels: result.value } };
      }

      case 'team_messages': {
        const p = payload ?? {};
        const teamId = p.teamId as string | undefined;
        const channelId = p.channelId as string | undefined;
        if (!teamId || !channelId) throw new Error('teamId and channelId required for list_messages');
        const result = await this.request<{ value: Array<Record<string, any>> }>(
          'GET', `/teams/${teamId}/channels/${channelId}/messages`,
          undefined, { query: { $top: String(messagesTop(p.pageSize as number | undefined)) } }
        );
        return { id: 'team_messages', data: { messages: result.value } };
      }

      case 'team': {
        if (!entityId) throw new Error('entityId required for team');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/teams/${entityId}`
        );
        return {
          id: entityId,
          data,
          lastModified: undefined,
        };
      }

      case 'channel': {
        if (!entityId) throw new Error('entityId required for channel');
        const [teamId, channelId] = entityId.split(':');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/teams/${teamId}/channels/${channelId}`
        );
        return {
          id: entityId,
          data,
          lastModified: undefined,
        };
      }

      case 'message': {
        if (!entityId) throw new Error('entityId required for message');
        const [teamId, channelId, messageId] = entityId.split(':');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/teams/${teamId}/channels/${channelId}/messages/${messageId}`
        );
        return {
          id: entityId,
          data,
          lastModified: data.lastModifiedDateTime ? new Date(data.lastModifiedDateTime) : undefined,
        };
      }

      case 'messages': {
        if (!entityId) throw new Error('entityId required for messages');
        // entityId format: "teamId:channelId"
        const [teamId, channelId] = entityId.split(':');
        // Channel messages accept no $orderby at all (see the note on
        // GRAPH_MESSAGES_MAX_TOP); the endpoint already returns newest-first by
        // createdDateTime, so reverse locally to keep this read's oldest-first
        // contract, which is what a caller rendering a thread expects.
        const data = await this.request<{ value: Record<string, any>[] }>(
          'GET',
          `/teams/${teamId}/channels/${channelId}/messages?$top=${GRAPH_MESSAGES_MAX_TOP}`
        );
        const messages = (data.value ?? []).slice().reverse();
        return {
          id: entityId,
          data: {
            teamId,
            channelId,
            messageCount: messages.length,
            messages,
          },
        };
      }

      case 'thread': {
        if (!entityId) throw new Error('entityId required for thread');
        // entityId format: "teamId:channelId:messageId"
        const [teamId, channelId, messageId] = entityId.split(':');
        const data = await this.request<{ value: Record<string, any>[] }>(
          'GET',
          `/teams/${teamId}/channels/${channelId}/messages/${messageId}/replies`
        );
        const replies = data.value ?? [];
        return {
          id: entityId,
          data: {
            teamId,
            channelId,
            messageId,
            replyCount: replies.length,
            replies,
          },
        };
      }

      default:
        throw new Error(`Unsupported entity type: ${entityType}`);
    }
  }

  // Reactive polling. The scheduler calls list('Message') with the capitalized
  // polling entityType + an incremental `since` watermark. Microsoft Graph has
  // no global "all channel messages" endpoint and no $filter on channel
  // messages, so this fans out joinedTeams -> channels -> recent messages and
  // filters client-side by lastModifiedDateTime/createdDateTime >= since. Each
  // message is stamped with teamId/channelId. Requires ChannelMessage.Read.All.
  // Fan-out aggregates in one cycle (hasMore:false); the scheduler dedups by
  // version (lastModifiedDateTime), so re-fetched-but-unchanged messages drop.
  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    // Channels across every team the account belongs to, for picking where a
    // team posts. Graph has no cross-team channel endpoint, so this walks
    // joinedTeams — the same walk the Message path below already does, stopping
    // one level earlier.
    //
    // Ids are "{teamId}/{channelId}" because a channel id alone does not
    // identify a channel in Graph: posting needs both. Titles carry the team
    // name for the same reason a person needs it — "General" appears in every
    // team and is meaningless on its own.
    if (entityType === 'channel' || entityType === 'channels') {
      const teams = await this.request<{ value: Array<Record<string, any>> }>('GET', '/me/joinedTeams');
      const records: Array<{ id: string; data: Record<string, any> }> = [];

      for (const team of teams.value ?? []) {
        const teamId = team.id as string;
        const channels = await this.request<{ value: Array<Record<string, any>> }>(
          'GET',
          `/teams/${teamId}/channels`,
        );
        for (const channel of channels.value ?? []) {
          records.push({
            id: `${teamId}/${channel.id}`,
            data: {
              ...channel,
              teamId,
              teamName: team.displayName,
              displayName: `${team.displayName} / ${channel.displayName}`,
            },
          });
        }
      }

      return { records, hasMore: false };
    }

    if (entityType !== 'Message') return { records: [], hasMore: false, unsupported: true };
    const since = filters?.since instanceof Date ? filters.since.getTime() : 0;
    const records: Array<{ id: string; data: Record<string, any> }> = [];

    const teams = await this.request<{ value: Array<Record<string, any>> }>('GET', '/me/joinedTeams');
    let channelsAttempted = 0;
    let channelsForbidden = 0;
    for (const team of teams.value ?? []) {
      const teamId = team.id as string;
      const channels = await this.request<{ value: Array<Record<string, any>> }>('GET', `/teams/${teamId}/channels`);
      for (const channel of channels.value ?? []) {
        const channelId = channel.id as string;
        channelsAttempted++;
        let msgs: { value: Array<Record<string, any>> };
        try {
          msgs = await this.request<{ value: Array<Record<string, any>> }>(
            'GET',
            `/teams/${teamId}/channels/${channelId}/messages?$top=${messagesTop(filters?.limit)}`,
          );
        } catch (err) {
          // One channel the caller cannot read (a private/shared channel they
          // are not a member of, say) must NOT fail the whole fan-out — before
          // this, the first 403 threw out of list() and killed the poll for
          // every OTHER channel too, then flipped the connection to
          // "Needs Reconnect". Skip a forbidden channel and carry on; the poll
          // stays healthy on the channels that ARE readable. Non-403 errors
          // (network, 5xx) still propagate so the scheduler's retry/backoff and
          // failure accounting handle them.
          if (statusFromError(err) === 403) {
            channelsForbidden++;
            logger.warn('Microsoft Teams: skipping forbidden channel on message poll', {
              teamId, channelId, err: (err as Error).message.slice(0, 200),
            });
            continue;
          }
          throw err;
        }
        for (const m of msgs.value ?? []) {
          const ts = Date.parse((m.lastModifiedDateTime ?? m.createdDateTime) as string);
          if (since && !Number.isNaN(ts) && ts < since) continue;
          records.push({ id: String(m.id), data: { ...m, teamId, channelId } });
        }
      }
    }
    // If EVERY channel we tried was forbidden, the connection authenticates but
    // can read no messages at all — an app-permission condition, not a private
    // channel here and there. Surface it (rather than silently returning empty)
    // so it stays diagnosable; a partial forbidden set is expected and fine.
    if (channelsAttempted > 0 && channelsForbidden === channelsAttempted) {
      throw new Error(
        `Microsoft Teams: all ${channelsAttempted} channel(s) returned 403 on message read — the signed-in user or app lacks channel-message access across every joined team.`,
      );
    }
    return { records, hasMore: false };
  }


  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Microsoft Teams create', { entityType });

    try {
      switch (entityType) {
        case 'channel': {
          const result = await this.request<{ id: string }>(
            'POST',
            `/teams/${data.teamId}/channels`,
            {
              displayName: data.displayName,
              description: data.description,
              membershipType: data.membershipType || 'standard',
            }
          );

          return {
            success: true,
            id: `${data.teamId}:${result.id}`,
            data: result,
          };
        }

        case 'message': {
          const result = await this.request<{ id: string }>(
            'POST',
            `/teams/${data.teamId}/channels/${data.channelId}/messages`,
            {
              body: {
                contentType: data.contentType || 'text',
                content: data.content,
              },
            }
          );

          return {
            success: true,
            id: `${data.teamId}:${data.channelId}:${result.id}`,
            data: result,
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
    logger.info('Microsoft Teams update', { entityType, entityId });

    try {
      switch (entityType) {
        case 'channel': {
          const [teamId, channelId] = entityId.split(':');
          const updateData: Record<string, any> = {};
          if (data.displayName) updateData.displayName = data.displayName;
          if (data.description) updateData.description = data.description;

          const result = await this.request<Record<string, any>>(
            'PATCH',
            `/teams/${teamId}/channels/${channelId}`,
            updateData
          );

          return {
            success: true,
            data: result,
          };
        }

        case 'message': {
          const [teamId, channelId, messageId] = entityId.split(':');
          const result = await this.request<Record<string, any>>(
            'PATCH',
            `/teams/${teamId}/channels/${channelId}/messages/${messageId}`,
            {
              body: {
                contentType: data.contentType || 'text',
                content: data.content,
              },
            }
          );

          return {
            success: true,
            data: result,
          };
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
    logger.info('Microsoft Teams delete', { entityType, entityId });

    try {
      switch (entityType) {
        case 'channel': {
          const [teamId, channelId] = entityId.split(':');
          await this.request<void>('DELETE', `/teams/${teamId}/channels/${channelId}`);
          return { success: true };
        }

        default:
          return {
            success: false,
            error: `Unsupported entity type for delete: ${entityType}`,
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
    logger.info('Microsoft Teams restore from snapshot', { entityType, entityId });

    if (entityType === 'channel' || entityType === 'message') {
      return this.update(entityType, entityId, snapshot);
    }

    return {
      success: false,
      error: `Cannot restore Microsoft Teams ${entityType}`,
    };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string,
    originalResponse: Record<string, any>
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Microsoft Teams semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        if (entityType === 'channel') {
          const id = originalResponse.id ? `${originalResponse.teamId}:${originalResponse.id}` : entityId;
          return this.delete(entityType, id);
        }
        break;

      case 'delete':
        return {
          success: false,
          error: 'Cannot restore deleted Teams items without backup',
        };

      case 'update':
        return {
          success: false,
          error: 'Update reversal requires pre-action snapshot',
        };

      default:
        return {
          success: false,
          error: `Cannot reverse Microsoft Teams action: ${originalAction}`,
        };
    }

    return { success: false, error: 'Unknown entity type' };
  }

  // Utility methods
  async listTeams(options: {
    pageSize?: number;
    skipToken?: string;
  } = {}): Promise<{ value: Array<Record<string, any>>; '@odata.nextLink'?: string }> {
    const query: Record<string, string> = {
      $top: (options.pageSize || 50).toString(),
    };

    if (options.skipToken) {
      query.$skiptoken = options.skipToken;
    }

    return this.request<{ value: Array<Record<string, any>>; '@odata.nextLink'?: string }>(
      'GET',
      '/me/joinedTeams',
      undefined,
      { query }
    );
  }

  async listChannels(teamId: string): Promise<{ value: Array<Record<string, any>> }> {
    return this.request<{ value: Array<Record<string, any>> }>(
      'GET',
      `/teams/${teamId}/channels`
    );
  }
}
