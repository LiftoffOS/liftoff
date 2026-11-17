// HubSpot Write Connector Client
// Tier 3 write sidecar for HubSpot CRM operations.
// API Reference: mcp-servers/hubspot-write/API_REFERENCE.md
//
// HubSpot's vendor MCP (mcp.hubspot.com) is read-only. This client handles
// write operations (create/update/delete) via the CRM REST API v3.
//
// Base URL: https://api.hubapi.com/crm/v3
// Auth: OAuth2 Bearer token via CredentialProvider closure.
// Credentials: reuses the existing 'hubspot' OAuth app (same OAuth flow,
// same token — hubspot_write is the write-path extension, not a new integration).

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

const HUBSPOT_API_BASE = 'https://api.hubapi.com/crm/v3';

// Activity type → HubSpot CRM object type mapping
const ACTIVITY_TYPE_MAP: Record<string, string> = {
  note: 'notes',
  email: 'emails',
  call: 'calls',
};

export class HubSpotWriteClient implements CompensationClient {
  readonly connector = 'hubspot_write';
  private credentialProvider: CredentialProvider;

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    // Always fetch fresh credentials — provider handles token refresh.
    const credentials = await this.credentialProvider();

    const url = `${HUBSPOT_API_BASE}${path}`;

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      logger.error('HubSpot Write API error', { status: response.status, path, method, error: errorText });

