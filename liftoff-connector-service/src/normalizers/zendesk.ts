// Zendesk Connector Normalizer
// Per Section 12: Connector ingestion

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';

interface ZendeskArticlePayload {
  id: number;
  title: string;
  body: string;
  section_id: number;
  locale: string;
  author_id: number;
  promoted: boolean;
  created_at: string;
  updated_at: string;
}

interface ZendeskWebhookPayload {
  results?: Array<Record<string, unknown>>;
  article?: ZendeskArticlePayload;
  ticket?: {
    id: number;
    external_id?: string;
    subject: string;
    description: string;
    status: string;
    priority?: string;
    type?: string;
    requester_id: number;
    submitter_id: number;
    assignee_id?: number;
    group_id?: number;
    organization_id?: number;
    tags: string[];
    created_at: string;
    updated_at: string;
    due_at?: string;
    satisfaction_rating?: {
      score: string;
      comment?: string;
    };
    custom_fields?: Array<{
      id: number;
      value: unknown;
    }>;
  };
  user?: {
    id: number;
    external_id?: string;
    name: string;
    email: string;
    role: string;
    created_at: string;
    updated_at: string;
    organization_id?: number;
    phone?: string;
    tags: string[];
  };
  organization?: {
    id: number;
    external_id?: string;
    name: string;
    domain_names: string[];
    created_at: string;
    updated_at: string;
    tags: string[];
  };
  current_user?: {
    id: number;
    name: string;
    email: string;
  };
}

