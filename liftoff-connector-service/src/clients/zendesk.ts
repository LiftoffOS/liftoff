// Zendesk Connector Client
// Auth: OAuth Bearer token
// Base URL: https://{subdomain}.zendesk.com/api/v2 where subdomain comes from credential instanceUrl

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

// ─── Zendesk domain types ─────────────────────────────────────────────────────

interface ZendeskTicket {
  id: number;
  subject: string;
  status: string;
  priority: string | null;
  requester_id: number;
  assignee_id: number | null;
  organization_id: number | null;
  created_at: string;
  updated_at: string;
  description: string;
  tags?: string[];
  custom_fields?: Array<{ id: number; value: unknown }>;
}

interface ZendeskUser {
  id: number;
  name: string;
  email: string;
  role: string;
  active: boolean;
  organization_id: number | null;
  phone: string | null;
  created_at: string;
  updated_at: string;
}

interface ZendeskOrganization {
  id: number;
  name: string;
  domain_names: string[];
  created_at: string;
  updated_at: string;
}

interface ZendeskArticle {
  id: number;
  title: string;
  body: string;
  html_url?: string;
  section_id: number;
  locale: string;
  author_id: number;
  created_at: string;
  updated_at: string;
  promoted: boolean;
}

interface ZendeskMeta {
  has_more: boolean;
  after_cursor?: string;
  before_cursor?: string;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class ZendeskClient implements CompensationClient {
  readonly connector = 'zendesk';
  private credentialProvider: CredentialProvider;

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  // ── Subdomain resolution ──────────────────────────────────────────────────

  /**
   * Resolve the Zendesk subdomain from the credential instanceUrl.
   * instanceUrl format: https://subdomain.zendesk.com or just "subdomain"
   */
  private getSubdomain(instanceUrl: string | undefined): string {
    if (!instanceUrl) {
      throw new Error('Zendesk: instanceUrl (subdomain) is required in credential metadata');
    }
    // Handle both "https://acme.zendesk.com" and bare "acme"
    const match = instanceUrl.match(/(?:https?:\/\/)?([^.]+)(?:\.zendesk\.com)?/);
    if (!match || !match[1]) {
      throw new Error(`Zendesk: cannot extract subdomain from instanceUrl: ${instanceUrl}`);
    }
    return match[1];
  }

  // ── HTTP transport ─────────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, any>,
    queryParams?: Record<string, string>,
  ): Promise<T> {
    const credentials = await this.credentialProvider();
    const subdomain = this.getSubdomain(credentials.instanceUrl);

    const baseUrl = `https://${subdomain}.zendesk.com/api/v2`;
    let url = `${baseUrl}${path}`;

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
      logger.error('Zendesk API error', { status: response.status, error, path, method });
      throw new Error(`Zendesk API error: ${response.status} - ${error}`);
    }

    // 204 No Content
    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  // ── Ticket operations ─────────────────────────────────────────────────────

  async listTickets(params?: {
    pageSize?: number;
    pageAfter?: string;
    sortBy?: string;
    sortOrder?: string;
  }): Promise<{ tickets: ZendeskTicket[]; meta: ZendeskMeta }> {
    const queryParams: Record<string, string> = {};
    if (params?.pageSize) queryParams['page[size]'] = String(params.pageSize);
    if (params?.pageAfter) queryParams['page[after]'] = params.pageAfter;
    if (params?.sortBy) queryParams['sort_by'] = params.sortBy;
    if (params?.sortOrder) queryParams['sort_order'] = params.sortOrder;
    return this.request<{ tickets: ZendeskTicket[]; meta: ZendeskMeta }>('GET', '/tickets', undefined, queryParams);
  }

  async getTicket(ticketId: number | string): Promise<ZendeskTicket> {
    const result = await this.request<{ ticket: ZendeskTicket }>('GET', `/tickets/${ticketId}`);
    return result.ticket;
  }

  async createTicket(data: {
    subject?: string;
    comment: { body: string };
    priority?: string;
    requester_id?: number;
    assignee_id?: number;
    group_id?: number;
    tags?: string[];
  }): Promise<ZendeskTicket> {
    const result = await this.request<{ ticket: ZendeskTicket }>('POST', '/tickets', { ticket: data });
    return result.ticket;
  }

