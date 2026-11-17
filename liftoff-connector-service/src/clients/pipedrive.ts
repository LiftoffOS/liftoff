// Pipedrive Connector Client
// Auth: API token via query param ?api_token={accessToken} on every request.
// Base URL: https://api.pipedrive.com/v1
// No OAuth refresh — API tokens do not expire.

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

const BASE_URL = 'https://api.pipedrive.com/v1';

export class PipedriveClient implements CompensationClient {
  readonly connector = 'pipedrive';
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
    const credentials = await this.credentialProvider();
    const params = new URLSearchParams({ api_token: credentials.accessToken });
    if (queryParams) {
      for (const [k, v] of Object.entries(queryParams)) {
        params.set(k, v);
      }
    }

    const url = `${BASE_URL}${path}?${params.toString()}`;

    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('Pipedrive API error', { status: response.status, error, path, method });
      throw new Error(`Pipedrive API error: ${response.status} - ${error}`);
    }

    // 204 No Content
    if (response.status === 204) {
      return {} as T;
    }

    const json = (await response.json()) as { success: boolean; data: T; error?: string };
    if (!json.success) {
      throw new Error(`Pipedrive API returned failure: ${json.error ?? 'unknown error'}`);
    }
    return json.data;
  }

  // ── Deals ──────────────────────────────────────────────────────────────────

  async listDeals(status: string = 'open', limit: number = 100): Promise<unknown[]> {
    return this.request<unknown[]>('GET', '/deals', undefined, {
      status,
      start: '0',
      limit: String(Math.min(limit, 100)),
    });
  }

  async getDeal(id: number): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('GET', `/deals/${id}`);
  }

  async createDeal(data: Record<string, any>): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('POST', '/deals', data);
  }

  async updateDeal(id: number, data: Record<string, any>): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('PUT', `/deals/${id}`, data);
  }

  async deleteDeal(id: number): Promise<void> {
    await this.request<void>('DELETE', `/deals/${id}`);
  }

  async getDealActivities(id: number): Promise<unknown[]> {
    return this.request<unknown[]>('GET', `/deals/${id}/activities`);
  }

  // ── Persons ─────────────────────────────────────────────────────────────────

  async listPersons(limit: number = 100): Promise<unknown[]> {
    return this.request<unknown[]>('GET', '/persons', undefined, {
      start: '0',
      limit: String(Math.min(limit, 100)),
    });
  }

  async getPerson(id: number): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('GET', `/persons/${id}`);
  }

  async createPerson(data: Record<string, any>): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('POST', '/persons', data);
  }

  async updatePerson(id: number, data: Record<string, any>): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('PUT', `/persons/${id}`, data);
  }

  async deletePerson(id: number): Promise<void> {
    await this.request<void>('DELETE', `/persons/${id}`);
  }

  // ── Organizations ───────────────────────────────────────────────────────────

  async listOrganizations(limit: number = 100): Promise<unknown[]> {
    return this.request<unknown[]>('GET', '/organizations', undefined, {
      start: '0',
      limit: String(Math.min(limit, 100)),
    });
  }

  async getOrganization(id: number): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('GET', `/organizations/${id}`);
  }

  async createOrganization(data: Record<string, any>): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('POST', '/organizations', data);
  }

  async updateOrganization(id: number, data: Record<string, any>): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('PUT', `/organizations/${id}`, data);
  }

  // ── Activities ───────────────────────────────────────────────────────────────

  async listActivities(done: boolean = false, dealId?: number, personId?: number): Promise<unknown[]> {
    const params: Record<string, string> = {
      start: '0',
      limit: '100',
      done: done ? '1' : '0',
    };
    if (dealId !== undefined) params.deal_id = String(dealId);
    if (personId !== undefined) params.person_id = String(personId);
    return this.request<unknown[]>('GET', '/activities', undefined, params);
  }

  async getActivity(id: number): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('GET', `/activities/${id}`);
  }

  async createActivity(data: Record<string, any>): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('POST', '/activities', data);
  }

  async updateActivity(id: number, data: Record<string, any>): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('PUT', `/activities/${id}`, data);
  }

  async deleteActivity(id: number): Promise<void> {
    await this.request<void>('DELETE', `/activities/${id}`);
  }

  // ── Notes ────────────────────────────────────────────────────────────────────

  async listNotes(params: Record<string, string> = {}): Promise<unknown[]> {
    return this.request<unknown[]>('GET', '/notes', undefined, params);
  }

  async createNote(data: Record<string, any>): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('POST', '/notes', data);
  }

  // ── Pipelines / Stages / Users ───────────────────────────────────────────────

  async listPipelines(): Promise<unknown[]> {
    return this.request<unknown[]>('GET', '/pipelines');
  }

  async listStages(pipelineId?: number): Promise<unknown[]> {
    const params: Record<string, string> = {};
    if (pipelineId !== undefined) params.pipeline_id = String(pipelineId);
    return this.request<unknown[]>('GET', '/stages', undefined, params);
  }

  async listUsers(): Promise<unknown[]> {
    return this.request<unknown[]>('GET', '/users');
  }

  // ── CompensationClient interface ─────────────────────────────────────────────

  /**
   * read() — maps entityType to the correct Pipedrive API call.
   *
   * Supported entityTypes:
   *   deals, deal, persons, person, organizations, organization,
   *   activities, activity, notes, pipelines, stages, users, deal_activities
   */
  async read(
    entityType: string,
    entityId: string | undefined,
    payload?: Record<string, any>,
  ): Promise<ExternalRecord> {
    logger.info('Pipedrive read', { entityType, entityId });

    switch (entityType) {
      case 'deals': {
        const status = (payload?.status as string) ?? 'open';
        const limit = (payload?.limit as number) ?? 100;
        const data = await this.listDeals(status, limit);
        return { id: 'deals', data: { deals: data } };
      }

      case 'deal': {
        const id = Number(entityId);
        const data = await this.getDeal(id);
        return { id: String(id), data };
      }

      case 'deal_activities': {
        const id = Number(entityId);
        const data = await this.getDealActivities(id);
        return { id: `deal_${id}_activities`, data: { activities: data } };
      }

      case 'persons': {
        const limit = (payload?.limit as number) ?? 100;
        const data = await this.listPersons(limit);
        return { id: 'persons', data: { persons: data } };
      }

      case 'person': {
        const id = Number(entityId);
        const data = await this.getPerson(id);
        return { id: String(id), data };
      }

      case 'organizations': {
        const limit = (payload?.limit as number) ?? 100;
        const data = await this.listOrganizations(limit);
        return { id: 'organizations', data: { organizations: data } };
      }

      case 'organization': {
        const id = Number(entityId);
        const data = await this.getOrganization(id);
        return { id: String(id), data };
      }

      case 'activities': {
        const done = (payload?.done as boolean) ?? false;
        const dealId = payload?.deal_id as number | undefined;
        const personId = payload?.person_id as number | undefined;
        const data = await this.listActivities(done, dealId, personId);
        return { id: 'activities', data: { activities: data } };
      }

      case 'activity': {
        const id = Number(entityId);
        const data = await this.getActivity(id);
        return { id: String(id), data };
      }

      case 'notes': {
        const params: Record<string, string> = {};
        if (payload?.deal_id) params.deal_id = String(payload.deal_id);
        if (payload?.person_id) params.person_id = String(payload.person_id);
        if (payload?.org_id) params.org_id = String(payload.org_id);
        const data = await this.listNotes(params);
        return { id: 'notes', data: { notes: data } };
      }

      case 'pipelines': {
        const data = await this.listPipelines();
        return { id: 'pipelines', data: { pipelines: data } };
      }

      case 'stages': {
        const pipelineId = payload?.pipeline_id as number | undefined;
        const data = await this.listStages(pipelineId);
        return { id: 'stages', data: { stages: data } };
      }

      case 'users': {
        const data = await this.listUsers();
        return { id: 'users', data: { users: data } };
      }

      default:
        throw new Error(`Pipedrive: unsupported read entity type "${entityType}"`);
    }
  }

  /**
   * create() — maps entityType to the correct Pipedrive write call.
   *
   * Supported entityTypes:
   *   deal, person, organization, activity, note
   */
  /** Enumerate a Pipedrive account. Eight enumerators already existed here for
   *  the tool surface; `list` reached none of them and answered empty, which a
   *  picker shows as "you have no deals". */
  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const limit = filters?.limit ?? 100;
    const rows = (data: unknown[]) =>
      data.map(row => {
        const r = row as Record<string, any>;
        return { id: String(r.id ?? ''), data: r };
      });

    switch (entityType) {
      case 'deal':
      case 'deals':
        return { records: rows(await this.listDeals('open', limit)), hasMore: false };

      case 'person':
      case 'persons':
      case 'people':
        return { records: rows(await this.listPersons(limit)), hasMore: false };

      case 'organization':
      case 'organizations':
        return { records: rows(await this.listOrganizations(limit)), hasMore: false };

      case 'activity':
      case 'activities':
        return { records: rows(await this.listActivities(false)), hasMore: false };

      case 'note':
      case 'notes':
        return { records: rows(await this.listNotes({ limit: String(limit) })), hasMore: false };

      case 'pipeline':
      case 'pipelines':
        return { records: rows(await this.listPipelines()), hasMore: false };

      case 'stage':
      case 'stages':
        return { records: rows(await this.listStages()), hasMore: false };

      case 'user':
      case 'users':
        return { records: rows(await this.listUsers()), hasMore: false };

      default:
        return { records: [], hasMore: false, unsupported: true };
    }
  }


  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Pipedrive create', { entityType });

    try {
      switch (entityType) {
        case 'deal': {
          const result = await this.createDeal(data);
          return { success: true, id: String(result.id), data: result };
        }

        case 'person': {
          // Normalize email and phone into Pipedrive's array format
          const personData: Record<string, any> = { ...data };
          if (typeof data.email === 'string') {
            personData.email = [{ value: data.email, label: 'work' }];
          }
          if (typeof data.phone === 'string') {
            personData.phone = [{ value: data.phone, label: 'work' }];
          }
          const result = await this.createPerson(personData);
          return { success: true, id: String(result.id), data: result };
        }

        case 'organization': {
          const result = await this.createOrganization(data);
          return { success: true, id: String(result.id), data: result };
        }

        case 'activity': {
          const result = await this.createActivity(data);
          return { success: true, id: String(result.id), data: result };
        }

        case 'note': {
          const result = await this.createNote(data);
          return { success: true, id: String(result.id), data: result };
        }

        default:
          return {
            success: false,
            id: '',
            error: `Pipedrive: unsupported create entity type "${entityType}"`,
          };
      }
    } catch (error) {
      return { success: false, id: '', error: (error as Error).message };
    }
  }

  /**
   * update() — maps entityType to the correct Pipedrive update call.
   *
   * Supported entityTypes:
   *   deal, person, organization, activity
   */
  async update(
    entityType: string,
    entityId: string | undefined,
    data: Record<string, any>,
  ): Promise<UpdateResult> {
    logger.info('Pipedrive update', { entityType, entityId });

    try {
      if (!entityId) {
        return { success: false, error: `Pipedrive: update requires entityId for "${entityType}"` };
      }

      const id = Number(entityId);

      switch (entityType) {
        case 'deal': {
          const result = await this.updateDeal(id, data);
          return { success: true, data: result };
        }

        case 'person': {
          // Normalize email/phone strings to Pipedrive array format
          const personData: Record<string, any> = { ...data };
          if (typeof data.email === 'string') {
            personData.email = [{ value: data.email, label: 'work' }];
          }
          if (typeof data.phone === 'string') {
            personData.phone = [{ value: data.phone, label: 'work' }];
          }
          const result = await this.updatePerson(id, personData);
          return { success: true, data: result };
        }

        case 'organization': {
          const result = await this.updateOrganization(id, data);
          return { success: true, data: result };
        }

        case 'activity': {
          const result = await this.updateActivity(id, data);
          return { success: true, data: result };
        }

        default:
          return {
            success: false,
            error: `Pipedrive: unsupported update entity type "${entityType}"`,
          };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * delete() — maps entityType to the correct Pipedrive delete call.
   *
   * Supported entityTypes:
   *   deal, person, activity
   */
  async delete(
    entityType: string,
    entityId: string | undefined,
    _payload?: Record<string, any>,
  ): Promise<DeleteResult> {
    logger.info('Pipedrive delete', { entityType, entityId });

    try {
      if (!entityId) {
        return { success: false, error: `Pipedrive: delete requires entityId for "${entityType}"` };
      }

      const id = Number(entityId);

      switch (entityType) {
        case 'deal':
          await this.deleteDeal(id);
          return { success: true };

        case 'person':
          await this.deletePerson(id);
          return { success: true };

        case 'activity':
          await this.deleteActivity(id);
          return { success: true };

        default:
          return {
            success: false,
            error: `Pipedrive: unsupported delete entity type "${entityType}"`,
          };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  // ── CompensationClient — snapshot / inverse ──────────────────────────────────

  async restore(
    entityType: string,
    entityId: string | undefined,
    snapshot: Record<string, any>,
  ): Promise<UpdateResult> {
    logger.info('Pipedrive restore from snapshot', { entityType, entityId });
    return this.update(entityType, entityId, snapshot);
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string | undefined,
    originalResponse: Record<string, any>,
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Pipedrive semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        return this.delete(entityType, entityId ?? String(originalResponse.id));

      case 'delete':
        return {
          success: false,
          error: 'Cannot restore deleted Pipedrive records — re-create manually',
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