const ArticleDataSchema = z.object({
  id: z.string().describe('Zendesk article id (string form of numeric id).'),
  title: z.string(),
  body: z.string(),
  sectionId: z.number(),
  locale: z.string(),
  authorId: z.number(),
  promoted: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const TicketDataSchema = z.object({
  id: z.string().describe('Zendesk ticket id.'),
  externalId: z.string().optional(),
  subject: z.string(),
  description: z.string(),
  status: z.string(),
  priority: z.string().optional(),
  type: z.string().optional(),
  requesterId: z.number(),
  submitterId: z.number(),
  assigneeId: z.number().optional(),
  groupId: z.number().optional(),
  organizationId: z.number().optional(),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  dueAt: z.string().optional().describe('Ticket due timestamp — anchor for "alert N hours before due" patterns.'),
  satisfactionScore: z.string().optional(),
  satisfactionComment: z.string().optional(),
  customFields: z.record(z.unknown()).optional(),
  changedBy: z.string().optional(),
  changedById: z.number().optional(),
});

const UserDataSchema = z.object({
  id: z.string().describe('Zendesk user id.'),
  externalId: z.string().optional(),
  name: z.string(),
  email: z.string(),
  role: z.string(),
  phone: z.string().optional(),
  organizationId: z.number().optional(),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const OrganizationDataSchema = z.object({
  id: z.string().describe('Zendesk organization id.'),
  externalId: z.string().optional(),
  name: z.string(),
  domains: z.array(z.string()),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export class ZendeskNormalizer implements ConnectorNormalizer {
  connectorType = 'zendesk';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    Article: ArticleDataSchema,
    Ticket: TicketDataSchema,
    User: UserDataSchema,
    Organization: OrganizationDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const zdPayload = payload as ZendeskWebhookPayload;
    const records: NormalizedRecord[] = [];

    if (zdPayload.results && Array.isArray(zdPayload.results)) {
      for (const item of zdPayload.results) {
        if ('section_id' in item) {
          records.push(this.normalizeArticle(item as unknown as ZendeskArticlePayload));
        } else if ('requester_id' in item || 'subject' in item) {
          records.push(this.normalizeTicket(item as unknown as NonNullable<ZendeskWebhookPayload['ticket']>));
        }
      }
      return records;
    }

    if (zdPayload.article) {
      records.push(this.normalizeArticle(zdPayload.article));
    }

    if (zdPayload.ticket) {
      records.push(this.normalizeTicket(zdPayload.ticket, zdPayload.current_user));
    }

    if (zdPayload.user) {
      records.push(this.normalizeUser(zdPayload.user));
    }

    if (zdPayload.organization) {
      records.push(this.normalizeOrganization(zdPayload.organization));
    }

    return records;
  }

  private normalizeArticle(article: ZendeskArticlePayload): NormalizedRecord {
    return {
      entityType: 'Article',
      externalId: String(article.id),
      data: ArticleDataSchema.parse({
        id: String(article.id),
        title: article.title,
        body: article.body,
        sectionId: article.section_id,
        locale: article.locale,
        authorId: article.author_id,
        promoted: article.promoted,
        createdAt: article.created_at,
        updatedAt: article.updated_at,
      }),
      metadata: {
        source: 'zendesk',
        syncedAt: new Date(),
        version: article.updated_at,
      },
    };
  }

  private normalizeTicket(
    ticket: NonNullable<ZendeskWebhookPayload['ticket']>,
    currentUser?: ZendeskWebhookPayload['current_user']
  ): NormalizedRecord {
    return {
      entityType: 'Ticket',
      externalId: String(ticket.id),
      data: TicketDataSchema.parse({
        id: String(ticket.id),
        externalId: ticket.external_id,
        subject: ticket.subject,
        description: ticket.description,
        status: ticket.status,
        priority: ticket.priority,
        type: ticket.type,
        requesterId: ticket.requester_id,
        submitterId: ticket.submitter_id,
        assigneeId: ticket.assignee_id,
        groupId: ticket.group_id,
        organizationId: ticket.organization_id,
        tags: ticket.tags,
        createdAt: ticket.created_at,
        updatedAt: ticket.updated_at,
        dueAt: ticket.due_at,
        satisfactionScore: ticket.satisfaction_rating?.score,
        satisfactionComment: ticket.satisfaction_rating?.comment,
        customFields: ticket.custom_fields?.reduce(
          (acc, cf) => ({ ...acc, [cf.id]: cf.value }),
          {} as Record<number, unknown>
        ),
        changedBy: currentUser?.name,
        changedById: currentUser?.id,
      }),
      metadata: {
        source: 'zendesk',
        syncedAt: new Date(),
        version: ticket.updated_at,
      },
    };
  }

  private normalizeUser(user: NonNullable<ZendeskWebhookPayload['user']>): NormalizedRecord {
    return {
      entityType: 'User',
      externalId: String(user.id),
      data: UserDataSchema.parse({
        id: String(user.id),
        externalId: user.external_id,
        name: user.name,
        email: user.email,
        role: user.role,
        phone: user.phone,
        organizationId: user.organization_id,
        tags: user.tags,
        createdAt: user.created_at,
        updatedAt: user.updated_at,
      }),
      metadata: {
        source: 'zendesk',
        syncedAt: new Date(),
        version: user.updated_at,
      },
    };
  }

  private normalizeOrganization(
    org: NonNullable<ZendeskWebhookPayload['organization']>
  ): NormalizedRecord {
    return {
      entityType: 'Organization',
      externalId: String(org.id),
      data: OrganizationDataSchema.parse({
        id: String(org.id),
        externalId: org.external_id,
        name: org.name,
        domains: org.domain_names,
        tags: org.tags,
        createdAt: org.created_at,
        updatedAt: org.updated_at,
      }),
      metadata: {
        source: 'zendesk',
        syncedAt: new Date(),
        version: org.updated_at,
      },
    };
  }

  extractEntityType(record: unknown): string {
    const r = record as ZendeskWebhookPayload;
    if (r.article) return 'Article';
    if (r.ticket) return 'Ticket';
    if (r.user) return 'User';
    if (r.organization) return 'Organization';
    return 'Unknown';
  }

  extractExternalId(record: unknown): string {
    const r = record as ZendeskWebhookPayload;
    if (r.article) return String(r.article.id);
    if (r.ticket) return String(r.ticket.id);
    if (r.user) return String(r.user.id);
    if (r.organization) return String(r.organization.id);
    return '';
  }

  extractVersion(record: unknown): string | undefined {
    const r = record as ZendeskWebhookPayload;
    if (r.article) return r.article.updated_at;
    if (r.ticket) return r.ticket.updated_at;
    if (r.user) return r.user.updated_at;
    if (r.organization) return r.organization.updated_at;
    return undefined;
  }
}
