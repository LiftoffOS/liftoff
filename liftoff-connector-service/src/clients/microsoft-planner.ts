// Microsoft Planner Connector Client
// Per Section 11 & 12: Microsoft Graph API implementation for Planner

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

export class MicrosoftPlannerClient implements CompensationClient {
  readonly connector = 'microsoft_planner';
  private credentialProvider: CredentialProvider;
  private baseUrl = 'https://graph.microsoft.com/v1.0';

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, any>,
    options: { query?: Record<string, string>; headers?: Record<string, string> } = {}
  ): Promise<T> {
    // Always fetch fresh credentials per request — never cache. The provider
    // delegates to credentialService.getCredentials, which handles refresh.
    const credentials = await this.credentialProvider();
    let url = `${this.baseUrl}${path}`;

    if (options.query) {
      const params = new URLSearchParams(options.query);
      url += `?${params.toString()}`;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${credentials.accessToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('Microsoft Planner API error', { status: response.status, error, path });
      throw new Error(`Microsoft Planner API error: ${response.status} - ${error}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, any>): Promise<ExternalRecord> {
    logger.info('Microsoft Planner read', { entityType, entityId });

    switch (entityType) {
      case 'plan': {
        if (!entityId) throw new Error('entityId required for plan read');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/planner/plans/${entityId}`
        );
        return {
          id: entityId,
          data,
          versionToken: data['@odata.etag'],
          lastModified: undefined,
        };
      }

      case 'task': {
        if (!entityId) throw new Error('entityId required for task read');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/planner/tasks/${entityId}`
        );
        return {
          id: entityId,
          data,
          versionToken: data['@odata.etag'],
          lastModified: undefined,
        };
      }

      case 'bucket': {
        if (!entityId) throw new Error('entityId required for bucket read');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/planner/buckets/${entityId}`
        );
        return {
          id: entityId,
          data,
          versionToken: data['@odata.etag'],
          lastModified: undefined,
        };
      }

      case 'tasks': {
        const planId = payload?.planId || entityId;
        if (!planId) throw new Error('planId required for list_tasks');
        const result = await this.request<{ value: Array<Record<string, any>> }>(
          'GET',
          `/planner/plans/${planId}/tasks`
        );
        return {
          id: planId,
          data: { tasks: result.value ?? [] },
        };
      }

      case 'buckets': {
        const planId = payload?.planId || entityId;
        if (!planId) throw new Error('planId required for list_buckets');
        const result = await this.request<{ value: Array<Record<string, any>> }>(
          'GET',
          `/planner/plans/${planId}/buckets`
        );
        return {
          id: planId,
          data: { buckets: result.value ?? [] },
        };
      }

      default:
        throw new Error(`Unsupported entity type: ${entityType}`);
    }
  }

  // Reactive polling. The scheduler calls list('Task') with the polling
  // entityType. Microsoft Graph exposes GET /me/planner/tasks (Tasks.Read) —
  // every Planner task assigned to the signed-in user in one call. plannerTask
  // has no lastModifiedDateTime (Planner change-tracks via @odata.etag), so we
  // return the full assigned set each cycle and let the scheduler dedup by
  // version (etag) — task volume per user is small and bounded.
  async list(entityType: string, _filters?: ListFilters): Promise<ListResult> {
    if (entityType !== 'Task') return { records: [], hasMore: false, unsupported: true };

    const result = await this.request<{ value: Array<Record<string, any>> }>(
      'GET',
      '/me/planner/tasks',
    );
    const records = (result.value ?? []).map(t => ({
      id: String(t.id ?? ''),
      data: t,
    }));
    return { records, hasMore: false };
  }


  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Microsoft Planner create', { entityType });

    try {
      switch (entityType) {
        case 'plan': {
          const result = await this.request<{ id: string }>(
            'POST',
            '/planner/plans',
            {
              owner: data.groupId,
              title: data.title,
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
            '/planner/tasks',
            {
              planId: data.planId,
              bucketId: data.bucketId,
              title: data.title,
              assignments: data.assignees ? Object.fromEntries(
                data.assignees.map((userId: string) => [userId, { '@odata.type': '#microsoft.graph.plannerAssignment', orderHint: ' !' }])
              ) : undefined,
              dueDateTime: data.dueDate,
              priority: data.priority,
            }
          );

          return {
            success: true,
            id: result.id,
            data: result,
          };
        }

        case 'bucket': {
          const result = await this.request<{ id: string }>(
            'POST',
            '/planner/buckets',
            {
              name: data.name,
              planId: data.planId,
              orderHint: data.orderHint || ' !',
            }
          );

          return {
            success: true,
            id: result.id,
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
    logger.info('Microsoft Planner update', { entityType, entityId });

    try {
      // Planner API requires If-Match header with etag for updates
      const etag = data.etag;
      if (!etag) {
        // Need to fetch current etag first
        const current = await this.read(entityType, entityId);
        data.etag = current.versionToken;
      }

      switch (entityType) {
        case 'task': {
          const updateData: Record<string, any> = {};
          if (data.title) updateData.title = data.title;
          if (data.percentComplete !== undefined) updateData.percentComplete = data.percentComplete;
          if (data.dueDate) updateData.dueDateTime = data.dueDate;
          if (data.priority !== undefined) updateData.priority = data.priority;
          if (data.bucketId) updateData.bucketId = data.bucketId;

          const result = await this.request<Record<string, any>>(
            'PATCH',
            `/planner/tasks/${entityId}`,
            updateData,
            { headers: { 'If-Match': data.etag } }
          );

          return {
            success: true,
            versionToken: result['@odata.etag'],
            data: result,
          };
        }

        case 'bucket': {
          const result = await this.request<Record<string, any>>(
            'PATCH',
            `/planner/buckets/${entityId}`,
            { name: data.name },
            { headers: { 'If-Match': data.etag } }
          );

          return {
            success: true,
            versionToken: result['@odata.etag'],
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

  async delete(
    entityType: string,
    entityId: string,
    payload?: Record<string, any>
  ): Promise<DeleteResult> {
    logger.info('Microsoft Planner delete', { entityType, entityId });

    try {
      // Etag may be passed via payload (semanticInverse path) or fetched lazily.
      let etagToUse: string | undefined = payload?.etag;
      if (!etagToUse) {
        const current = await this.read(entityType, entityId);
        etagToUse = current.versionToken;
      }

      switch (entityType) {
        case 'task': {
          await this.request<void>(
            'DELETE',
            `/planner/tasks/${entityId}`,
            undefined,
            { headers: { 'If-Match': etagToUse! } }
          );
          return { success: true };
        }

        case 'bucket': {
          await this.request<void>(
            'DELETE',
            `/planner/buckets/${entityId}`,
            undefined,
            { headers: { 'If-Match': etagToUse! } }
          );
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
    logger.info('Microsoft Planner restore from snapshot', { entityType, entityId });

    if (['task', 'bucket'].includes(entityType)) {
      return this.update(entityType, entityId, snapshot);
    }

    return {
      success: false,
      error: `Cannot restore Microsoft Planner ${entityType}`,
    };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string,
    originalResponse: Record<string, any>
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Microsoft Planner semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        if (['task', 'bucket'].includes(entityType)) {
          const id = originalResponse.id || entityId;
          const etag = originalResponse['@odata.etag'];
          return this.delete(entityType, id, { etag });
        }
        break;

      case 'delete':
        return {
          success: false,
          error: 'Cannot restore deleted Planner items without backup',
        };

      case 'update':
        return {
          success: false,
          error: 'Update reversal requires pre-action snapshot',
        };

      default:
        return {
          success: false,
          error: `Cannot reverse Microsoft Planner action: ${originalAction}`,
        };
    }

    return { success: false, error: 'Unknown entity type' };
  }

  // Utility methods
  async listPlans(groupId: string): Promise<{ value: Array<Record<string, any>> }> {
    return this.request<{ value: Array<Record<string, any>> }>(
      'GET',
      `/groups/${groupId}/planner/plans`
    );
  }

  async listMyPlans(): Promise<{ value: Array<Record<string, any>> }> {
    return this.request<{ value: Array<Record<string, any>> }>(
      'GET',
      '/me/planner/plans'
    );
  }

  async listTasks(planId: string): Promise<{ value: Array<Record<string, any>> }> {
    return this.request<{ value: Array<Record<string, any>> }>(
      'GET',
      `/planner/plans/${planId}/tasks`
    );
  }

  async listBuckets(planId: string): Promise<{ value: Array<Record<string, any>> }> {
    return this.request<{ value: Array<Record<string, any>> }>(
      'GET',
      `/planner/plans/${planId}/buckets`
    );
  }
}
