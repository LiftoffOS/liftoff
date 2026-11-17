// Linear Connector Client
// GraphQL-based client for the Linear API.
// Endpoint: POST https://api.linear.app/graphql
// Auth: Bearer token (API key or OAuth access token)

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

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

// ─── GraphQL response shapes ──────────────────────────────────────────────────

interface GraphQLError {
  message: string;
  path?: string[];
  extensions?: {
    code?: string;
    [key: string]: unknown;
  };
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLError[];
}

// ─── Linear domain types ──────────────────────────────────────────────────────

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  priority: number;
  url: string;
  createdAt: string;
  updatedAt: string;
  state?: { id: string; name: string };
  assignee?: { id: string; name: string; email: string };
  team?: { id: string; name: string };
  labels?: { nodes: Array<{ id: string; name: string }> };
}

interface LinearTeam {
  id: string;
  name: string;
  key: string;
  description?: string;
}

interface LinearProject {
  id: string;
  name: string;
  description?: string;
  state: string;
  url: string;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class LinearClient implements CompensationClient {
  readonly connector = 'linear';
  private credentialProvider: CredentialProvider;

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  // ── Core GraphQL transport ──────────────────────────────────────────────────

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown> = {}
  ): Promise<T> {
    // Always fetch fresh credentials per request — never cache.
    const credentials = await this.credentialProvider();

    const response = await fetch(LINEAR_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error('Linear HTTP error', { status: response.status, text });
      throw new Error(`Linear API HTTP error: ${response.status} - ${text}`);
    }

    const result = (await response.json()) as GraphQLResponse<T>;

    if (result.errors && result.errors.length > 0) {
      const first = result.errors[0];
      const code = first.extensions?.code ?? 'GRAPHQL_ERROR';
      logger.error('Linear GraphQL error', { errors: result.errors });
      throw new Error(`Linear GraphQL error [${code}]: ${first.message}`);
    }

    if (result.data === undefined) {
      throw new Error('Linear API returned no data and no errors');
    }

    return result.data;
  }

  // ── read ───────────────────────────────────────────────────────────────────

