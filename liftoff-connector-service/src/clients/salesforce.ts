// Salesforce Connector Client
// Per Section 11 & 12: Real Salesforce API implementation
//
// Salesforce is composio_managed, so this client is not
// the dispatch path — it is the COMPOSIO_DISABLED_CONNECTORS fallback that keeps
// SALESFORCE_FUNCTIONS servable. That changes what `credentials.accessToken`
// means here: `credentialService.getCredentials` returns '' for a
// composio_managed connector because Composio holds the token, so the raw
// interpolation these methods used would send an empty bearer header and take a
// 401 that reads exactly like an expired grant — the GoogleMailClient
// defect that composio-no-raw-bearer.test.ts exists to stop. bearerFor() turns
// that into MissingBearerTokenError, which names this client and says the call
// belongs on the proxy path.

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
import { bearerFor } from './composio-transport.js';
import { logger } from '../infra/logging.js';

export class SalesforceClient implements CompensationClient {
  readonly connector = 'salesforce';
  private credentialProvider: CredentialProvider;

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, any>
  ): Promise<T> {
    // Always fetch fresh credentials per request — never cache. The provider
    // delegates to credentialService.getCredentials, which handles refresh.
    // Salesforce-specific: instanceUrl can change after token refresh in
    // edge cases (multi-org, sandbox vs prod), so resolve baseUrl per request
    // rather than freezing it at construction time.
    const credentials = await this.credentialProvider();
    const baseUrl = credentials.instanceUrl || 'https://login.salesforce.com';
    const url = `${baseUrl}/services/data/v59.0${path}`;

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${bearerFor(credentials, 'salesforce')}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('Salesforce API error', { status: response.status, error, path });
      throw new Error(`Salesforce API error: ${response.status} - ${error}`);
    }

    // Handle 204 No Content for DELETE
    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, any>): Promise<ExternalRecord> {
    logger.info('Salesforce read', { entityType, entityId });

    const soqlListTypes: Record<string, string> = { contacts: 'Contact', leads: 'Lead', accounts: 'Account' };
    if (soqlListTypes[entityType]) {
      const sobject = soqlListTypes[entityType];
      const p = payload ?? {};
      const limit = p.limit as number ?? 100;
      const where = p.where as string | undefined;
      const soql = `SELECT Id, Name, LastModifiedDate FROM ${sobject}${where ? ` WHERE ${where}` : ''} ORDER BY LastModifiedDate DESC LIMIT ${limit}`;
      const credentials = await this.credentialProvider();
      const baseUrl = credentials.instanceUrl || 'https://login.salesforce.com';
      const resp = await fetch(`${baseUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`, {
        headers: { Authorization: `Bearer ${bearerFor(credentials, 'salesforce')}`, 'Content-Type': 'application/json' },
      });
      if (!resp.ok) throw new Error(`Salesforce list ${sobject} failed: ${resp.status}`);
      const body = await resp.json() as { records: Record<string, unknown>[]; nextRecordsUrl?: string; done?: boolean };
      return {
        id: entityType,
        data: { records: body.records, hasMore: !body.done, nextPageToken: body.nextRecordsUrl },
      };
    }

    if (entityType === 'activity') {
      if (!entityId) throw new Error('entityId required for activity read');
      const credentials = await this.credentialProvider();
      const baseUrl = credentials.instanceUrl || 'https://login.salesforce.com';
      const taskSoql = `SELECT Id, Subject, Description, Type, Status, ActivityDate, CreatedDate, OwnerId FROM Task WHERE WhatId = '${entityId}' ORDER BY CreatedDate DESC LIMIT 50`;
      const eventSoql = `SELECT Id, Subject, Description, Type, StartDateTime, EndDateTime, CreatedDate, OwnerId FROM Event WHERE WhatId = '${entityId}' ORDER BY StartDateTime DESC LIMIT 25`;

      const [taskRes, eventRes] = await Promise.all([
        fetch(`${baseUrl}/services/data/v59.0/query?q=${encodeURIComponent(taskSoql)}`, {
          headers: { Authorization: `Bearer ${bearerFor(credentials, 'salesforce')}`, 'Content-Type': 'application/json' },
        }),
        fetch(`${baseUrl}/services/data/v59.0/query?q=${encodeURIComponent(eventSoql)}`, {
          headers: { Authorization: `Bearer ${bearerFor(credentials, 'salesforce')}`, 'Content-Type': 'application/json' },
        }),
      ]);

      if (!taskRes.ok) throw new Error(`Salesforce activity tasks query failed: ${taskRes.status}`);
      if (!eventRes.ok) throw new Error(`Salesforce activity events query failed: ${eventRes.status}`);

      const tasks = (await taskRes.json() as { records: Record<string, any>[] }).records;
      const events = (await eventRes.json() as { records: Record<string, any>[] }).records;

      return {
        id: entityId,
        data: {
          recordId: entityId,
          tasks,
          events,
          totalActivities: tasks.length + events.length,
        },
      };
    }

    if (!entityId) throw new Error(`entityId required for ${entityType} read`);
    const data = await this.request<Record<string, any>>(
      'GET',
      `/sobjects/${entityType}/${entityId}`
    );

    return {
      id: entityId,
      data,
      versionToken: data.SystemModstamp,
      lastModified: new Date(data.LastModifiedDate),
    };
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const supported = new Set(['Lead', 'Opportunity', 'Contact', 'Account']);
    if (!supported.has(entityType)) return { records: [], hasMore: false, unsupported: true };
    const credentials = await this.credentialProvider();
    const baseUrl = credentials.instanceUrl || 'https://login.salesforce.com';

    const sinceIso = filters?.since
      ? filters.since.toISOString()
      : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const limit = filters?.limit ?? 200;

    let url: string;
    if (filters?.pageToken) {
      // pageToken is the nextRecordsUrl path from Salesforce
      url = `${baseUrl}${filters.pageToken}`;
    } else {
      const soql = `SELECT Id, LastModifiedDate FROM ${entityType} WHERE LastModifiedDate >= ${sinceIso} ORDER BY LastModifiedDate LIMIT ${limit}`;
      url = `${baseUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`;
    }
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${bearerFor(credentials, 'salesforce')}`, 'Content-Type': 'application/json' },
    });
    if (!resp.ok) throw new Error(`Salesforce list ${entityType} failed: ${resp.status}`);
    const body = (await resp.json()) as { records?: Record<string, unknown>[]; nextRecordsUrl?: string; done?: boolean };
    return {
      records: (body.records ?? []).map(r => ({ id: String(r['Id']), data: r })),
      nextPageToken: body.nextRecordsUrl ?? undefined,
      hasMore: !body.done,
    };
  }

  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Salesforce create', { entityType });

    try {
      const result = await this.request<{ id: string; success: boolean }>(
        'POST',
        `/sobjects/${entityType}`,
        data
      );

      return {
        success: result.success,
        id: result.id,
        data: { ...data, Id: result.id },
      };
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
    logger.info('Salesforce update', { entityType, entityId });

    try {
      await this.request<void>('PATCH', `/sobjects/${entityType}/${entityId}`, data);

      // Fetch updated record to get new version token
      const updated = await this.read(entityType, entityId);

      return {
        success: true,
        versionToken: updated.versionToken,
        data: updated.data,
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async delete(entityType: string, entityId: string): Promise<DeleteResult> {
    logger.info('Salesforce delete', { entityType, entityId });

    try {
      await this.request<void>('DELETE', `/sobjects/${entityType}/${entityId}`);
      return { success: true };
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
    logger.info('Salesforce restore from snapshot', { entityType, entityId });

    // Remove read-only fields before restore
    const writableFields = this.filterWritableFields(snapshot);
    return this.update(entityType, entityId, writableFields);
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string,
    originalResponse: Record<string, any>
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Salesforce semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        // Delete what was created
        return this.delete(entityType, entityId || originalResponse.id);

      case 'delete':
        // Cannot truly recreate - would need snapshot
        return {
          success: false,
          error: 'Cannot restore deleted Salesforce records without undelete permission',
        };

      case 'update':
        // Would need snapshot to restore previous state
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

  private filterWritableFields(data: Record<string, any>): Record<string, any> {
    // Salesforce read-only fields that cannot be written
    const readOnlyFields = [
      'Id',
      'IsDeleted',
      'CreatedDate',
      'CreatedById',
      'LastModifiedDate',
      'LastModifiedById',
      'SystemModstamp',
      'LastActivityDate',
      'LastViewedDate',
      'LastReferencedDate',
      'attributes',
    ];

    const writable: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      if (!readOnlyFields.includes(key) && !key.endsWith('__r')) {
        writable[key] = value;
      }
    }
    return writable;
  }
}
