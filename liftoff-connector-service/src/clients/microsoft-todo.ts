// Microsoft To Do Connector Client
// Per Section 11 & 12: Microsoft Graph API implementation for To Do

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

export class MicrosoftToDoClient implements CompensationClient {
  readonly connector = 'microsoft_todo';
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
      logger.error('Microsoft To Do API error', { status: response.status, error, path });
      throw new Error(`Microsoft To Do API error: ${response.status} - ${error}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, any>): Promise<ExternalRecord> {
    logger.info('Microsoft To Do read', { entityType, entityId });

    switch (entityType) {
      case 'task_lists': {
        const result = await this.request<{ value: Array<Record<string, any>> }>('GET', '/me/todo/lists');
        return { id: 'task_lists', data: { taskLists: result.value } };
      }

      case 'tasks': {
        const p = payload ?? {};
        const listId = p.listId as string | undefined;
        if (!listId) throw new Error('listId required for list_tasks');
        const result = await this.request<{ value: Array<Record<string, any>> }>(
          'GET', `/me/todo/lists/${listId}/tasks`,
          undefined, { query: { $top: String(p.pageSize ?? 100) } }
        );
        return { id: 'tasks', data: { tasks: result.value } };
      }

      case 'taskList': {
        if (!entityId) throw new Error('entityId required for taskList');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/me/todo/lists/${entityId}`
        );
        return {
          id: entityId,
          data,
          lastModified: undefined,
        };
      }

      case 'task': {
        if (!entityId) throw new Error('entityId required for task');
        const [listId, taskId] = entityId.split(':');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/me/todo/lists/${listId}/tasks/${taskId}`
        );
        return {
          id: entityId,
          data,
          lastModified: data.lastModifiedDateTime ? new Date(data.lastModifiedDateTime) : undefined,
        };
      }

      default:
        throw new Error(`Unsupported entity type: ${entityType}`);
    }
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    // To Do tasks live under lists — there is no global /me/todo/tasks endpoint.
    // Fan out: enumerate the user's lists, then pull tasks per list (filtered by
    // lastModifiedDateTime so each poll cycle only sees rows changed since the
    // last cursor). Because we aggregate every list in one cycle there is no
    // cross-list page cursor, so we always return hasMore:false and rely on the
    // per-list $filter + the scheduler's version-dedup for incrementality.
    if (entityType !== 'Task') return { records: [], hasMore: false, unsupported: true };

    const lists = await this.request<{ value: Array<{ id: string }> }>(
      'GET',
      '/me/todo/lists',
    );

    const query: Record<string, string> = {
      $orderby: 'lastModifiedDateTime',
      $top: String(filters?.limit ?? 100),
    };
    if (filters?.since) {
      query.$filter = `lastModifiedDateTime ge ${filters.since.toISOString()}`;
    }

    const records: ExternalRecord[] = [];
    for (const list of lists.value ?? []) {
      const listId = list.id;
      const result = await this.request<{ value: Array<Record<string, any>> }>(
        'GET',
        `/me/todo/lists/${listId}/tasks`,
        undefined,
        { query },
      );
      for (const t of result.value ?? []) {
        // Stamp the owning listId into data so the normalizer can build the
        // composite listId:taskId externalId.
        records.push({ id: String(t.id), data: { ...t, listId } });
      }
    }

    return { records, hasMore: false };
  }


  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Microsoft To Do create', { entityType });

    try {
      switch (entityType) {
        case 'taskList': {
          const result = await this.request<{ id: string }>(
            'POST',
            '/me/todo/lists',
            {
              displayName: data.displayName,
            }
          );

          return {
            success: true,
            id: result.id,
            data: result,
          };
        }

        case 'task': {
          const result = await this.request<{ id: string }>(
            'POST',
            `/me/todo/lists/${data.listId}/tasks`,
            {
              title: data.title,
              body: data.body ? {
                contentType: 'text',
                content: data.body,
              } : undefined,
              importance: data.importance || 'normal',
              dueDateTime: data.dueDate ? {
                dateTime: data.dueDate,
                timeZone: data.timeZone || 'UTC',
              } : undefined,
              reminderDateTime: data.reminder ? {
                dateTime: data.reminder,
                timeZone: data.timeZone || 'UTC',
              } : undefined,
            }
          );

          return {
            success: true,
            id: `${data.listId}:${result.id}`,
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
    logger.info('Microsoft To Do update', { entityType, entityId });

    try {
      switch (entityType) {
        case 'taskList': {
          const result = await this.request<Record<string, any>>(
            'PATCH',
            `/me/todo/lists/${entityId}`,
            {
              displayName: data.displayName,
            }
          );

          return {
            success: true,
            data: result,
          };
        }

        case 'task': {
          const [listId, taskId] = entityId.split(':');
          const updateData: Record<string, any> = {};

          if (data.title) updateData.title = data.title;
          if (data.body) updateData.body = { contentType: 'text', content: data.body };
          if (data.importance) updateData.importance = data.importance;
          if (data.status) updateData.status = data.status;
          if (data.dueDate) {
            updateData.dueDateTime = {
              dateTime: data.dueDate,
              timeZone: data.timeZone || 'UTC',
            };
          }

          const result = await this.request<Record<string, any>>(
            'PATCH',
            `/me/todo/lists/${listId}/tasks/${taskId}`,
            updateData
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
    logger.info('Microsoft To Do delete', { entityType, entityId });

    try {
      switch (entityType) {
        case 'taskList': {
          await this.request<void>('DELETE', `/me/todo/lists/${entityId}`);
          return { success: true };
        }

        case 'task': {
          const [listId, taskId] = entityId.split(':');
          await this.request<void>('DELETE', `/me/todo/lists/${listId}/tasks/${taskId}`);
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
    logger.info('Microsoft To Do restore from snapshot', { entityType, entityId });

    if (entityType === 'task' || entityType === 'taskList') {
      return this.update(entityType, entityId, snapshot);
    }

    return {
      success: false,
      error: `Cannot restore Microsoft To Do ${entityType}`,
    };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string,
    originalResponse: Record<string, any>
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Microsoft To Do semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        if (['taskList', 'task'].includes(entityType)) {
          const id = originalResponse.id || entityId;
          return this.delete(entityType, id);
        }
        break;

      case 'delete':
        return {
          success: false,
          error: 'Cannot restore deleted To Do items without backup',
        };

      case 'update':
        return {
          success: false,
          error: 'Update reversal requires pre-action snapshot',
        };

      default:
        return {
          success: false,
          error: `Cannot reverse Microsoft To Do action: ${originalAction}`,
        };
    }

    return { success: false, error: 'Unknown entity type' };
  }

  // Utility methods
  async listTaskLists(): Promise<{ value: Array<Record<string, any>> }> {
    return this.request<{ value: Array<Record<string, any>> }>(
      'GET',
      '/me/todo/lists'
    );
  }

  async listTasks(listId: string, options: {
    pageSize?: number;
    filter?: string;
  } = {}): Promise<{ value: Array<Record<string, any>>; '@odata.nextLink'?: string }> {
    const query: Record<string, string> = {
      $top: (options.pageSize || 50).toString(),
    };

    if (options.filter) {
      query.$filter = options.filter;
    }

    return this.request<{ value: Array<Record<string, any>>; '@odata.nextLink'?: string }>(
      'GET',
      `/me/todo/lists/${listId}/tasks`,
      undefined,
      { query }
    );
  }
}