  async updateTicket(
    ticketId: number | string,
    data: {
      subject?: string;
      status?: string;
      priority?: string;
      assignee_id?: number;
      tags?: string[];
      comment?: { body: string; public?: boolean; author_id?: number };
    },
  ): Promise<ZendeskTicket> {
    const result = await this.request<{ ticket: ZendeskTicket }>('PUT', `/tickets/${ticketId}`, { ticket: data });
    return result.ticket;
  }

  async addComment(
    ticketId: number | string,
    comment: { body: string; public?: boolean; author_id?: number },
  ): Promise<ZendeskTicket> {
    return this.updateTicket(ticketId, { comment });
  }

  async searchTickets(query: string, params?: { pageSize?: number; pageAfter?: string }): Promise<{ results: ZendeskTicket[]; count: number }> {
    const queryParams: Record<string, string> = { query };
    if (params?.pageSize) queryParams['page[size]'] = String(params.pageSize);
    if (params?.pageAfter) queryParams['page[after]'] = params.pageAfter;
    return this.request<{ results: ZendeskTicket[]; count: number }>('GET', '/search', undefined, queryParams);
  }

  // ── User operations ───────────────────────────────────────────────────────

  async listUsers(params?: {
    role?: string;
    pageSize?: number;
    pageAfter?: string;
  }): Promise<{ users: ZendeskUser[]; meta: ZendeskMeta }> {
    const queryParams: Record<string, string> = {};
    if (params?.role) queryParams['role'] = params.role;
    if (params?.pageSize) queryParams['page[size]'] = String(params.pageSize);
    if (params?.pageAfter) queryParams['page[after]'] = params.pageAfter;
    return this.request<{ users: ZendeskUser[]; meta: ZendeskMeta }>('GET', '/users', undefined, queryParams);
  }

  async getUser(userId: number | string): Promise<ZendeskUser> {
    const result = await this.request<{ user: ZendeskUser }>('GET', `/users/${userId}`);
    return result.user;
  }

  async createUser(data: {
    name: string;
    email?: string;
    role?: string;
    organization_id?: number;
    phone?: string;
  }): Promise<ZendeskUser> {
    const result = await this.request<{ user: ZendeskUser }>('POST', '/users', { user: data });
    return result.user;
  }

  async updateUser(
    userId: number | string,
    data: {
      name?: string;
      email?: string;
      role?: string;
      organization_id?: number;
      phone?: string;
    },
  ): Promise<ZendeskUser> {
    const result = await this.request<{ user: ZendeskUser }>('PUT', `/users/${userId}`, { user: data });
    return result.user;
  }

  // ── Organization operations ───────────────────────────────────────────────

  async listOrganizations(params?: {
    pageSize?: number;
    pageAfter?: string;
  }): Promise<{ organizations: ZendeskOrganization[]; meta: ZendeskMeta }> {
    const queryParams: Record<string, string> = {};
    if (params?.pageSize) queryParams['page[size]'] = String(params.pageSize);
    if (params?.pageAfter) queryParams['page[after]'] = params.pageAfter;
    return this.request<{ organizations: ZendeskOrganization[]; meta: ZendeskMeta }>('GET', '/organizations', undefined, queryParams);
  }

  async getOrganization(orgId: number | string): Promise<ZendeskOrganization> {
    const result = await this.request<{ organization: ZendeskOrganization }>('GET', `/organizations/${orgId}`);
    return result.organization;
  }

  // ── Knowledge Base (Help Center) operations ───────────────────────────────

  async listArticles(params?: {
    locale?: string;
    sortBy?: string;
    sortOrder?: string;
    pageSize?: number;
    pageAfter?: string;
  }): Promise<{ articles: ZendeskArticle[]; meta: ZendeskMeta }> {
    const queryParams: Record<string, string> = {};
    if (params?.locale) queryParams['locale'] = params.locale;
    if (params?.sortBy) queryParams['sort_by'] = params.sortBy;
    if (params?.sortOrder) queryParams['sort_order'] = params.sortOrder;
    if (params?.pageSize) queryParams['page[size]'] = String(params.pageSize);
    if (params?.pageAfter) queryParams['page[after]'] = params.pageAfter;
    return this.request<{ articles: ZendeskArticle[]; meta: ZendeskMeta }>('GET', '/help_center/articles', undefined, queryParams);
  }