  async read(
    entityType: string,
    entityId: string | undefined,
    payload?: Record<string, any>
  ): Promise<ExternalRecord> {
    logger.info('Linear read', { entityType, entityId });

    switch (entityType) {
      case 'issue': {
        const id = entityId || (payload?.id as string);
        if (!id) throw new Error('issue id is required');

        const data = await this.graphql<{ issue: LinearIssue }>(
          `query GetIssue($id: String!) {
            issue(id: $id) {
              id identifier title description priority url createdAt updatedAt
              state { id name }
              assignee { id name email }
              team { id name }
              labels { nodes { id name } }
            }
          }`,
          { id }
        );

        const issue = data.issue;
        return {
          id: issue.id,
          data: issue as unknown as Record<string, any>,
          versionToken: issue.updatedAt,
          lastModified: new Date(issue.updatedAt),
        };
      }

      case 'issues': {
        // List with optional filters from payload
        const filter = buildIssueFilter(payload);
        const data = await this.graphql<{
          issues: { nodes: LinearIssue[] };
        }>(
          `query ListIssues($filter: IssueFilter) {
            issues(filter: $filter, first: 50) {
              nodes {
                id identifier title description priority url createdAt updatedAt
                state { id name }
                assignee { id name email }
                team { id name }
                labels { nodes { id name } }
              }
            }
          }`,
          { filter: filter ?? {} }
        );

        return {
          id: 'issues',
          data: { issues: data.issues.nodes } as unknown as Record<string, any>,
        };
      }

      case 'team': {
        const id = entityId || (payload?.id as string);
        if (!id) throw new Error('team id is required');

        const data = await this.graphql<{ team: LinearTeam }>(
          `query GetTeam($id: String!) {
            team(id: $id) { id name key description }
          }`,
          { id }
        );

        return { id: data.team.id, data: data.team as unknown as Record<string, any> };
      }

      case 'teams': {
        const data = await this.graphql<{ teams: { nodes: LinearTeam[] } }>(
          `query ListTeams {
            teams { nodes { id name key description } }
          }`
        );

        return {
          id: 'teams',
          data: { teams: data.teams.nodes } as unknown as Record<string, any>,
        };
      }

      case 'projects': {
        const data = await this.graphql<{ projects: { nodes: LinearProject[] } }>(
          `query ListProjects {
            projects(first: 50) {
              nodes { id name description state url }
            }
          }`
        );

        return {
          id: 'projects',
          data: { projects: data.projects.nodes } as unknown as Record<string, any>,
        };
      }

      case 'project': {
        const id = entityId || (payload?.id as string);
        if (!id) throw new Error('project id is required');

        const data = await this.graphql<{ project: LinearProject }>(
          `query GetProject($id: String!) {
            project(id: $id) { id name description state url }
          }`,
          { id }
        );

        return { id: data.project.id, data: data.project as unknown as Record<string, any> };
      }

      case 'comments': {
        const id = entityId || (payload?.id as string);
        if (!id) throw new Error('Linear: comments read requires entityId or payload.id');

        const data = await this.graphql<{
          issue: { comments: { nodes: Record<string, any>[] } };
        }>(
          `query GetIssueComments($id: String!) {
            issue(id: $id) {
              comments {
                nodes {
                  id
                  body
                  createdAt
                  updatedAt
                  user { id name email }
                }
              }
            }
          }`,
          { id }
        );

        const comments = data.issue.comments.nodes;
        return {
          id,
          data: {
            issueId: id,
            commentCount: comments.length,
            comments,
          },
        };
      }

      default:
        throw new Error(`Linear: unsupported read entity type: ${entityType}`);
    }
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    if (entityType !== 'Issue') return { records: [], hasMore: false, unsupported: true };
    const sinceIso = filters?.since ? filters.since.toISOString() : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const limit = filters?.limit ?? 100;
    const after = filters?.pageToken ? `, after: "${filters.pageToken}"` : '';
    const query = `
      query ListIssues {
        issues(filter: { updatedAt: { gte: "${sinceIso}" } }, first: ${limit}${after}) {
          nodes { id identifier title description priority url createdAt updatedAt state { id name } assignee { id name email } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const result = await this.graphql<{ issues: { nodes: LinearIssue[]; pageInfo: { hasNextPage: boolean; endCursor?: string } } }>(query);
    const pageInfo = result.issues.pageInfo;
    return {
      records: result.issues.nodes.map(i => ({ id: i.id, data: i as unknown as Record<string, unknown> })),
      nextPageToken: pageInfo.hasNextPage && pageInfo.endCursor ? pageInfo.endCursor : undefined,
      hasMore: pageInfo.hasNextPage,
    };
  }

  // ── create ─────────────────────────────────────────────────────────────────

  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Linear create', { entityType });

    try {
      switch (entityType) {
        case 'issue': {
          const input: Record<string, unknown> = {
            teamId: data.teamId,
            title: data.title,
          };
          if (data.description !== undefined) input.description = data.description;
          if (data.assigneeId !== undefined) input.assigneeId = data.assigneeId;
          if (data.priority !== undefined) input.priority = data.priority;
          if (data.stateId !== undefined) input.stateId = data.stateId;
          if (data.labelIds !== undefined) input.labelIds = data.labelIds;
          if (data.projectId !== undefined) input.projectId = data.projectId;

          const result = await this.graphql<{
            issueCreate: { success: boolean; issue: LinearIssue };
          }>(
            `mutation CreateIssue($input: IssueCreateInput!) {
              issueCreate(input: $input) {
                success
                issue {
                  id identifier title url createdAt updatedAt
                  state { id name }
                  team { id name }
                }
              }
            }`,
            { input }
          );

          const issue = result.issueCreate.issue;
          return {
            success: result.issueCreate.success,
            id: issue.id,
            data: issue as unknown as Record<string, any>,
          };
        }

        default:
          return {
            success: false,
            id: '',
            error: `Linear: unsupported create entity type: ${entityType}`,
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

  // ── update ─────────────────────────────────────────────────────────────────

  async update(
    entityType: string,
    entityId: string | undefined,
    data: Record<string, any>
  ): Promise<UpdateResult> {
    logger.info('Linear update', { entityType, entityId });

    try {
      const id = entityId || (data.id as string);
      if (!id) throw new Error('id is required for update');

      switch (entityType) {
        case 'issue': {
          const input: Record<string, unknown> = {};
          if (data.title !== undefined) input.title = data.title;
          if (data.description !== undefined) input.description = data.description;
          if (data.stateId !== undefined) input.stateId = data.stateId;
          if (data.assigneeId !== undefined) input.assigneeId = data.assigneeId;
          if (data.priority !== undefined) input.priority = data.priority;
          if (data.labelIds !== undefined) input.labelIds = data.labelIds;

          const result = await this.graphql<{
            issueUpdate: { success: boolean; issue: LinearIssue };
          }>(
            `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
              issueUpdate(id: $id, input: $input) {
                success
                issue { id updatedAt state { id name } assignee { id name } }
              }
            }`,
            { id, input }
          );

          return {
            success: result.issueUpdate.success,
            versionToken: result.issueUpdate.issue.updatedAt,
            data: result.issueUpdate.issue as unknown as Record<string, any>,
          };
        }

        default:
          return {
            success: false,
            error: `Linear: unsupported update entity type: ${entityType}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  // ── delete (archive) ───────────────────────────────────────────────────────

