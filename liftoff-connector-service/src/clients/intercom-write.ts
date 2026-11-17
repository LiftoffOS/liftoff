// Intercom Write Connector Client
// Auth: Bearer token (api_key credential — Intercom access token)
// Base URL: https://api.intercom.io
// API Version: 2.11
//
// Intercom's vendor MCP (mcp.intercom.com) is read-only. This client handles
// write operations (create/update/delete) via the Intercom REST API.
//
// Reads must go through the 'intercom' MCP connector.

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

const INTERCOM_API_BASE = 'https://api.intercom.io';
const INTERCOM_API_VERSION = '2.11';

// ─── Intercom domain types ────────────────────────────────────────────────────

interface IntercomConversation {
  type: string;
  id: string;
  created_at: number;
  updated_at: number;
  state: string;
  read: boolean;
}

interface IntercomContact {
  type: string;
  id: string;
  email?: string;
  name?: string;
  phone?: string;
  created_at: number;
  updated_at: number;
}

interface IntercomCompany {
  type: string;
  id: string;
  company_id: string;
  name: string;
  created_at: number;
  updated_at: number;
}

interface IntercomMessage {
  type: string;
  id: string;
  created_at: number;
}

interface IntercomNote {
  type: string;
  id: string;
  body: string;
  created_at: number;
}

interface IntercomTag {
  type: string;
  id: string;
  name: string;
}