  async getArticle(articleId: number | string): Promise<ZendeskArticle> {
    const result = await this.request<{ article: ZendeskArticle }>('GET', `/help_center/articles/${articleId}`);
    return result.article;
  }

  async listCategories(params?: {
    locale?: string;
    pageSize?: number;
    pageAfter?: string;
  }): Promise<{ categories: Array<{ id: number; name: string; html_url: string }>; meta: ZendeskMeta }> {
    const queryParams: Record<string, string> = {};
    if (params?.locale) queryParams['locale'] = params.locale;
    if (params?.pageSize) queryParams['page[size]'] = String(params.pageSize);
    if (params?.pageAfter) queryParams['page[after]'] = params.pageAfter;
    return this.request<{ categories: Array<{ id: number; name: string; html_url: string }>; meta: ZendeskMeta }>(
      'GET', '/help_center/categories', undefined, queryParams
    );
  }

  async listSectionsByCategory(categoryId: string | number, params?: {
    locale?: string;
    pageAfter?: string;
  }): Promise<{ sections: Array<{ id: number; name: string; html_url: string; category_id: number }>; meta: ZendeskMeta }> {
    const queryParams: Record<string, string> = {};
    if (params?.locale) queryParams['locale'] = params.locale;
    if (params?.pageAfter) queryParams['page[after]'] = params.pageAfter;
    return this.request<{ sections: Array<{ id: number; name: string; html_url: string; category_id: number }>; meta: ZendeskMeta }>(
      'GET', `/help_center/categories/${categoryId}/sections`, undefined, queryParams
    );
  }

  async listArticlesBySection(sectionId: string | number, params?: {
    locale?: string;
    pageAfter?: string;
  }): Promise<{ articles: ZendeskArticle[]; meta: ZendeskMeta }> {
    const queryParams: Record<string, string> = {};
    if (params?.locale) queryParams['locale'] = params.locale;
    if (params?.pageAfter) queryParams['page[after]'] = params.pageAfter;
    return this.request<{ articles: ZendeskArticle[]; meta: ZendeskMeta }>(
      'GET', `/help_center/sections/${sectionId}/articles`, undefined, queryParams
    );
  }

  async searchArticles(params: {
    query: string;
    locale?: string;
    sectionId?: string;
    perPage?: number;
    page?: number;
  }): Promise<{ results: ZendeskArticle[]; count: number }> {
    const queryParams: Record<string, string> = { query: params.query };
    if (params.locale) queryParams['locale'] = params.locale;
    if (params.sectionId) queryParams['section_id'] = params.sectionId;
    if (params.perPage) queryParams['per_page'] = String(params.perPage);
    if (params.page) queryParams['page'] = String(params.page);
    return this.request<{ results: ZendeskArticle[]; count: number }>('GET', '/help_center/articles/search', undefined, queryParams);
  }

  // ── CompensationClient interface ──────────────────────────────────────────

