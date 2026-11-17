// Google YouTube Connector Client
//
// Implements three YouTube APIs behind one /google/youtube sidecar:
//   - Data API v3       — channels, videos, playlists, comments (read + write)
//   - Analytics API v2  — query channel performance metrics
//   - Reporting API v1  — schedule + fetch bulk CSV report exports
//
// All three are reached with the same OAuth access token; the access token's
// scope set decides what works. See GOOGLE_CONNECTOR_SCOPES.youtube in
// src/types.ts.
//
// Scopes:
//   - youtube.readonly       — read channel/video/playlist/comment data
//   - youtube.force-ssl      — manage own videos, playlists, playlist items, comments
//   - yt-analytics.readonly  — Analytics v2 reports + Reporting v1 jobs/reports (non-monetary)
//
// All three are "sensitive" per Google's OAuth verification framework. They
// require sensitive-scope review (2-6 wk wall clock) before consent works
// outside the developer org without the "unverified app" warning.

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

export class GoogleYouTubeClient implements CompensationClient {
  readonly connector = 'youtube';
  private credentialProvider: CredentialProvider;
  private baseUrl = 'https://www.googleapis.com/youtube/v3';
  private analyticsBaseUrl = 'https://youtubeanalytics.googleapis.com/v2';
  private reportingBaseUrl = 'https://youtubereporting.googleapis.com/v1';

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, any>,
    baseUrl: string = this.baseUrl,
  ): Promise<T> {
    const credentials = await this.credentialProvider();

    // composio_managed routing — see clients/composio-transport.ts. Pass the
    // ABSOLUTE vendor URL (same as the direct fetch below). Composio's youtube
    // toolkit base_url is https://www.googleapis.com/youtube/v3 (already includes
    // the version — verified via GET /api/v3/toolkits/youtube), so a `/youtube/v3`
    // prefix doubles it; the analytics/reporting hosts differ too. The absolute
    // URL targets the right host+version for all three (cross-host within
    // googleapis.com is allowed by Composio's same-domain proxy rule).
    const composio = await tryComposioProxy<T>(credentials, {
      method: method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
      path: `${baseUrl}${path}`,
      body,
    });
    if (composio.handled) return composio.data;

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${bearerFor(credentials, 'youtube')}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('YouTube API error', { status: response.status, error, path });
      throw new Error(`YouTube API error: ${response.status} - ${error}`);
    }

    if (response.status === 204) return {} as T;
    return response.json() as Promise<T>;
  }

  private async requestQuery<T>(
    path: string,
    query: Record<string, string>,
    baseUrl: string = this.baseUrl,
  ): Promise<T> {
    const credentials = await this.credentialProvider();

    // Absolute vendor URL — see request() above for the base_url rationale.
    const composio = await tryComposioProxy<T>(credentials, {
      method: 'GET',
      path: `${baseUrl}${path}`,
      query,
    });
    if (composio.handled) return composio.data;

    const params = new URLSearchParams(query);
    const resp = await fetch(`${baseUrl}${path}?${params}`, {
      headers: { Authorization: `Bearer ${bearerFor(credentials, 'youtube')}` },
    });
    if (!resp.ok) {
      const error = await resp.text();
      logger.error('YouTube API error', { status: resp.status, error, path });
      throw new Error(`YouTube API error: ${resp.status} - ${error}`);
    }
    return resp.json() as Promise<T>;
  }

  // ── READ ─────────────────────────────────────────────────────────────
  async read(entityType: string, entityId: string | undefined, payload?: Record<string, any>): Promise<ExternalRecord> {
    logger.info('YouTube read', { entityType, entityId });
    const p = payload ?? {};

    switch (entityType) {
      case 'channel': {
        // Either by id or "mine" if no entityId
        const query: Record<string, string> = { part: 'snippet,statistics,brandingSettings,contentDetails' };
        if (entityId) query.id = entityId;
        else query.mine = 'true';
        const body = await this.requestQuery<{ items: Array<Record<string, any>> }>('/channels', query);
        const item = body.items?.[0];
        if (!item) throw new Error(`Channel not found: ${entityId ?? 'mine'}`);
        return { id: String(item['id']), data: item };
      }

      case 'video': {
        if (!entityId) throw new Error('entityId required for video');
        const body = await this.requestQuery<{ items: Array<Record<string, any>> }>('/videos', {
          part: 'snippet,statistics,contentDetails,status',
          id: entityId,
        });
        const item = body.items?.[0];
        if (!item) throw new Error(`Video not found: ${entityId}`);
        return { id: String(item['id']), data: item };
      }

      case 'playlist': {
        if (!entityId) throw new Error('entityId required for playlist');
        const body = await this.requestQuery<{ items: Array<Record<string, any>> }>('/playlists', {
          part: 'snippet,contentDetails,status',
          id: entityId,
        });
        const item = body.items?.[0];
        if (!item) throw new Error(`Playlist not found: ${entityId}`);
        return { id: String(item['id']), data: item };
      }

      case 'videos': {
        // List videos owned by the authenticated user, or by channelId in payload
        const query: Record<string, string> = {
          part: 'snippet,id',
          type: 'video',
          maxResults: String(p.maxResults ?? 50),
          order: (p.order as string) ?? 'date',
        };
        if (p.channelId) query.channelId = String(p.channelId);
        else query.forMine = 'true';
        if (p.q) query.q = String(p.q);
        if (p.pageToken) query.pageToken = String(p.pageToken);
        const body = await this.requestQuery<{ items: Array<Record<string, any>>; nextPageToken?: string }>('/search', query);
        return { id: 'videos', data: { videos: body.items, nextPageToken: body.nextPageToken } };
      }

      case 'playlists': {
        const query: Record<string, string> = {
          part: 'snippet,contentDetails',
          maxResults: String(p.maxResults ?? 50),
        };
        if (p.channelId) query.channelId = String(p.channelId);
        else query.mine = 'true';
        if (p.pageToken) query.pageToken = String(p.pageToken);
        const body = await this.requestQuery<{ items: Array<Record<string, any>>; nextPageToken?: string }>('/playlists', query);
        return { id: 'playlists', data: { playlists: body.items, nextPageToken: body.nextPageToken } };
      }

      case 'playlist_items': {
        if (!p.playlistId) throw new Error('playlistId required for playlist_items');
        const query: Record<string, string> = {
          part: 'snippet,contentDetails',
          playlistId: String(p.playlistId),
          maxResults: String(p.maxResults ?? 50),
        };
        if (p.pageToken) query.pageToken = String(p.pageToken);
        const body = await this.requestQuery<{ items: Array<Record<string, any>>; nextPageToken?: string }>('/playlistItems', query);
        return { id: 'playlist_items', data: { items: body.items, nextPageToken: body.nextPageToken } };
      }

      case 'comments': {
        // Top-level comment threads on a video
        if (!p.videoId) throw new Error('videoId required for comments');
        const query: Record<string, string> = {
          part: 'snippet,replies',
          videoId: String(p.videoId),
          maxResults: String(p.maxResults ?? 50),
          order: (p.order as string) ?? 'time',
        };
        if (p.pageToken) query.pageToken = String(p.pageToken);
        const body = await this.requestQuery<{ items: Array<Record<string, any>>; nextPageToken?: string }>('/commentThreads', query);
        return { id: 'comments', data: { threads: body.items, nextPageToken: body.nextPageToken } };
      }

      case 'search': {
        // General search across the public YouTube catalog
        if (!p.q) throw new Error('q (query) required for search');
        const query: Record<string, string> = {
          part: 'snippet',
          q: String(p.q),
          maxResults: String(p.maxResults ?? 25),
          type: (p.type as string) ?? 'video',
        };
        if (p.pageToken) query.pageToken = String(p.pageToken);
        if (p.order) query.order = String(p.order);
        const body = await this.requestQuery<{ items: Array<Record<string, any>>; nextPageToken?: string }>('/search', query);
        return { id: 'search', data: { results: body.items, nextPageToken: body.nextPageToken } };
      }

      // ── Analytics API v2 ──────────────────────────────────────────────
      case 'analytics_report': {
        // Single endpoint: GET /v2/reports?ids=channel==MINE&startDate&endDate&metrics[&dimensions&filters&sort&maxResults]
        // Caller passes metrics + date range; dimensions/filters/sort/maxResults are optional.
        if (!p.startDate) throw new Error('startDate (YYYY-MM-DD) required');
        if (!p.endDate) throw new Error('endDate (YYYY-MM-DD) required');
        if (!p.metrics) throw new Error('metrics (comma-separated list) required');
        const query: Record<string, string> = {
          ids: (p.ids as string) ?? 'channel==MINE',
          startDate: String(p.startDate),
          endDate: String(p.endDate),
          metrics: String(p.metrics),
        };
        if (p.dimensions) query.dimensions = String(p.dimensions);
        if (p.filters) query.filters = String(p.filters);
        if (p.sort) query.sort = String(p.sort);
        if (p.maxResults) query.maxResults = String(p.maxResults);
        if (p.currency) query.currency = String(p.currency);
        const body = await this.requestQuery<Record<string, any>>('/reports', query, this.analyticsBaseUrl);
        return { id: 'analytics_report', data: body };
      }

      // ── Reporting API v1 ──────────────────────────────────────────────
      case 'report_types': {
        // GET /v1/reportTypes — list available bulk report types for this channel/CMS account.
        const query: Record<string, string> = {};
        if (p.includeSystemManaged !== undefined) {
          query.includeSystemManaged = String(Boolean(p.includeSystemManaged));
        }
        if (p.pageSize) query.pageSize = String(p.pageSize);
        if (p.pageToken) query.pageToken = String(p.pageToken);
        const body = await this.requestQuery<Record<string, any>>('/reportTypes', query, this.reportingBaseUrl);
        return { id: 'report_types', data: body };
      }

      case 'reporting_jobs': {
        // GET /v1/jobs — list reporting jobs the authenticated channel has subscribed to.
        const query: Record<string, string> = {};
        if (p.includeSystemManaged !== undefined) {
          query.includeSystemManaged = String(Boolean(p.includeSystemManaged));
        }
        if (p.pageSize) query.pageSize = String(p.pageSize);
        if (p.pageToken) query.pageToken = String(p.pageToken);
        const body = await this.requestQuery<Record<string, any>>('/jobs', query, this.reportingBaseUrl);
        return { id: 'reporting_jobs', data: body };
      }

      case 'reports': {
        // GET /v1/jobs/{jobId}/reports — list generated reports for a job. Each report has a downloadUrl.
        if (!p.jobId) throw new Error('jobId required for reports');
        const query: Record<string, string> = {};
        if (p.createdAfter) query.createdAfter = String(p.createdAfter);
        if (p.startTimeAtOrAfter) query.startTimeAtOrAfter = String(p.startTimeAtOrAfter);
        if (p.startTimeBefore) query.startTimeBefore = String(p.startTimeBefore);
        if (p.pageSize) query.pageSize = String(p.pageSize);
        if (p.pageToken) query.pageToken = String(p.pageToken);
        const body = await this.requestQuery<Record<string, any>>(
          `/jobs/${encodeURIComponent(String(p.jobId))}/reports`,
          query,
          this.reportingBaseUrl,
        );
        return { id: 'reports', data: body };
      }

      default:
        throw new Error(`Unsupported entity type: ${entityType}`);
    }
  }

  // ── LIST (for background polling) ────────────────────────────────────
  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    // Only Video is polled — pull recent uploads on the authenticated user's channel.
    if (entityType !== 'Video') return { records: [], hasMore: false, unsupported: true };
    const credentials = await this.credentialProvider();
    const params = new URLSearchParams({
      part: 'snippet,id',
      type: 'video',
      forMine: 'true',
      order: 'date',
      maxResults: String(filters?.limit ?? 50),
    });
    if (filters?.pageToken) params.set('pageToken', filters.pageToken);
    // YouTube Data API has no "updatedMin" — filter by publishedAt client-side
    const url = `${this.baseUrl}/search?${params}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${bearerFor(credentials, 'youtube')}` },
    });
    if (!resp.ok) throw new Error(`YouTube list failed: ${resp.status}`);
    const body = (await resp.json()) as { items?: Record<string, any>[]; nextPageToken?: string };
    let items = body.items ?? [];
    if (filters?.since) {
      const since = filters.since.getTime();
      items = items.filter((it) => {
        const snippet = it['snippet'] as Record<string, any> | undefined;
        const pub = snippet?.['publishedAt'] as string | undefined;
        return pub ? new Date(pub).getTime() >= since : false;
      });
    }
    return {
      records: items.map((it) => {
        const idField = it['id'] as Record<string, any> | string;
        const videoId = typeof idField === 'string' ? idField : (idField?.['videoId'] as string);
        const snippet = it['snippet'] as Record<string, any> | undefined;
        return {
          id: String(videoId),
          data: it,
          lastModified: snippet?.['publishedAt'] ? new Date(snippet['publishedAt'] as string) : undefined,
        };
      }),
      nextPageToken: body.nextPageToken,
      hasMore: !!body.nextPageToken,
    };
  }

  // ── CREATE ───────────────────────────────────────────────────────────
  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('YouTube create', { entityType });
    try {
      switch (entityType) {
        case 'playlist': {
          // POST /playlists?part=snippet,status
          const body = {
            snippet: {
              title: data.title,
              description: data.description ?? '',
              tags: data.tags,
              defaultLanguage: data.defaultLanguage,
            },
            status: { privacyStatus: data.privacyStatus ?? 'private' },
          };
          const result = await this.request<{ id: string }>('POST', '/playlists?part=snippet,status', body);
          return { success: true, id: result.id, data: result };
        }

        case 'playlist_item': {
          // POST /playlistItems?part=snippet
          if (!data.playlistId) return { success: false, id: '', error: 'playlistId required' };
          if (!data.videoId) return { success: false, id: '', error: 'videoId required' };
          const body = {
            snippet: {
              playlistId: data.playlistId,
              resourceId: { kind: 'youtube#video', videoId: data.videoId },
              position: data.position,
            },
          };
          const result = await this.request<{ id: string }>('POST', '/playlistItems?part=snippet', body);
          return { success: true, id: result.id, data: result };
        }

        case 'comment': {
          // POST /commentThreads?part=snippet — top-level comment on a video
          if (!data.videoId) return { success: false, id: '', error: 'videoId required' };
          if (!data.text) return { success: false, id: '', error: 'text required' };
          const body = {
            snippet: {
              videoId: data.videoId,
              topLevelComment: { snippet: { textOriginal: data.text } },
            },
          };
          const result = await this.request<{ id: string }>('POST', '/commentThreads?part=snippet', body);
          return { success: true, id: result.id, data: result };
        }

        case 'reporting_job': {
          // POST /v1/jobs — subscribe to a Reporting API report type.
          if (!data.reportTypeId) return { success: false, id: '', error: 'reportTypeId required' };
          const body: Record<string, any> = { reportTypeId: data.reportTypeId };
          if (data.name) body.name = data.name;
          const result = await this.request<{ id: string }>(
            'POST',
            '/jobs',
            body,
            this.reportingBaseUrl,
          );
          return { success: true, id: result.id, data: result };
        }

        default:
          // Video upload uses multipart resumable upload, which doesn't fit the
          // JSON-body request() shape and requires substantial extra work.
          // Defer create_video until first real demand.
          return { success: false, id: '', error: `Unsupported entity type for create: ${entityType}` };
      }
    } catch (error) {
      return { success: false, id: '', error: (error as Error).message };
    }
  }

  // ── UPDATE ───────────────────────────────────────────────────────────
  async update(entityType: string, entityId: string, data: Record<string, any>): Promise<UpdateResult> {
    logger.info('YouTube update', { entityType, entityId });
    try {
      switch (entityType) {
        case 'video': {
          // PUT /videos?part=snippet,status — must include the existing snippet's required fields
          if (!entityId) return { success: false, error: 'entityId required for video' };
          const snippet: Record<string, any> = { categoryId: data.categoryId };
          if (data.title !== undefined) snippet.title = data.title;
          if (data.description !== undefined) snippet.description = data.description;
          if (data.tags !== undefined) snippet.tags = data.tags;
          const status: Record<string, any> = {};
          if (data.privacyStatus !== undefined) status.privacyStatus = data.privacyStatus;
          const body = { id: entityId, snippet, ...(Object.keys(status).length ? { status } : {}) };
          const result = await this.request<{ etag: string }>(
            'PUT',
            `/videos?part=snippet${Object.keys(status).length ? ',status' : ''}`,
            body,
          );
          return { success: true, versionToken: result.etag, data: result };
        }

        case 'playlist': {
          if (!entityId) return { success: false, error: 'entityId required for playlist' };
          const snippet: Record<string, any> = {};
          if (data.title !== undefined) snippet.title = data.title;
          if (data.description !== undefined) snippet.description = data.description;
          const status: Record<string, any> = {};
          if (data.privacyStatus !== undefined) status.privacyStatus = data.privacyStatus;
          const body = {
            id: entityId,
            snippet,
            ...(Object.keys(status).length ? { status } : {}),
          };
          const result = await this.request<{ etag: string }>(
            'PUT',
            `/playlists?part=snippet${Object.keys(status).length ? ',status' : ''}`,
            body,
          );
          return { success: true, versionToken: result.etag, data: result };
        }

        default:
          return { success: false, error: `Unsupported entity type for update: ${entityType}` };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  // ── DELETE ───────────────────────────────────────────────────────────
  async delete(entityType: string, entityId: string): Promise<DeleteResult> {
    logger.info('YouTube delete', { entityType, entityId });
    try {
      switch (entityType) {
        case 'video': {
          if (!entityId) return { success: false, error: 'entityId required' };
          await this.request<void>('DELETE', `/videos?id=${encodeURIComponent(entityId)}`);
          return { success: true };
        }
        case 'playlist': {
          if (!entityId) return { success: false, error: 'entityId required' };
          await this.request<void>('DELETE', `/playlists?id=${encodeURIComponent(entityId)}`);
          return { success: true };
        }
        case 'playlist_item': {
          if (!entityId) return { success: false, error: 'entityId required' };
          await this.request<void>('DELETE', `/playlistItems?id=${encodeURIComponent(entityId)}`);
          return { success: true };
        }
        case 'comment': {
          if (!entityId) return { success: false, error: 'entityId required' };
          await this.request<void>('DELETE', `/comments?id=${encodeURIComponent(entityId)}`);
          return { success: true };
        }
        case 'reporting_job': {
          // DELETE /v1/jobs/{jobId} — unsubscribe from a Reporting API job.
          if (!entityId) return { success: false, error: 'entityId required' };
          await this.request<void>(
            'DELETE',
            `/jobs/${encodeURIComponent(entityId)}`,
            undefined,
            this.reportingBaseUrl,
          );
          return { success: true };
        }
        default:
          return { success: false, error: `Unsupported entity type for delete: ${entityType}` };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  // ── RESTORE / semanticInverse (compensation hooks) ───────────────────
  async restore(
    entityType: string,
    entityId: string,
    snapshot: Record<string, any>,
  ): Promise<UpdateResult> {
    logger.info('YouTube restore from snapshot', { entityType, entityId });
    if (entityType === 'video' || entityType === 'playlist') {
      const restoreData: Record<string, any> = {};
      if (snapshot.title) restoreData.title = snapshot.title;
      if (snapshot.description) restoreData.description = snapshot.description;
      if (snapshot.tags) restoreData.tags = snapshot.tags;
      if (snapshot.privacyStatus) restoreData.privacyStatus = snapshot.privacyStatus;
      if (snapshot.categoryId) restoreData.categoryId = snapshot.categoryId;
      return this.update(entityType, entityId, restoreData);
    }
    return { success: false, error: `Cannot restore YouTube ${entityType}` };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string,
    originalResponse: Record<string, any>,
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('YouTube semantic inverse', { entityType, originalAction, entityId });
    switch (originalAction) {
      case 'create': {
        const id = entityId || (originalResponse.id as string | undefined);
        if (!id) return { success: false, error: 'No id to reverse create' };
        if (entityType === 'playlist') return this.delete('playlist', id);
        if (entityType === 'playlist_item') return this.delete('playlist_item', id);
        if (entityType === 'comment') return this.delete('comment', id);
        if (entityType === 'reporting_job') return this.delete('reporting_job', id);
        return { success: false, error: `Cannot reverse create on ${entityType}` };
      }
      case 'delete':
        return {
          success: false,
          error: 'Cannot restore deleted YouTube records without snapshot data',
        };
      case 'update':
        return { success: false, error: 'Update reversal requires pre-action snapshot' };
      default:
        return { success: false, error: `Cannot reverse YouTube action: ${originalAction}` };
    }
  }
}