  async delete(
    entityType: string,
    entityId: string | undefined,
    payload?: Record<string, any>
  ): Promise<DeleteResult> {
    logger.info('Linear delete/archive', { entityType, entityId });

    try {
      const id = entityId || (payload?.id as string);
      if (!id) throw new Error('id is required for archive');

      switch (entityType) {
        case 'issue': {
          const result = await this.graphql<{
            issueArchive: { success: boolean };
          }>(
            `mutation ArchiveIssue($id: String!) {
              issueArchive(id: $id) { success }
            }`,
            { id }
          );

          return { success: result.issueArchive.success };
        }

        default:
          return {
            success: false,
            error: `Linear: unsupported delete entity type: ${entityType}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  // ── restore ────────────────────────────────────────────────────────────────

  async restore(
    entityType: string,
    entityId: string | undefined,
    snapshot: Record<string, any>
  ): Promise<UpdateResult> {
    logger.info('Linear restore from snapshot', { entityType, entityId });

    if (entityType === 'issue') {
      return this.update(entityType, entityId, {
        title: snapshot.title,
        description: snapshot.description,
        stateId: snapshot.state?.id,
        assigneeId: snapshot.assignee?.id,
        priority: snapshot.priority,
      });
    }

    return {
      success: false,
      error: `Linear: cannot restore entity type: ${entityType}`,
    };
  }

  // ── semanticInverse ────────────────────────────────────────────────────────

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string | undefined,
    _originalResponse: Record<string, any>
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Linear semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        // Inverse of create is archive (Linear doesn't hard-delete)
        if (entityType === 'issue' && entityId) {
          return this.delete('issue', entityId);
        }
        break;

      case 'archive':
        // Inverse of archive is unarchive
        if (entityType === 'issue' && entityId) {
          try {
            const result = await this.graphql<{
              issueUnarchive: { success: boolean };
            }>(
              `mutation UnarchiveIssue($id: String!) {
                issueUnarchive(id: $id) { success }
              }`,
              { id: entityId }
            );
            return { success: result.issueUnarchive.success };
          } catch (error) {
            return { success: false, error: (error as Error).message };
          }
        }
        break;

      default:
        break;
    }

    return {
      success: false,
      error: `Linear: cannot reverse action ${originalAction} on ${entityType}`,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a Linear IssueFilter from tool-call payload.
 * Supports teamId, stateId, assigneeId, priority filters.
 */
function buildIssueFilter(
  payload?: Record<string, any>
): Record<string, unknown> | undefined {
  if (!payload) return undefined;

  const filter: Record<string, unknown> = {};

  if (payload.teamId) {
    filter.team = { id: { eq: payload.teamId } };
  }
  if (payload.stateId) {
    filter.state = { id: { eq: payload.stateId } };
  }
  if (payload.assigneeId) {
    filter.assignee = { id: { eq: payload.assigneeId } };
  }
  if (payload.priority !== undefined) {
    filter.priority = { eq: payload.priority };
  }

  return Object.keys(filter).length > 0 ? filter : undefined;
}