interface IntercomTicket {
  type: string;
  id: string;
  created_at: number;
  updated_at: number;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class IntercomWriteClient implements CompensationClient {
  readonly connector = 'intercom_write';
  private credentialProvider: CredentialProvider;

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const credentials = await this.credentialProvider();

    const response = await fetch(`${INTERCOM_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Intercom-Version': INTERCOM_API_VERSION,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.status === 204) return {} as T;

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      logger.error('Intercom Write API error', { status: response.status, path, method, error: errorText });

      if (response.status === 401) {
        throw new Error(`Intercom authentication failed (401): ${errorText}`);
      }
      if (response.status === 403) {
        throw new Error(`Intercom access forbidden (403) — check token scopes: ${errorText}`);
      }
      if (response.status === 404) {
        throw new Error(`Intercom resource not found (404): ${path}`);
      }
      if (response.status === 422) {
        throw new Error(`Intercom validation error (422): ${errorText}`);
      }
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After') ?? '10';
        throw new Error(`Intercom rate limit exceeded (429) — retry after ${retryAfter}s`);
      }

      throw new Error(`Intercom Write API error: ${response.status} - ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  // ── Conversation operations ───────────────────────────────────────────────

  async createConversation(data: {
    from: { type: 'user' | 'contact'; id: string };
    body: string;
  }): Promise<IntercomMessage> {
    return this.request<IntercomMessage>('POST', '/conversations', data);
  }

  async updateConversation(
    conversationId: string,
    data: {
      read?: boolean;
      custom_attributes?: Record<string, unknown>;
      assignee?: { type: string; id: string };
    },
  ): Promise<IntercomConversation> {
    return this.request<IntercomConversation>('PUT', `/conversations/${conversationId}`, data);
  }

  async replyToConversation(
    conversationId: string,
    data: {
      message_type: 'comment' | 'note';
      type: 'admin' | 'user';
      admin_id?: string;
      intercom_user_id?: string;
      body: string;
    },
  ): Promise<IntercomConversation> {
    return this.request<IntercomConversation>('POST', `/conversations/${conversationId}/reply`, data);
  }

  async snoozeConversation(
    conversationId: string,
    adminId: string,
    snoozedUntil: number,
  ): Promise<IntercomConversation> {
    return this.request<IntercomConversation>('POST', `/conversations/${conversationId}/reply`, {
      message_type: 'snoozed',
      type: 'admin',
      admin_id: adminId,
      snoozed_until: snoozedUntil,
    });
  }

  async closeConversation(conversationId: string, adminId: string): Promise<IntercomConversation> {
    return this.request<IntercomConversation>('POST', `/conversations/${conversationId}/reply`, {
      message_type: 'close',
      type: 'admin',
      admin_id: adminId,
    });
  }

  async openConversation(conversationId: string, adminId: string): Promise<IntercomConversation> {
    return this.request<IntercomConversation>('POST', `/conversations/${conversationId}/reply`, {
      message_type: 'open',
      type: 'admin',
      admin_id: adminId,
    });
  }

  async assignConversation(
    conversationId: string,
    adminId: string,
    assigneeId: string,
    assigneeType: 'admin' | 'team' = 'admin',
  ): Promise<IntercomConversation> {
    return this.request<IntercomConversation>('POST', `/conversations/${conversationId}/reply`, {
      message_type: 'assignment',
      type: 'admin',
      admin_id: adminId,
      assignee_id: assigneeId,
      assignee_type: assigneeType,
    });
  }

  // ── Contact operations ────────────────────────────────────────────────────

  async createContact(data: {
    role: 'user' | 'lead';
    email?: string;
    name?: string;
    phone?: string;
    external_id?: string;
    custom_attributes?: Record<string, unknown>;
  }): Promise<IntercomContact> {
    return this.request<IntercomContact>('POST', '/contacts', data);
  }

  async updateContact(
    contactId: string,
    data: {
      email?: string;
      name?: string;
      phone?: string;
      custom_attributes?: Record<string, unknown>;
    },
  ): Promise<IntercomContact> {
    return this.request<IntercomContact>('PUT', `/contacts/${contactId}`, data);
  }

  async deleteContact(contactId: string): Promise<{ id: string; deleted: boolean }> {
    return this.request<{ id: string; deleted: boolean }>('DELETE', `/contacts/${contactId}`);
  }

  async archiveContact(contactId: string): Promise<{ id: string; archived: boolean }> {
    return this.request<{ id: string; archived: boolean }>('POST', `/contacts/${contactId}/archive`);
  }

  async unarchiveContact(contactId: string): Promise<{ id: string; archived: boolean }> {
    return this.request<{ id: string; archived: boolean }>('POST', `/contacts/${contactId}/unarchive`);
  }

  // ── Company operations ────────────────────────────────────────────────────

  // Intercom companies are created or updated via the same POST endpoint (upsert by company_id or name).
  async createOrUpdateCompany(data: {
    company_id?: string;
    name?: string;
    plan?: string;
    monthly_spend?: number;
    industry?: string;
    website?: string;
    custom_attributes?: Record<string, unknown>;
  }): Promise<IntercomCompany> {
    return this.request<IntercomCompany>('POST', '/companies', data);
  }

  async deleteCompany(companyId: string): Promise<void> {
    await this.request<void>('DELETE', `/companies/${companyId}`);
  }

  // ── Message operations ────────────────────────────────────────────────────

  async createMessage(data: {
    message_type: 'inapp' | 'email';
    subject?: string;
    body: string;
    template?: string;
    from: { type: 'admin'; id: string };
    to: { type: 'user' | 'contact'; id: string };
  }): Promise<IntercomMessage> {
    return this.request<IntercomMessage>('POST', '/messages', data);
  }

  // ── Note operations ───────────────────────────────────────────────────────

  async createNote(contactId: string, body: string, adminId: string): Promise<IntercomNote> {
    return this.request<IntercomNote>('POST', `/contacts/${contactId}/notes`, {
      body,
      admin_id: adminId,
    });
  }

  // ── Tag operations ────────────────────────────────────────────────────────

  async createTag(name: string): Promise<IntercomTag> {
    return this.request<IntercomTag>('POST', '/tags', { name });
  }

  async deleteTag(tagId: string): Promise<void> {
    await this.request<void>('DELETE', `/tags/${tagId}`);
  }

  async tagContact(contactId: string, tagId: string): Promise<IntercomTag> {
    return this.request<IntercomTag>('POST', `/contacts/${contactId}/tags`, { id: tagId });
  }

  async untagContact(contactId: string, tagId: string): Promise<void> {
    await this.request<void>('DELETE', `/contacts/${contactId}/tags/${tagId}`);
  }

  async tagConversation(conversationId: string, tagId: string, adminId: string): Promise<IntercomConversation> {
    return this.request<IntercomConversation>('POST', `/conversations/${conversationId}/tags`, {
      id: tagId,
      admin_id: adminId,
    });
  }

  async untagConversation(conversationId: string, tagId: string, adminId: string): Promise<IntercomConversation> {
    return this.request<IntercomConversation>('DELETE', `/conversations/${conversationId}/tags/${tagId}`, {
      admin_id: adminId,
    });
  }

  // ── Ticket operations ─────────────────────────────────────────────────────

  async createTicket(data: {
    ticket_type_id: string;
    contacts: Array<{ id: string }>;
    ticket_attributes?: Record<string, unknown>;
  }): Promise<IntercomTicket> {
    return this.request<IntercomTicket>('POST', '/tickets', data);
  }

  async updateTicket(
    ticketId: string,
    data: {
      ticket_attributes?: Record<string, unknown>;
      state?: 'in_progress' | 'waiting_on_customer' | 'resolved';
      is_shared?: boolean;
      assignment?: { admin_id?: string; team_id?: string };
    },
  ): Promise<IntercomTicket> {
    return this.request<IntercomTicket>('PUT', `/tickets/${ticketId}`, data);
  }

  async replyToTicket(
    ticketId: string,
    data: {
      message_type: 'comment' | 'note';
      type: 'admin' | 'user';
      admin_id?: string;
      intercom_user_id?: string;
      body: string;
    },
  ): Promise<IntercomTicket> {
    return this.request<IntercomTicket>('POST', `/tickets/${ticketId}/reply`, data);
  }

  // ── CompensationClient interface ──────────────────────────────────────────

  async list(_entityType: string, _filters?: ListFilters): Promise<ListResult> {
    throw new Error('IntercomWriteClient is write-only and does not support list()');
  }

  async read(
    entityType: string,
    _entityId: string | undefined,
    _payload?: Record<string, unknown>,
  ): Promise<ExternalRecord> {
    throw new Error(
      `IntercomWriteClient: read is not supported for "${entityType}". ` +
        'Use the intercom (read-only MCP) connector for read operations.',
    );
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    logger.info('Intercom Write create', { entityType });

    try {
      switch (entityType) {
        case 'conversation': {
          const result = await this.createConversation(
            data as Parameters<typeof this.createConversation>[0],
          );
          return { success: true, id: String(result.id ?? ''), data: result as unknown as Record<string, unknown> };
        }

        case 'contact': {
          const result = await this.createContact(
            data as Parameters<typeof this.createContact>[0],
          );
          return { success: true, id: String(result.id ?? ''), data: result as unknown as Record<string, unknown> };
        }

        case 'company': {
          const result = await this.createOrUpdateCompany(
            data as Parameters<typeof this.createOrUpdateCompany>[0],
          );
          return { success: true, id: String(result.id ?? ''), data: result as unknown as Record<string, unknown> };
        }

        case 'message': {
          const result = await this.createMessage(
            data as Parameters<typeof this.createMessage>[0],
          );
          return { success: true, id: String(result.id ?? ''), data: result as unknown as Record<string, unknown> };
        }

        case 'note': {
          const { contact_id, body, admin_id } = data as {
            contact_id: string;
            body: string;
            admin_id: string;
          };
          const result = await this.createNote(contact_id, body, admin_id);
          return { success: true, id: String(result.id ?? ''), data: result as unknown as Record<string, unknown> };
        }

        case 'tag': {
          const result = await this.createTag(data.name as string);
          return { success: true, id: String(result.id ?? ''), data: result as unknown as Record<string, unknown> };
        }

        case 'ticket': {
          const result = await this.createTicket(
            data as Parameters<typeof this.createTicket>[0],
          );
          return { success: true, id: String(result.id ?? ''), data: result as unknown as Record<string, unknown> };
        }

        default:
          return {
            success: false,
            id: '',
            error: `Intercom Write: unsupported create entity type "${entityType}"`,
          };
      }
    } catch (error) {
      return { success: false, id: '', error: (error as Error).message };
    }
  }

  async update(
    entityType: string,
    entityId: string | undefined,
    data: Record<string, unknown>,
  ): Promise<UpdateResult> {
    logger.info('Intercom Write update', { entityType, entityId });

    if (!entityId) {
      return { success: false, error: 'Intercom Write: entityId is required for update' };
    }

    try {
      const { action, ...rest } = data;

      switch (entityType) {
        case 'conversation': {
          if (action === 'reply') {
            const result = await this.replyToConversation(entityId, rest as Parameters<typeof this.replyToConversation>[1]);
            return { success: true, data: result as unknown as Record<string, unknown> };
          }
          if (action === 'close') {
            const result = await this.closeConversation(entityId, rest.admin_id as string);
            return { success: true, data: result as unknown as Record<string, unknown> };
          }
          if (action === 'open') {
            const result = await this.openConversation(entityId, rest.admin_id as string);
            return { success: true, data: result as unknown as Record<string, unknown> };
          }
          if (action === 'snooze') {
            const result = await this.snoozeConversation(entityId, rest.admin_id as string, rest.snoozed_until as number);
            return { success: true, data: result as unknown as Record<string, unknown> };
          }
          if (action === 'assign') {
            const result = await this.assignConversation(
              entityId,
              rest.admin_id as string,
              rest.assignee_id as string,
              (rest.assignee_type as 'admin' | 'team') ?? 'admin',
            );
            return { success: true, data: result as unknown as Record<string, unknown> };
          }
          // Default: attribute update
          const result = await this.updateConversation(entityId, rest as Parameters<typeof this.updateConversation>[1]);
          return { success: true, data: result as unknown as Record<string, unknown> };
        }

        case 'contact': {
          if (action === 'archive') {
            const result = await this.archiveContact(entityId);
            return { success: true, data: result as unknown as Record<string, unknown> };
          }
          if (action === 'unarchive') {
            const result = await this.unarchiveContact(entityId);
            return { success: true, data: result as unknown as Record<string, unknown> };
          }
          if (action === 'tag') {
            const result = await this.tagContact(entityId, rest.tag_id as string);
            return { success: true, data: result as unknown as Record<string, unknown> };
          }
          if (action === 'untag') {
            await this.untagContact(entityId, rest.tag_id as string);
            return { success: true };
          }
          const result = await this.updateContact(entityId, rest as Parameters<typeof this.updateContact>[1]);
          return { success: true, data: result as unknown as Record<string, unknown> };
        }

        case 'company': {
          const result = await this.createOrUpdateCompany({ ...rest, company_id: entityId } as Parameters<typeof this.createOrUpdateCompany>[0]);
          return { success: true, data: result as unknown as Record<string, unknown> };
        }

        case 'ticket': {
          if (action === 'reply') {
            const result = await this.replyToTicket(entityId, rest as Parameters<typeof this.replyToTicket>[1]);
            return { success: true, data: result as unknown as Record<string, unknown> };
          }
          const result = await this.updateTicket(entityId, rest as Parameters<typeof this.updateTicket>[1]);
          return { success: true, data: result as unknown as Record<string, unknown> };
        }

        default:
          return {
            success: false,
            error: `Intercom Write: unsupported update entity type "${entityType}"`,
          };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async delete(
    entityType: string,
    entityId: string | undefined,
    _payload?: Record<string, unknown>,
  ): Promise<DeleteResult> {
    logger.info('Intercom Write delete', { entityType, entityId });

    if (!entityId) {
      return { success: false, error: 'Intercom Write: entityId is required for delete' };
    }

    try {
      switch (entityType) {
        case 'contact':
          await this.deleteContact(entityId);
          return { success: true };

        case 'company':
          await this.deleteCompany(entityId);
          return { success: true };

        case 'tag':
          await this.deleteTag(entityId);
          return { success: true };

        default:
          return {
            success: false,
            error: `Intercom Write: delete not supported for entity type "${entityType}"`,
          };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  // ── CompensationClient — snapshot / inverse ───────────────────────────────

  async restore(
    entityType: string,
    entityId: string | undefined,
    snapshot: Record<string, unknown>,
  ): Promise<UpdateResult> {
    logger.info('Intercom Write restore from snapshot', { entityType, entityId });
    const { id: _id, ...rest } = snapshot;
    return this.update(entityType, entityId, rest);
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string | undefined,
    _originalResponse: Record<string, unknown>,
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Intercom Write semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        if (entityType === 'contact' || entityType === 'tag') {
          return this.delete(entityType, entityId);
        }
        if (entityType === 'company') {
          return this.delete('company', entityId);
        }
        return {
          success: false,
          error: `Intercom Write: cannot invert create for entity type "${entityType}" — delete manually in Intercom`,
        };

      case 'delete':
        return {
          success: false,
          error: 'Intercom Write: cannot restore deleted Intercom records via API',
        };

      case 'update':
        return {
          success: false,
          error: 'Intercom Write: update reversal requires pre-action snapshot',
        };

      default:
        return {
          success: false,
          error: `Intercom Write: unknown action type "${originalAction}"`,
        };
    }
  }
}