  /**
   * read() — maps entity type to the correct Zendesk API call.
   *
   * Supported entityTypes:
   *   - 'tickets'      → listTickets(payload params)
   *   - 'ticket'       → getTicket(entityId)
   *   - 'search'       → searchTickets(payload.query)
   *   - 'users'        → listUsers(payload params)
   *   - 'user'         → getUser(entityId)
   *   - 'organizations'→ listOrganizations(payload params)
   *   - 'organization' → getOrganization(entityId)
   *   - 'articles'     → listArticles(payload params)
   *   - 'article'      → getArticle(entityId)
   *   - 'articles_search' → searchArticles(payload params)
   */
  async read(
    entityType: string,
    entityId: string | undefined,
    payload?: Record<string, any>,
  ): Promise<ExternalRecord> {
    logger.info('Zendesk read', { entityType, entityId });

    switch (entityType) {
      case 'ticket': {
        const id = entityId ?? (payload?.id as string);
        if (!id) throw new Error('Zendesk: ticket read requires entityId or payload.id');
        const data = await this.getTicket(id);
        return {
          id: String(data.id),
          data: data as unknown as Record<string, any>,
          lastModified: data.updated_at ? new Date(data.updated_at) : undefined,
        };
      }

      case 'comments': {
        const id = entityId ?? (payload?.id as string);
        if (!id) throw new Error('Zendesk: comments read requires entityId or payload.id');
        const data = await this.request<{ comments: Record<string, any>[]; next_page?: string }>(
          'GET',
          `/tickets/${id}/comments.json?sort_order=asc`,
        );
        return {
          id,
          data: {
            ticketId: id,
            commentCount: data.comments.length,
            comments: data.comments,
          },
        };
      }

      case 'tickets': {
        const data = await this.listTickets({
          pageSize: payload?.pageSize as number | undefined,
          pageAfter: payload?.pageAfter as string | undefined,
          sortBy: payload?.sortBy as string | undefined,
          sortOrder: payload?.sortOrder as string | undefined,
        });
        return {
          id: 'tickets',
          data: data as unknown as Record<string, any>,
        };
      }

      case 'search': {
        const query = (payload?.query as string) ?? '';
        if (!query) throw new Error('Zendesk: search requires payload.query');
        const data = await this.searchTickets(query, {
          pageSize: payload?.pageSize as number | undefined,
        });
        return {
          id: 'search',
          data: data as unknown as Record<string, any>,
        };
      }

      case 'user': {
        const id = entityId ?? (payload?.id as string);
        if (!id) throw new Error('Zendesk: user read requires entityId or payload.id');
        const data = await this.getUser(id);
        return {
          id: String(data.id),
          data: data as unknown as Record<string, any>,
          lastModified: data.updated_at ? new Date(data.updated_at) : undefined,
        };
      }

      case 'users': {
        const data = await this.listUsers({
          role: payload?.role as string | undefined,
          pageSize: payload?.pageSize as number | undefined,
          pageAfter: payload?.pageAfter as string | undefined,
        });
        return {
          id: 'users',
          data: data as unknown as Record<string, any>,
        };
      }

      case 'organization': {
        const id = entityId ?? (payload?.id as string);
        if (!id) throw new Error('Zendesk: organization read requires entityId or payload.id');
        const data = await this.getOrganization(id);
        return {
          id: String(data.id),
          data: data as unknown as Record<string, any>,
          lastModified: data.updated_at ? new Date(data.updated_at) : undefined,
        };
      }

      case 'organizations': {
        const data = await this.listOrganizations({
          pageSize: payload?.pageSize as number | undefined,
          pageAfter: payload?.pageAfter as string | undefined,
        });
        return {
          id: 'organizations',
          data: data as unknown as Record<string, any>,
        };
      }

      case 'article': {
        const id = entityId ?? (payload?.id as string);
        if (!id) throw new Error('Zendesk: article read requires entityId or payload.id');
        const data = await this.getArticle(id);
        return {
          id: String(data.id),
          data: data as unknown as Record<string, any>,
          lastModified: data.updated_at ? new Date(data.updated_at) : undefined,
        };
      }

      case 'articles': {
        const data = await this.listArticles({
          locale: payload?.locale as string | undefined,
          sortBy: payload?.sortBy as string | undefined,
          sortOrder: payload?.sortOrder as string | undefined,
          pageSize: payload?.pageSize as number | undefined,
          pageAfter: payload?.pageAfter as string | undefined,
        });
        return {
          id: 'articles',
          data: data as unknown as Record<string, any>,
        };
      }

      case 'articles_search': {
        const query = (payload?.query as string) ?? '';
        if (!query) throw new Error('Zendesk: articles_search requires payload.query');
        const data = await this.searchArticles({
          query,
          locale: payload?.locale as string | undefined,
          sectionId: payload?.sectionId as string | undefined,
          perPage: payload?.perPage as number | undefined,
          page: payload?.page as number | undefined,
        });
        return {
          id: 'articles_search',
          data: data as unknown as Record<string, any>,
        };
      }

      default:
        throw new Error(`Zendesk: unsupported read entity type "${entityType}"`);
    }
  }