      if (response.status === 401) {
        throw new Error(`HubSpot authentication failed (401): ${errorText}`);
      }
      if (response.status === 403) {
        throw new Error(`HubSpot access forbidden (403) — check OAuth scopes: ${errorText}`);
      }
      if (response.status === 404) {
        throw new Error(`HubSpot resource not found (404): ${path}`);
      }
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After') ?? '10';
        throw new Error(`HubSpot rate limit exceeded (429) — retry after ${retryAfter}s`);
      }

      throw new Error(`HubSpot Write API error: ${response.status} - ${errorText}`);
    }

    // 204 No Content (DELETE)
    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  // ── Contact operations ──────────────────────────────────────────────────────

  async createContact(properties: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('POST', '/objects/contacts', { properties });
  }

  async updateContact(contactId: string, properties: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('PATCH', `/objects/contacts/${contactId}`, { properties });
  }

  async deleteContact(contactId: string): Promise<void> {
    await this.request<void>('DELETE', `/objects/contacts/${contactId}`);
  }

  // ── Deal operations ─────────────────────────────────────────────────────────

  async createDeal(properties: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('POST', '/objects/deals', { properties });
  }

  async updateDeal(dealId: string, properties: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('PATCH', `/objects/deals/${dealId}`, { properties });
  }

  // ── Company operations ──────────────────────────────────────────────────────

  async createCompany(properties: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('POST', '/objects/companies', { properties });
  }

  async updateCompany(companyId: string, properties: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('PATCH', `/objects/companies/${companyId}`, { properties });
  }

  // ── Engagement operations ───────────────────────────────────────────────────

  /**
   * Log an activity (note, email, or call) and optionally associate it with a CRM object.
   * Defaults to 'note' if activity_type is not specified.
   */
  async logActivity(
    activityType: string,
    properties: Record<string, unknown>,
    associations?: Array<{ objectType: string; objectId: string }>,
  ): Promise<Record<string, unknown>> {
    const objectType = ACTIVITY_TYPE_MAP[activityType] ?? 'notes';

    const body: Record<string, unknown> = { properties };

    if (associations && associations.length > 0) {
      body.associations = associations.map(({ objectType: assocType, objectId }) => ({
        to: { id: objectId },
        types: [
          {
            associationCategory: 'HUBSPOT_DEFINED',
            // Note association type IDs: contact=202, company=190, deal=214
            associationTypeId: this.getAssociationTypeId(assocType, objectType),
          },
        ],
      }));
    }

    return this.request<Record<string, unknown>>('POST', `/objects/${objectType}`, body);
  }

  private getAssociationTypeId(objectType: string, engagementType: string): number {
    // Standard HubSpot association type IDs for notes
    const noteAssocTypeIds: Record<string, number> = {
      contact: 202,
      company: 190,
      deal: 214,
    };
    // For emails and calls, IDs differ — fall back to note IDs as a safe default
    if (engagementType === 'notes') {
      return noteAssocTypeIds[objectType] ?? 202;
    }
    return 202;
  }

  // ── CompensationClient interface ────────────────────────────────────────────

  async list(_entityType: string, _filters?: ListFilters): Promise<ListResult> {
    throw new Error('HubSpotWriteClient is write-only and does not support list()');
  }

  /**
   * read() — HubSpotWriteClient is write-only. Use the hubspot (MCP) connector for reads.
   */
  async read(
    entityType: string,
    _entityId: string | undefined,
    _payload?: Record<string, unknown>,
  ): Promise<ExternalRecord> {
    throw new Error(
      `HubSpotWriteClient: read is not supported for "${entityType}". ` +
      'Use the hubspot (read-only MCP) connector for read operations.',
    );
  }

  /**
   * create() — creates a CRM object.
   *
   * Supported entityTypes: 'contact', 'deal', 'company', 'engagement'
   */
  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    logger.info('HubSpot Write create', { entityType });

    try {
      switch (entityType) {
        case 'contact': {
          const { id: _id, ...properties } = data;
          const result = await this.createContact(properties);
          return { success: true, id: String(result.id ?? ''), data: result };
        }

        case 'deal': {
          const { id: _id, ...properties } = data;
          const result = await this.createDeal(properties);
          return { success: true, id: String(result.id ?? ''), data: result };
        }

        case 'company': {
          const { id: _id, ...properties } = data;
          const result = await this.createCompany(properties);
          return { success: true, id: String(result.id ?? ''), data: result };
        }

        case 'engagement': {
          const activityType = (data.activity_type as string | undefined) ?? 'note';
          const { activity_type: _at, id: _id, associations, ...properties } = data;
          const assocs = associations as Array<{ objectType: string; objectId: string }> | undefined;
          const result = await this.logActivity(activityType, properties, assocs);
          return { success: true, id: String(result.id ?? ''), data: result };
        }

        default:
          return {
            success: false,
            id: '',
            error: `HubSpot Write: unsupported create entity type "${entityType}"`,
          };
      }
    } catch (error) {
      return { success: false, id: '', error: (error as Error).message };
    }
  }

  /**
   * update() — updates a CRM object by ID.
   *
   * Supported entityTypes: 'contact', 'deal', 'company'
   */
  async update(
    entityType: string,
    entityId: string | undefined,
    data: Record<string, unknown>,
  ): Promise<UpdateResult> {
    logger.info('HubSpot Write update', { entityType, entityId });

    if (!entityId) {
      return { success: false, error: 'HubSpot Write: entityId is required for update' };
    }

    try {
      switch (entityType) {
        case 'contact': {
          const { id: _id, ...properties } = data;
          const result = await this.updateContact(entityId, properties);
          return { success: true, data: result };
        }

        case 'deal': {
          const { id: _id, ...properties } = data;
          const result = await this.updateDeal(entityId, properties);
          return { success: true, data: result };
        }

        case 'company': {
          const { id: _id, ...properties } = data;
          const result = await this.updateCompany(entityId, properties);
          return { success: true, data: result };
        }

        default:
          return {
            success: false,
            error: `HubSpot Write: unsupported update entity type "${entityType}"`,
          };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * delete() — soft-deletes (moves to recycling bin) a CRM object.
   *
   * Supported entityTypes: 'contact'
   */
  async delete(
    entityType: string,
    entityId: string | undefined,
    _payload?: Record<string, unknown>,
  ): Promise<DeleteResult> {
    logger.info('HubSpot Write delete', { entityType, entityId });

    if (!entityId) {
      return { success: false, error: 'HubSpot Write: entityId is required for delete' };
    }

    try {
      switch (entityType) {
        case 'contact':
          await this.deleteContact(entityId);
          return { success: true };

        default:
          return {
            success: false,
            error: `HubSpot Write: delete not supported for entity type "${entityType}"`,
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
    snapshot: Record<string, unknown>,
  ): Promise<UpdateResult> {
    logger.info('HubSpot Write restore from snapshot', { entityType, entityId });
    const { id: _id, ...properties } = snapshot;
    return this.update(entityType, entityId, properties);
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string | undefined,
    _originalResponse: Record<string, unknown>,
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('HubSpot Write semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        // Invert a create by deleting (moving to recycling bin).
        if (entityType === 'contact') {
          return this.delete('contact', entityId);
        }
        return {
          success: false,
          error: `HubSpot Write: cannot invert create for entity type "${entityType}" — delete manually in HubSpot`,
        };

      case 'delete':
        return {
          success: false,
          error: 'HubSpot Write: cannot restore deleted records via API — restore from recycling bin in HubSpot UI',
        };

      case 'update':
        return {
          success: false,
          error: 'HubSpot Write: update reversal requires pre-action snapshot',
        };

      default:
        return {
          success: false,
          error: `HubSpot Write: unknown action type "${originalAction}"`,
        };
    }
  }
}
