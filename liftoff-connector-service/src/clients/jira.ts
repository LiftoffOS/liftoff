// Jira Connector Client
// Auth: OAuth2 Bearer token (Atlassian shared OAuth — same provider as Confluence)
// Cloud ID: fetched from accessible-resources endpoint, cached on the credential object
// Base URL: https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/

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

const ACCESSIBLE_RESOURCES_URL =
  'https://api.atlassian.com/oauth/token/accessible-resources';

// ─── Jira domain types ────────────────────────────────────────────────────────

interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: Record<string, any>;
}

interface JiraSearchResult {
  issues: JiraIssue[];
  total: number;
  startAt: number;
  maxResults: number;
}

interface JiraProject {
  id: string;
  key: string;
  name: string;
  projectTypeKey?: string;
  lead?: { accountId: string; displayName: string };
}

interface JiraTransition {
  id: string;
  name: string;
  to: { id: string; name: string; statusCategory: { key: string } };
}

interface JiraComment {
  id: string;
  body: Record<string, any>;
  author: { accountId: string; displayName: string };
  created: string;
  updated: string;
}

interface AtlassianResource {
  id: string;
  name: string;
  url: string;
  scopes: string[];
  avatarUrl: string;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class JiraClient implements CompensationClient {
  readonly connector = 'atlassian_jira';
  private credentialProvider: CredentialProvider;

  // Per-instance cloud ID cache. Fetched once and reused. Invalidated if
  // the credential rotates (new CredentialProvider instance).
  private cloudIdCache: string | null = null;

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  // ── Cloud ID resolution ───────────────────────────────────────────────────

  /**
   * Resolve the Atlassian cloud ID for this credential.
   *
   * Priority:
   *   1. Already cached on this client instance (reset on construction).
   *   2. Stored in credential metadata via instanceUrl field.
   *      For Atlassian, we use instanceUrl as "cloudId:siteUrl" or just cloudId.
   *   3. Fetch from accessible-resources and cache.
   */
  private async getCloudId(accessToken: string, credentials: { instanceUrl?: string }): Promise<string> {
    if (this.cloudIdCache) return this.cloudIdCache;

    // Check if instanceUrl carries the cloud ID (format: cloudId or cloudId:siteUrl)
    if (credentials.instanceUrl) {
      const cloudId = credentials.instanceUrl.split(':')[0].trim();
      if (cloudId && cloudId.length > 0) {
        this.cloudIdCache = cloudId;
        return cloudId;
      }
    }

    // Fetch from accessible-resources
    const response = await fetch(ACCESSIBLE_RESOURCES_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const err = await response.text();
      logger.error('Jira: failed to fetch accessible resources', { status: response.status, err });
      throw new Error(`Jira: failed to resolve cloud ID: ${response.status} - ${err}`);
    }

    const resources = (await response.json()) as AtlassianResource[];
    if (!resources || resources.length === 0) {
      throw new Error('Jira: no Atlassian sites found for this credential');
    }

    // Use the first site (most credentials are single-site)
    const cloudId = resources[0].id;
    this.cloudIdCache = cloudId;
    logger.info('Jira: resolved cloud ID', { cloudId, siteName: resources[0].name });
    return cloudId;
  }

  // ── HTTP transport ─────────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, any>,
    queryParams?: Record<string, string>,
  ): Promise<T> {
    const credentials = await this.credentialProvider();

    // composio_managed routing — Composio knows the connected account's
    // cloudId internally so we don't need to pre-fetch
    // accessible-resources. Pass `/rest/api/3${path}` as the endpoint;
    // Composio routes to api.atlassian.com/ex/jira/{cloudId}/rest/api/3.
    const composio = await tryComposioProxy<T>(credentials, {
      method: method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
      path: `/rest/api/3${path}`,
      body,
      query: queryParams,
    });
    if (composio.handled) return composio.data;

    const cloudId = await this.getCloudId(credentials.accessToken, credentials);
    const baseUrl = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`;
    let url = `${baseUrl}${path}`;

    if (queryParams && Object.keys(queryParams).length > 0) {
      const qs = new URLSearchParams(queryParams).toString();
      url = `${url}?${qs}`;
    }

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${bearerFor(credentials, 'atlassian_jira')}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('Jira API error', { status: response.status, error, path, method });
      throw new Error(`Jira API error: ${response.status} - ${error}`);
    }

    // 204 No Content (transitions, updates)
    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  // ── Issue operations ──────────────────────────────────────────────────────

  async getIssue(issueIdOrKey: string): Promise<JiraIssue> {
    return this.request<JiraIssue>('GET', `/issue/${issueIdOrKey}`);
  }

  async searchIssues(params: {
    jql: string;
    startAt?: number;
    maxResults?: number;
    fields?: string[];
  }): Promise<JiraSearchResult> {
    return this.request<JiraSearchResult>('POST', '/search', {
      jql: params.jql,
      startAt: params.startAt ?? 0,
      maxResults: params.maxResults ?? 50,
      fields: params.fields ?? ['summary', 'status', 'assignee', 'priority', 'issuetype', 'project', 'created', 'updated'],
    });
  }

  async createIssue(data: Record<string, any>): Promise<{ id: string; key: string }> {
    return this.request<{ id: string; key: string }>('POST', '/issue', { fields: data });
  }

  async updateIssue(issueIdOrKey: string, fields: Record<string, any>): Promise<void> {
    await this.request<void>('PUT', `/issue/${issueIdOrKey}`, { fields });
  }

  async getTransitions(issueIdOrKey: string): Promise<{ transitions: JiraTransition[] }> {
    return this.request<{ transitions: JiraTransition[] }>(
      'GET',
      `/issue/${issueIdOrKey}/transitions`,
    );
  }

  async transitionIssue(issueIdOrKey: string, transitionId: string): Promise<void> {
    await this.request<void>('POST', `/issue/${issueIdOrKey}/transitions`, {
      transition: { id: transitionId },
    });
  }

  // ── Comment operations ─────────────────────────────────────────────────────

  async addComment(issueIdOrKey: string, text: string): Promise<JiraComment> {
    const body = {
      body: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text }],
          },
        ],
      },
    };
    return this.request<JiraComment>('POST', `/issue/${issueIdOrKey}/comment`, body);
  }

  // ── Project operations ────────────────────────────────────────────────────

  async listProjects(): Promise<JiraProject[]> {
    return this.request<JiraProject[]>('GET', '/project');
  }

  async getProject(projectIdOrKey: string): Promise<JiraProject> {
    return this.request<JiraProject>('GET', `/project/${projectIdOrKey}`);
  }

  // ── CompensationClient interface ──────────────────────────────────────────

  /**
   * read() — maps entity type to the correct Jira API call.
   *
   * Supported entityTypes:
   *   - 'issue'    → getIssue(entityId)
   *   - 'issues'   → searchIssues(payload.jql)
   *   - 'project'  → getProject(entityId)
   *   - 'projects' → listProjects()
   */
  async read(
    entityType: string,
    entityId: string | undefined,
    payload?: Record<string, any>,
  ): Promise<ExternalRecord> {
    logger.info('Jira read', { entityType, entityId });

    switch (entityType) {
      case 'issue': {
        const id = entityId ?? (payload?.id as string);
        if (!id) throw new Error('Jira: issue read requires entityId or payload.id');
        const data = await this.getIssue(id);
        return {
          id: data.id,
          data: data as unknown as Record<string, any>,
          lastModified: data.fields?.updated ? new Date(data.fields.updated) : undefined,
        };
      }

      case 'issues': {
        const jql = (payload?.jql as string) ?? 'ORDER BY created DESC';
        const result = await this.searchIssues({
          jql,
          startAt: payload?.startAt as number | undefined,
          maxResults: payload?.maxResults as number | undefined,
          fields: payload?.fields as string[] | undefined,
        });
        return {
          id: 'issues',
          data: result as unknown as Record<string, any>,
        };
      }

      case 'project': {
        const id = entityId ?? (payload?.id as string);
        if (!id) throw new Error('Jira: project read requires entityId or payload.id');
        const data = await this.getProject(id);
        return { id: data.id, data: data as unknown as Record<string, any> };
      }

      case 'projects': {
        const data = await this.listProjects();
        return {
          id: 'projects',
          data: { projects: data } as unknown as Record<string, any>,
        };
      }

      case 'comments': {
        const id = entityId ?? (payload?.id as string);
        if (!id) throw new Error('Jira: comments read requires entityId or payload.id');
        const data = await this.request<{ comments: Record<string, any>[]; total: number }>(
          'GET',
          `/issue/${id}/comment?orderBy=created&maxResults=200`,
        );
        return {
          id,
          data: {
            issueKey: id,
            total: data.total,
            comments: data.comments,
          },
        };
      }

      default:
        throw new Error(`Jira: unsupported read entity type "${entityType}"`);
    }
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    if (entityType !== 'Issue') return { records: [], hasMore: false, unsupported: true };
    const sinceIso = filters?.since
      ? filters.since.toISOString().split('T')[0]
      : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const startAt = filters?.pageToken ? parseInt(filters.pageToken, 10) : 0;
    const maxResults = filters?.limit ?? 100;
    const jql = `updated >= "${sinceIso}" ORDER BY updated ASC`;
    const result = await this.request<JiraSearchResult>('GET', '/search', undefined, {
      jql,
      startAt: String(startAt),
      maxResults: String(maxResults),
      fields: 'id,key,summary,status,assignee,updated',
    });
    const nextStartAt = startAt + (result.issues?.length ?? 0);
    const hasMore = nextStartAt < (result.total ?? 0);
    return {
      records: (result.issues ?? []).map(i => ({ id: i.id, data: i as unknown as Record<string, unknown> })),
      nextPageToken: hasMore ? String(nextStartAt) : undefined,
      hasMore,
    };
  }

  /**
   * create() — maps entity type to the correct write operation.
   *
   * Supported entityTypes:
   *   - 'issue'   → createIssue(data)
   *   - 'comment' → addComment(data.issueId, data.text)
   */
  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Jira create', { entityType });

    try {
      switch (entityType) {
        case 'issue': {
          // data contains fields directly (project, summary, issuetype, etc.)
          const result = await this.createIssue(data);
          return { success: true, id: result.key, data: result };
        }

        case 'comment': {
          const { issueId, text } = data;
          if (!issueId || !text) {
            return { success: false, id: '', error: 'Jira: addComment requires issueId and text' };
          }
          const comment = await this.addComment(issueId as string, text as string);
          return { success: true, id: comment.id, data: comment as unknown as Record<string, any> };
        }

        default:
          return {
            success: false,
            id: '',
            error: `Jira: unsupported create entity type "${entityType}"`,
          };
      }
    } catch (error) {
      return { success: false, id: '', error: (error as Error).message };
    }
  }

  /**
   * update() — maps entity type to the correct update operation.
   *
   * Supported entityTypes:
   *   - 'issue'      → updateIssue(entityId, data)
   *   - 'transition' → transitionIssue(entityId, data.transitionId)
   */
  async update(
    entityType: string,
    entityId: string | undefined,
    data: Record<string, any>,
  ): Promise<UpdateResult> {
    logger.info('Jira update', { entityType, entityId });

    try {
      const id = entityId ?? (data.id as string);
      if (!id) {
        return { success: false, error: `Jira: ${entityType} update requires entityId` };
      }

      switch (entityType) {
        case 'issue': {
          await this.updateIssue(id, data);
          return { success: true };
        }

        case 'transition': {
          const transitionId = data.transitionId as string;
          if (!transitionId) {
            return { success: false, error: 'Jira: transition requires data.transitionId' };
          }
          await this.transitionIssue(id, transitionId);
          return { success: true };
        }

        default:
          return {
            success: false,
            error: `Jira: unsupported update entity type "${entityType}"`,
          };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * delete() — Jira issues cannot be hard-deleted via standard REST API.
   * Only admins can delete; the standard approach is to transition to "Done".
   */
  async delete(
    entityType: string,
    _entityId: string | undefined,
    _payload?: Record<string, any>,
  ): Promise<DeleteResult> {
    logger.info('Jira delete (unsupported)', { entityType });
    return {
      success: false,
      error: 'Jira: hard-delete is not supported. Use transition_issue to close issues.',
    };
  }

  // ── CompensationClient — snapshot / inverse ───────────────────────────────

  async restore(
    entityType: string,
    entityId: string | undefined,
    snapshot: Record<string, any>,
  ): Promise<UpdateResult> {
    logger.info('Jira restore from snapshot', { entityType, entityId });
    return this.update(entityType, entityId, snapshot);
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string | undefined,
    _originalResponse: Record<string, any>,
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Jira semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        // Best-effort: transition to "Done" (closest to cancelling a created issue)
        if (entityType === 'issue' && entityId) {
          try {
            const { transitions } = await this.getTransitions(entityId);
            const done = transitions.find(
              (t) => t.name.toLowerCase().includes('done') || t.to.statusCategory.key === 'done',
            );
            if (done) {
              await this.transitionIssue(entityId, done.id);
              return { success: true };
            }
          } catch {
            // Fall through
          }
        }
        return {
          success: false,
          error: 'Jira: cannot reverse issue create — transition to Done manually',
        };

      case 'update':
        return {
          success: false,
          error: 'Jira: update reversal requires pre-action snapshot',
        };

      default:
        return {
          success: false,
          error: `Jira: unknown action type: ${originalAction}`,
        };
    }
  }
}