  /**
   * create() — maps entity type to the correct write operation.
   *
   * Supported entityTypes:
   *   - 'ticket'  → createTicket(data)
   *   - 'comment' → addComment(data.ticketId, data.body, data.public)
   *   - 'user'    → createUser(data)
   */
  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    switch (entityType) {
      case 'Ticket': {
        const result = await this.listTickets({
          pageAfter: filters?.pageToken,
          pageSize: filters?.limit,
        });
        const records: ExternalRecord[] = result.tickets.map(t => ({
          id: String(t.id),
          data: t as unknown as Record<string, any>,
          lastModified: new Date(t.updated_at),
        }));
        return {
          records,
          hasMore: result.meta.has_more,
          nextPageToken: result.meta.has_more ? result.meta.after_cursor : undefined,
        };
      }
      case 'Article': {
        const result = await this.listArticles({
          pageAfter: filters?.pageToken,
          pageSize: filters?.limit,
        });
        const records: ExternalRecord[] = result.articles.map(a => ({
          id: String(a.id),
          data: a as unknown as Record<string, any>,
          lastModified: new Date(a.updated_at),
        }));
        return {
          records,
          hasMore: result.meta.has_more,
          nextPageToken: result.meta.has_more ? result.meta.after_cursor : undefined,
        };
      }

      // Browse hierarchy: root → categories → sections → articles
      case 'root': {
        // Synthesize a single item representing the whole help center
        return {
          records: [{
            id: 'root',
            data: { title: 'Help Center', contentType: 'collection', url: null, metadata: {} },
          }],
          hasMore: false,
        };
      }
      case 'category': {
        const f = filters as Record<string, unknown> | undefined;
        const result = await this.listCategories({
          pageAfter: f?.pageToken as string | undefined,
        });
        return {
          records: result.categories.map(c => ({
            id: String(c.id),
            data: { title: c.name, contentType: 'collection', url: c.html_url, metadata: { categoryId: c.id, expandEntityType: 'section' } },
          })),
          hasMore: result.meta.has_more,
          nextPageToken: result.meta.has_more ? result.meta.after_cursor : undefined,
        };
      }
      case 'section': {
        const f = filters as Record<string, unknown> | undefined;
        const folderId = f?.folderId as string | undefined;
        if (!folderId) return { records: [], hasMore: false };
        const result = await this.listSectionsByCategory(folderId, {
          pageAfter: f?.pageToken as string | undefined,
        });
        return {
          records: result.sections.map(s => ({
            id: String(s.id),
            data: { title: s.name, contentType: 'collection', url: s.html_url, metadata: { sectionId: s.id, categoryId: s.category_id, expandEntityType: 'article' } },
          })),
          hasMore: result.meta.has_more,
          nextPageToken: result.meta.has_more ? result.meta.after_cursor : undefined,
        };
      }
      case 'article': {
        const f = filters as Record<string, unknown> | undefined;
        const folderId = f?.folderId as string | undefined;
        if (!folderId) return { records: [], hasMore: false };
        const result = await this.listArticlesBySection(folderId, {
          pageAfter: f?.pageToken as string | undefined,
        });
        return {
          records: result.articles.map(a => ({
            id: String(a.id),
            data: { title: a.title, contentType: 'article', url: a.html_url ?? null, body: a.body, metadata: { sectionId: a.section_id, locale: a.locale } },
          })),
          hasMore: result.meta.has_more,
          nextPageToken: result.meta.has_more ? result.meta.after_cursor : undefined,
        };
      }

      default:
        return { records: [], hasMore: false, unsupported: true };
    }
  }


  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Zendesk create', { entityType });

    try {
      switch (entityType) {
        case 'ticket': {
          const ticket = await this.createTicket({
            subject: data.subject as string | undefined,
            comment: { body: data.comment as string },
            priority: data.priority as string | undefined,
            requester_id: data.requester_id as number | undefined,
            assignee_id: data.assignee_id as number | undefined,
            group_id: data.group_id as number | undefined,
            tags: data.tags as string[] | undefined,
          });
          return { success: true, id: String(ticket.id), data: ticket as unknown as Record<string, any> };
        }

        case 'comment': {
          const { ticketId, body } = data;
          if (!ticketId || !body) {
            return { success: false, id: '', error: 'Zendesk: addComment requires ticketId and body' };
          }
          const ticket = await this.addComment(ticketId as string, {
            body: body as string,
            public: data.public as boolean | undefined,
            author_id: data.author_id as number | undefined,
          });
          return { success: true, id: String(ticket.id), data: ticket as unknown as Record<string, any> };
        }

        case 'user': {
          if (!data.name) {
            return { success: false, id: '', error: 'Zendesk: createUser requires name' };
          }
          const user = await this.createUser({
            name: data.name as string,
            email: data.email as string | undefined,
            role: data.role as string | undefined,
            organization_id: data.organization_id as number | undefined,
            phone: data.phone as string | undefined,
          });
          return { success: true, id: String(user.id), data: user as unknown as Record<string, any> };
        }

        default:
          return {
            success: false,
            id: '',
            error: `Zendesk: unsupported create entity type "${entityType}"`,
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
   *   - 'ticket' → updateTicket(entityId, data)
   *   - 'user'   → updateUser(entityId, data)
   */
  async update(
    entityType: string,
    entityId: string | undefined,
    data: Record<string, any>,
  ): Promise<UpdateResult> {
    logger.info('Zendesk update', { entityType, entityId });

    try {
      const id = entityId ?? (data.id as string);
      if (!id) {
        return { success: false, error: `Zendesk: ${entityType} update requires entityId` };
      }

      switch (entityType) {
        case 'ticket': {
          const ticket = await this.updateTicket(id, {
            subject: data.subject as string | undefined,
            status: data.status as string | undefined,
            priority: data.priority as string | undefined,
            assignee_id: data.assignee_id as number | undefined,
            tags: data.tags as string[] | undefined,
            comment: data.comment as { body: string; public?: boolean } | undefined,
          });
          return { success: true, data: ticket as unknown as Record<string, any> };
        }

        case 'user': {
          const user = await this.updateUser(id, {
            name: data.name as string | undefined,
            email: data.email as string | undefined,
            role: data.role as string | undefined,
            organization_id: data.organization_id as number | undefined,
            phone: data.phone as string | undefined,
          });
          return { success: true, data: user as unknown as Record<string, any> };
        }

        default:
          return {
            success: false,
            error: `Zendesk: unsupported update entity type "${entityType}"`,
          };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * delete() — Zendesk tickets can be closed/solved but not hard-deleted via
   * standard agent OAuth. Use update to set status to "closed".
   */
  async delete(
    entityType: string,
    _entityId: string | undefined,
    _payload?: Record<string, any>,
  ): Promise<DeleteResult> {
    logger.info('Zendesk delete (unsupported)', { entityType });
    return {
      success: false,
      error: 'Zendesk: hard-delete is not supported. Use update_ticket to set status to "closed".',
    };
  }

  // ── CompensationClient — snapshot / inverse ───────────────────────────────

  async restore(
    entityType: string,
    entityId: string | undefined,
    snapshot: Record<string, any>,
  ): Promise<UpdateResult> {
    logger.info('Zendesk restore from snapshot', { entityType, entityId });
    return this.update(entityType, entityId, snapshot);
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string | undefined,
    _originalResponse: Record<string, any>,
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Zendesk semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        if (entityType === 'ticket' && entityId) {
          try {
            await this.updateTicket(entityId, { status: 'closed' });
            return { success: true };
          } catch {
            // Fall through
          }
        }
        return {
          success: false,
          error: 'Zendesk: cannot reverse ticket create — close it manually',
        };

      case 'update':
        return {
          success: false,
          error: 'Zendesk: update reversal requires pre-action snapshot',
        };

      default:
        return {
          success: false,
          error: `Zendesk: unknown action type: ${originalAction}`,
        };
    }
  }
}
