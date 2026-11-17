// SendGrid Connector Client
// Auth: Bearer token. Authorization: Bearer {api_key}
// api_key is stored as credentials.accessToken (per-tenant in Secret Manager).
// Base URL: https://api.sendgrid.com/v3
// No OAuth — API key only, no refresh needed.

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

const BASE_URL = 'https://api.sendgrid.com/v3';

export class SendGridClient implements CompensationClient {
  readonly connector = 'sendgrid';
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

    let url = `${BASE_URL}${path}`;
    if (queryParams && Object.keys(queryParams).length > 0) {
      url = `${url}?${new URLSearchParams(queryParams).toString()}`;
    }

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
      const error = await response.text();
      logger.error('SendGrid API error', { status: response.status, error, path, method });
      throw new Error(`SendGrid API error: ${response.status} - ${error}`);
    }

    // 202 Accepted (mail/send) or 204 No Content — empty body
    if (response.status === 202 || response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  // ── Email sending ──────────────────────────────────────────────────────────

  async sendEmail(params: {
    to_email: string;
    to_name?: string;
    from_email: string;
    from_name?: string;
    subject: string;
    text_content?: string;
    html_content?: string;
  }): Promise<void> {
    const body: Record<string, any> = {
      personalizations: [
        {
          to: [
            {
              email: params.to_email,
              ...(params.to_name ? { name: params.to_name } : {}),
            },
          ],
        },
      ],
      from: {
        email: params.from_email,
        ...(params.from_name ? { name: params.from_name } : {}),
      },
      subject: params.subject,
      content: [],
    };

    if (params.text_content) {
      body.content.push({ type: 'text/plain', value: params.text_content });
    }
    if (params.html_content) {
      body.content.push({ type: 'text/html', value: params.html_content });
    }

    if ((body.content as unknown[]).length === 0) {
      throw new Error('SendGrid: at least one of text_content or html_content is required');
    }

    await this.request<void>('POST', '/mail/send', body);
  }

  async sendEmailFromTemplate(params: {
    to_email: string;
    from_email: string;
    template_id: string;
    template_data?: Record<string, any>;
  }): Promise<void> {
    const body: Record<string, any> = {
      personalizations: [
        {
          to: [{ email: params.to_email }],
          ...(params.template_data
            ? { dynamic_template_data: params.template_data }
            : {}),
        },
      ],
      from: { email: params.from_email },
      template_id: params.template_id,
    };

    await this.request<void>('POST', '/mail/send', body);
  }

  // ── Contacts ───────────────────────────────────────────────────────────────

  async listContacts(pageSize: number = 100): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('GET', '/marketing/contacts', undefined, {
      page_size: String(Math.min(pageSize, 100)),
    });
  }

  async searchContacts(query: string): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('POST', '/marketing/contacts/search', { query });
  }

  async upsertContacts(
    contacts: Array<{ email: string; first_name?: string; last_name?: string; [key: string]: unknown }>,
    listIds?: string[],
  ): Promise<Record<string, any>> {
    const body: Record<string, any> = { contacts };
    if (listIds && listIds.length > 0) {
      body.list_ids = listIds;
    }
    return this.request<Record<string, any>>('PUT', '/marketing/contacts', body);
  }

  async deleteContacts(ids: string[]): Promise<void> {
    await this.request<void>('DELETE', '/marketing/contacts', undefined, {
      ids: ids.join(','),
    });
  }

  // ── Lists ──────────────────────────────────────────────────────────────────

  async listContactLists(): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('GET', '/marketing/lists');
  }

  async createContactList(name: string): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('POST', '/marketing/lists', { name });
  }

  async deleteContactList(id: string): Promise<void> {
    await this.request<void>('DELETE', `/marketing/lists/${id}`);
  }

  // ── Single sends / campaigns ───────────────────────────────────────────────

  async listSingleSends(): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('GET', '/marketing/singlesends');
  }

  async getSingleSend(id: string): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('GET', `/marketing/singlesends/${id}`);
  }

  async createSingleSend(data: Record<string, any>): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('POST', '/marketing/singlesends', data);
  }

  // ── Templates ──────────────────────────────────────────────────────────────

  async listTemplates(): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('GET', '/templates', undefined, {
      generations: 'dynamic',
    });
  }

  async getTemplate(id: string): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('GET', `/templates/${id}`);
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  async getEmailStats(
    startDate: string,
    endDate?: string,
    aggregatedBy?: string,
  ): Promise<unknown[]> {
    const params: Record<string, string> = { start_date: startDate };
    if (endDate) params.end_date = endDate;
    if (aggregatedBy) params.aggregated_by = aggregatedBy;
    return this.request<unknown[]>('GET', '/stats', undefined, params);
  }

  // ── Suppressions ───────────────────────────────────────────────────────────

  async listUnsubscribes(): Promise<unknown[]> {
    return this.request<unknown[]>('GET', '/suppression/unsubscribes');
  }

  async addGlobalUnsubscribe(email: string): Promise<void> {
    await this.request<void>('POST', '/asm/suppressions/global', {
      recipient_emails: [email],
    });
  }

  // ── CompensationClient interface ─────────────────────────────────────────────

  /**
   * read() — maps entityType to the correct SendGrid API call.
   *
   * Supported entityTypes:
   *   contacts, contacts_search, lists, templates, template,
   *   singlesends, singlesend, stats, unsubscribes
   */
  async read(
    entityType: string,
    entityId: string | undefined,
    payload?: Record<string, any>,
  ): Promise<ExternalRecord> {
    logger.info('SendGrid read', { entityType, entityId });

    switch (entityType) {
      case 'contacts': {
        const pageSize = (payload?.page_size as number) ?? 100;
        const data = await this.listContacts(pageSize);
        return { id: 'contacts', data };
      }

      case 'contacts_search': {
        const query = payload?.query as string;
        if (!query) throw new Error('SendGrid: search_contacts requires a query');
        const data = await this.searchContacts(query);
        return { id: 'contacts_search', data };
      }

      case 'lists': {
        const data = await this.listContactLists();
        return { id: 'lists', data };
      }

      case 'templates': {
        const data = await this.listTemplates();
        return { id: 'templates', data };
      }

      case 'template': {
        const id = entityId ?? '';
        const data = await this.getTemplate(id);
        return { id, data };
      }

      case 'singlesends': {
        const data = await this.listSingleSends();
        return { id: 'singlesends', data };
      }

      case 'singlesend': {
        const id = entityId ?? '';
        const data = await this.getSingleSend(id);
        return { id, data };
      }

      case 'stats': {
        const startDate = payload?.start_date as string;
        if (!startDate) throw new Error('SendGrid: get_email_stats requires start_date');
        const data = await this.getEmailStats(
          startDate,
          payload?.end_date as string | undefined,
          payload?.aggregated_by as string | undefined,
        );
        return { id: 'stats', data: { stats: data } };
      }

      case 'unsubscribes': {
        const data = await this.listUnsubscribes();
        return { id: 'unsubscribes', data: { unsubscribes: data } };
      }

      default:
        throw new Error(`SendGrid: unsupported read entity type "${entityType}"`);
    }
  }

  /**
   * create() — maps entityType to the correct SendGrid write call.
   *
   * Supported entityTypes:
   *   email, email_template, contacts_upsert, list, unsubscribe
   */
  /**
   * list('Contact', filters) — incremental poll of Marketing Contacts.
   *
   * SendGrid Marketing Contacts has NO clean paginated incremental list:
   *   - GET /v3/marketing/contacts returns only a *sample* of up to 50 contacts
   *     plus a contact_count, and is billable — not a real list.
   *   - POST /v3/marketing/contacts/search runs an SGQL `query` and is the only
   *     way to filter by updated_at. It returns up to 50 matching contacts and a
   *     contact_count.
   *
   * We use search with SGQL filtered by updated_at. KNOWN LIMITATION: the search
   * endpoint caps at the first 50 matching contacts and has NO offset/cursor
   * paging, so we always return hasMore:false. A polling window that mutated
   * more than 50 contacts since `since` will only surface the first 50 the API
   * chooses to return; the next cycle (advanced `since`) picks up the rest as
   * they keep changing. This is a SendGrid API constraint, not a bug.
   * (Verified against
   *  https://www.twilio.com/docs/sendgrid/api-reference/contacts/search-contacts
   *  and the SGQL reference: `updated_at` supports BETWEEN/TIMESTAMP literals.)
   */
  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    if (entityType !== 'Contact') return { records: [], hasMore: false, unsupported: true };

    let query: string;
    if (filters?.since) {
      // BETWEEN <since> AND <now> bounds the window so each cycle only re-reads
      // what changed since the last cursor. ISO 8601 TIMESTAMP literals.
      const since = filters.since.toISOString();
      const now = new Date().toISOString();
      query = `updated_at BETWEEN TIMESTAMP '${since}' AND TIMESTAMP '${now}'`;
    } else {
      // No cursor — match all contacts (search requires a non-empty query).
      query = `email LIKE '%@%'`;
    }

    const data = await this.searchContacts(query);
    const result = Array.isArray((data as Record<string, any>).result)
      ? ((data as Record<string, any>).result as Array<Record<string, any>>)
      : [];

    return {
      records: result
        .filter((c) => c.id !== undefined && c.id !== null)
        .map((c) => ({ id: String(c.id), data: c })),
      // SendGrid search caps at 50 with no offset paging — never paginate.
      hasMore: false,
    };
  }


  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('SendGrid create', { entityType });

    try {
      switch (entityType) {
        case 'email': {
          await this.sendEmail({
            to_email: data.to_email as string,
            to_name: data.to_name as string | undefined,
            from_email: data.from_email as string,
            from_name: data.from_name as string | undefined,
            subject: data.subject as string,
            text_content: data.text_content as string | undefined,
            html_content: data.html_content as string | undefined,
          });
          return { success: true, id: 'sent', data: { message: 'Email sent successfully' } };
        }

        case 'email_template': {
          await this.sendEmailFromTemplate({
            to_email: data.to_email as string,
            from_email: data.from_email as string,
            template_id: data.template_id as string,
            template_data: data.template_data as Record<string, any> | undefined,
          });
          return { success: true, id: 'sent', data: { message: 'Template email sent successfully' } };
        }

        case 'contacts_upsert': {
          const contacts = data.contacts as Array<{ email: string }>;
          const listIds = data.list_ids as string[] | undefined;
          const result = await this.upsertContacts(contacts, listIds);
          const jobId = (result as Record<string, any>).job_id as string ?? '';
          return { success: true, id: jobId, data: result };
        }

        case 'list': {
          const result = await this.createContactList(data.name as string);
          const id = (result as Record<string, any>).id as string ?? '';
          return { success: true, id, data: result };
        }

        case 'unsubscribe': {
          await this.addGlobalUnsubscribe(data.email as string);
          return { success: true, id: data.email as string, data: { message: 'Added to global unsubscribe list' } };
        }

        default:
          return {
            success: false,
            id: '',
            error: `SendGrid: unsupported create entity type "${entityType}"`,
          };
      }
    } catch (error) {
      return { success: false, id: '', error: (error as Error).message };
    }
  }

  /**
   * update() — SendGrid has limited update operations at this time.
   * Contacts are upserted (PUT) rather than updated.
   */
  async update(
    entityType: string,
    _entityId: string | undefined,
    _data: Record<string, any>,
  ): Promise<UpdateResult> {
    logger.info('SendGrid update', { entityType });
    return {
      success: false,
      error: `SendGrid: update not supported for entity type "${entityType}" — use upsert_contacts for contacts`,
    };
  }

  /**
   * delete() — maps entityType to the correct SendGrid delete call.
   *
   * Supported entityTypes:
   *   list
   */
  async delete(
    entityType: string,
    entityId: string | undefined,
    _payload?: Record<string, any>,
  ): Promise<DeleteResult> {
    logger.info('SendGrid delete', { entityType, entityId });

    try {
      if (!entityId) {
        return { success: false, error: `SendGrid: delete requires entityId for "${entityType}"` };
      }

      switch (entityType) {
        case 'list':
          await this.deleteContactList(entityId);
          return { success: true };

        default:
          return {
            success: false,
            error: `SendGrid: unsupported delete entity type "${entityType}"`,
          };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  // ── CompensationClient — snapshot / inverse ──────────────────────────────────

  async restore(
    _entityType: string,
    _entityId: string | undefined,
    _snapshot: Record<string, any>,
  ): Promise<UpdateResult> {
    return {
      success: false,
      error: 'SendGrid: restore from snapshot not supported — email sends are irreversible',
    };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    _entityId: string | undefined,
    _originalResponse: Record<string, any>,
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('SendGrid semantic inverse', { entityType, originalAction });

    // Email sends cannot be recalled; list/contact operations are reversible manually.
    return {
      success: false,
      error: `SendGrid: cannot invert "${originalAction}" on "${entityType}" — email sends are irreversible`,
    };
  }
}
