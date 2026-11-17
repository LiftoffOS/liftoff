// Asana Connector Client
// Auth: OAuth 2.0 Bearer token
// Base URL: https://app.asana.com/api/1.0

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

const ASANA_BASE_URL = 'https://app.asana.com/api/1.0';

export class AsanaClient implements CompensationClient {
  readonly connector = 'asana';
  private credentialProvider: CredentialProvider;

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, any>,
    queryParams?: Record<string, string>,
  ): Promise<T> {
    // Fetch credentials fresh per-request so tokens are never stale.
    const credentials = await this.credentialProvider();

    let url = `${ASANA_BASE_URL}${path}`;

    if (queryParams && Object.keys(queryParams).length > 0) {
      const qs = new URLSearchParams(queryParams).toString();
      url = `${url}?${qs}`;
    }

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('Asana API error', { status: response.status, error, path, method });
      throw new Error(`Asana API error: ${response.status} - ${error}`);
    }

    // 204 No Content — e.g. delete task
    if (response.status === 204) {
      return {} as T;
    }

    const json = (await response.json()) as { data: T };
    return json.data;
  }

  // ── Project operations ──────────────────────────────────────────────────────

  async listProjects(
    workspaceGid: string,
    archived?: boolean,
  ): Promise<unknown[]> {
    const params: Record<string, string> = {
      opt_fields: 'gid,name,notes,archived,team.name,members.name,created_at,modified_at',
    };
    if (archived !== undefined) {
      params.archived = String(archived);
    }
    return this.request<unknown[]>('GET', `/workspaces/${workspaceGid}/projects`, undefined, params);
  }

  async getProject(projectGid: string): Promise<Record<string, any>> {
    return this.request<Record<string, any>>(
      'GET',
      `/projects/${projectGid}`,
      undefined,
      { opt_fields: 'gid,name,notes,archived,team.name,members.name,created_at,modified_at' },
    );
  }

  async listSections(projectGid: string): Promise<unknown[]> {
    return this.request<unknown[]>('GET', `/projects/${projectGid}/sections`);
  }

  async createSection(projectGid: string, name: string): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('POST', `/projects/${projectGid}/sections`, { data: { name } });
  }

  async updateSection(sectionGid: string, data: Record<string, any>): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('PUT', `/sections/${sectionGid}`, { data });
  }

  async deleteSection(sectionGid: string): Promise<void> {
    await this.request<void>('DELETE', `/sections/${sectionGid}`);
  }

  async createProject(data: { workspaceGid: string; name: string; notes?: string; teamGid?: string }): Promise<Record<string, any>> {
    const body: Record<string, unknown> = { name: data.name };
    if (data.notes) body.notes = data.notes;
    if (data.teamGid) body.team = data.teamGid;
    return this.request<Record<string, any>>('POST', `/workspaces/${data.workspaceGid}/projects`, { data: body });
  }

  async updateProject(projectGid: string, data: Record<string, any>): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('PUT', `/projects/${projectGid}`, { data });
  }

  // ── Task operations ─────────────────────────────────────────────────────────

  async listTasks(
    projectGid: string,
    options?: { completed?: boolean; assignee?: string; limit?: number },
  ): Promise<unknown[]> {
    const params: Record<string, string> = {
      opt_fields: 'gid,name,notes,completed,assignee.name,due_on,projects.name,num_subtasks,created_at,modified_at',
    };
    if (options?.completed !== undefined) {
      params.completed = String(options.completed);
    }
    if (options?.assignee) {
      params.assignee = options.assignee;
    }
    if (options?.limit !== undefined) {
      params.limit = String(Math.min(options.limit, 100));
    }
    return this.request<unknown[]>(
      'GET',
      `/projects/${projectGid}/tasks`,
      undefined,
      params,
    );
  }

  async getTask(taskGid: string): Promise<Record<string, any>> {
    return this.request<Record<string, any>>(
      'GET',
      `/tasks/${taskGid}`,
      undefined,
      { opt_fields: 'gid,name,notes,completed,assignee.name,due_on,projects.name,num_subtasks,created_at,modified_at' },
    );
  }

  async createTask(data: {
    workspaceGid: string;
    projectGid: string;
    name: string;
    notes?: string;
    assignee?: string;
    due_on?: string;
  }): Promise<Record<string, any>> {
    const taskData: Record<string, any> = {
      name: data.name,
      workspace: data.workspaceGid,
      projects: [data.projectGid],
    };
    if (data.notes) taskData.notes = data.notes;
    if (data.assignee) taskData.assignee = data.assignee;
    if (data.due_on) taskData.due_on = data.due_on;

    return this.request<Record<string, any>>('POST', '/tasks', { data: taskData });
  }

  async updateTask(
    taskGid: string,
    updates: {
      name?: string;
      notes?: string;
      completed?: boolean;
      assignee?: string;
      due_on?: string;
    },
  ): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('PUT', `/tasks/${taskGid}`, { data: updates });
  }

  async deleteTask(taskGid: string): Promise<void> {
    await this.request<void>('DELETE', `/tasks/${taskGid}`);
  }

  // ── Story (comment) operations ──────────────────────────────────────────────

  async listTaskStories(taskGid: string): Promise<unknown[]> {
    return this.request<unknown[]>('GET', `/tasks/${taskGid}/stories`);
  }

  async addTaskComment(taskGid: string, text: string): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('POST', `/tasks/${taskGid}/stories`, {
      data: { text },
    });
  }

  // ── User operations ─────────────────────────────────────────────────────────

  async listUsers(workspaceGid: string): Promise<unknown[]> {
    return this.request<unknown[]>('GET', '/users', undefined, {
      workspace: workspaceGid,
    });
  }

  // ── CompensationClient interface ────────────────────────────────────────────

  /**
   * read() — maps entity type to the correct Asana API call.
   *
   * Supported entityTypes:
   *   - 'projects'       → listProjects(workspaceGid, archived)
   *   - 'project'        → getProject(entityId)
   *   - 'tasks'          → listTasks(projectGid, options)
   *   - 'task'           → getTask(entityId)
   *   - 'task_comments'  → listTaskStories(entityId)
   *   - 'users'          → listUsers(workspaceGid)
   *   - 'sections'       → listSections(projectGid)
   */
  async read(
    entityType: string,
    entityId: string | undefined,
    payload?: Record<string, any>,
  ): Promise<ExternalRecord> {
    logger.info('Asana read', { entityType, entityId });

    switch (entityType) {
      case 'projects': {
        const workspaceGid = payload?.workspace_gid as string;
        if (!workspaceGid) {
          throw new Error('Asana: list_projects requires workspace_gid');
        }
        const archived = payload?.archived as boolean | undefined;
        const data = await this.listProjects(workspaceGid, archived);
        return { id: workspaceGid, data: { projects: data } };
      }

      case 'project': {
        const gid = entityId ?? '';
        if (!gid) {
          throw new Error('Asana: get_project requires project_gid');
        }
        const data = await this.getProject(gid);
        return { id: gid, data };
      }

      case 'tasks': {
        const projectGid = payload?.project_gid as string;
        if (!projectGid) {
          throw new Error('Asana: list_tasks requires project_gid');
        }
        const data = await this.listTasks(projectGid, {
          completed: payload?.completed as boolean | undefined,
          assignee: payload?.assignee as string | undefined,
          limit: payload?.limit as number | undefined,
        });
        return { id: projectGid, data: { tasks: data } };
      }

      case 'task': {
        const gid = entityId ?? '';
        if (!gid) {
          throw new Error('Asana: get_task requires task_gid');
        }
        const data = await this.getTask(gid);
        return { id: gid, data };
      }

      case 'task_comments': {
        const gid = entityId ?? '';
        if (!gid) {
          throw new Error('Asana: list_task_comments requires task_gid');
        }
        const data = await this.listTaskStories(gid);
        return { id: gid, data: { stories: data } };
      }

      case 'users': {
        const workspaceGid = payload?.workspace_gid as string;
        if (!workspaceGid) {
          throw new Error('Asana: list_users requires workspace_gid');
        }
        const data = await this.listUsers(workspaceGid);
        return { id: workspaceGid, data: { users: data } };
      }

      case 'sections': {
        const projectGid = payload?.project_gid as string;
        if (!projectGid) {
          throw new Error('Asana: list_sections requires project_gid');
        }
        const data = await this.listSections(projectGid);
        return { id: projectGid, data: { sections: data } };
      }

      default:
        throw new Error(`Asana: unsupported read entity type "${entityType}"`);
    }
  }

  /**
   * create() — maps entity type to the correct write operation.
   *
   * Supported entityTypes:
   *   - 'task'         → createTask(data)
   *   - 'task_comment' → addTaskComment(taskGid, text)
   */
  /**
   * Resolve the authenticated user's default workspace gid.
   * GET /users/me returns the current user with their workspaces; the first
   * workspace is the default. Used by list() because GET /tasks requires
   * (assignee + workspace) when no project/tag is supplied.
   */
  private async getDefaultWorkspaceGid(): Promise<string | undefined> {
    const me = await this.request<{ gid?: string; workspaces?: Array<{ gid?: string }> }>(
      'GET',
      '/users/me',
      undefined,
      { opt_fields: 'workspaces.gid' },
    );
    return me?.workspaces?.[0]?.gid;
  }

  /**
   * list('Task', { since }) — incremental pull of the current user's tasks for
   * reactive polling.
   *
   * Asana's GET /tasks requires a scope: either (assignee + workspace), or
   * project, or tag. For reactive polling we want "tasks assigned to the
   * connected user", so we resolve the user's default workspace via GET
   * /users/me and query assignee=me + workspace={gid}. Incremental delta uses
   * `modified_since` (ISO 8601); pagination uses limit + offset, with the next
   * offset surfaced in the `next_page.offset` token. The shared request()
   * helper unwraps `json.data`, dropping `next_page`, so list() does its own
   * fetch to read the pagination cursor.
   */
  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    if (entityType !== 'Task') return { records: [], hasMore: false, unsupported: true };

    const workspaceGid = await this.getDefaultWorkspaceGid();
    if (!workspaceGid) {
      logger.warn('Asana list: no default workspace for user, returning empty');
      return { records: [], hasMore: false };
    }

    const limit = Math.min(filters?.limit ?? 100, 100);
    const query: Record<string, string> = {
      assignee: 'me',
      workspace: workspaceGid,
      limit: String(limit),
      opt_fields: 'name,modified_at,completed,assignee.name,due_on,projects.name',
    };
    if (filters?.since) query.modified_since = filters.since.toISOString();
    if (filters?.pageToken) query.offset = filters.pageToken;

    const credentials = await this.credentialProvider();
    const qs = new URLSearchParams(query).toString();
    const url = `${ASANA_BASE_URL}/tasks?${qs}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('Asana API error', { status: response.status, error, path: '/tasks', method: 'GET' });
      throw new Error(`Asana API error: ${response.status} - ${error}`);
    }

    const json = (await response.json()) as {
      data?: Array<Record<string, any>>;
      next_page?: { offset?: string | null } | null;
    };
    const tasks = Array.isArray(json.data) ? json.data : [];
    const nextOffset = json.next_page?.offset ?? undefined;

    return {
      records: tasks
        .filter((t) => t?.gid !== undefined && t.gid !== null)
        .map((t) => ({ id: String(t.gid), data: t })),
      nextPageToken: nextOffset ?? undefined,
      hasMore: Boolean(nextOffset),
    };
  }


  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Asana create', { entityType });

    try {
      switch (entityType) {
        case 'task': {
          const result = await this.createTask({
            workspaceGid: data.workspace_gid as string,
            projectGid: data.project_gid as string,
            name: data.name as string,
            notes: data.notes as string | undefined,
            assignee: data.assignee as string | undefined,
            due_on: data.due_on as string | undefined,
          });
          return { success: true, id: String(result.gid ?? ''), data: result };
        }

        case 'task_comment': {
          const taskGid = data.task_gid as string;
          const text = data.text as string;
          const result = await this.addTaskComment(taskGid, text);
          return { success: true, id: String(result.gid ?? ''), data: result };
        }

        case 'section': {
          const projectGid = data.project_gid as string;
          if (!projectGid) return { success: false, id: '', error: 'Asana: section create requires project_gid' };
          const result = await this.createSection(projectGid, data.name as string);
          return { success: true, id: String(result.gid ?? ''), data: result };
        }

        case 'project': {
          const result = await this.createProject({
            workspaceGid: data.workspace_gid as string,
            name: data.name as string,
            notes: data.notes as string | undefined,
            teamGid: data.team_gid as string | undefined,
          });
          return { success: true, id: String(result.gid ?? ''), data: result };
        }

        default:
          return {
            success: false,
            id: '',
            error: `Asana: unsupported create entity type "${entityType}"`,
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
   *   - 'task' → updateTask(entityId, data)
   */
  async update(
    entityType: string,
    entityId: string | undefined,
    data: Record<string, any>,
  ): Promise<UpdateResult> {
    logger.info('Asana update', { entityType, entityId });

    try {
      switch (entityType) {
        case 'task': {
          const gid = entityId ?? (data.task_gid as string);
          if (!gid) {
            return { success: false, error: 'Asana: task update requires task_gid' };
          }
          const result = await this.updateTask(gid, {
            name: data.name as string | undefined,
            notes: data.notes as string | undefined,
            completed: data.completed as boolean | undefined,
            assignee: data.assignee as string | undefined,
            due_on: data.due_on as string | undefined,
          });
          return { success: true, data: result };
        }

        case 'section': {
          const gid = entityId ?? (data.section_gid as string);
          if (!gid) return { success: false, error: 'Asana: section update requires section_gid' };
          const result = await this.updateSection(gid, data);
          return { success: true, data: result };
        }

        case 'project': {
          const gid = entityId ?? (data.project_gid as string);
          if (!gid) return { success: false, error: 'Asana: project update requires project_gid' };
          const result = await this.updateProject(gid, data);
          return { success: true, data: result };
        }

        default:
          return {
            success: false,
            error: `Asana: unsupported update entity type "${entityType}"`,
          };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * delete() — maps entity type to the correct delete operation.
   *
   * Supported entityTypes:
   *   - 'task' → deleteTask(entityId)
   */
  async delete(
    entityType: string,
    entityId: string | undefined,
    payload?: Record<string, any>,
  ): Promise<DeleteResult> {
    logger.info('Asana delete', { entityType, entityId });

    try {
      switch (entityType) {
        case 'task': {
          const gid = entityId ?? (payload?.task_gid as string);
          if (!gid) {
            return { success: false, error: 'Asana: task delete requires task_gid' };
          }
          await this.deleteTask(gid);
          return { success: true };
        }

        case 'section': {
          const gid = entityId ?? (payload?.section_gid as string);
          if (!gid) return { success: false, error: 'Asana: section delete requires section_gid' };
          await this.deleteSection(gid);
          return { success: true };
        }

        default:
          return {
            success: false,
            error: `Asana: unsupported delete entity type "${entityType}"`,
          };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  // ── CompensationClient — snapshot / inverse ─────────────────────────────────

  async restore(
    entityType: string,
    entityId: string | undefined,
    snapshot: Record<string, any>,
  ): Promise<UpdateResult> {
    logger.info('Asana restore from snapshot', { entityType, entityId });
    return this.update(entityType, entityId, snapshot);
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string | undefined,
    originalResponse: Record<string, any>,
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Asana semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        if (entityType === 'task') {
          return this.delete('task', entityId ?? originalResponse.gid);
        }
        return { success: false, error: `Cannot invert create for entity type "${entityType}"` };

      case 'delete':
        return {
          success: false,
          error: 'Cannot restore deleted Asana tasks — recreate manually',
        };

      case 'update':
        return {
          success: false,
          error: 'Update reversal requires pre-action snapshot',
        };

      default:
        return {
          success: false,
          error: `Unknown action type: ${originalAction}`,
        };
    }
  }
}
