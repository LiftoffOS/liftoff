// Zendesk Connector Normalizer
// Per Section 12: Connector ingestion

import { ConnectorNormalizer, NormalizedRecord } from './types';

interface ZendeskWebhookPayload {
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

export class ZendeskNormalizer implements ConnectorNormalizer {
  connectorType = 'zendesk';

  normalize(payload: unknown): NormalizedRecord[] {
    const zdPayload = payload as ZendeskWebhookPayload;
    const records: NormalizedRecord[] = [];

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

  private normalizeTicket(
    ticket: NonNullable<ZendeskWebhookPayload['ticket']>,
    currentUser?: ZendeskWebhookPayload['current_user']
  ): NormalizedRecord {
    return {
      entityType: 'Ticket',
      externalId: String(ticket.id),
      data: {
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
      },
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
      data: {
        externalId: user.external_id,
        name: user.name,
        email: user.email,
        role: user.role,
        phone: user.phone,
        organizationId: user.organization_id,
        tags: user.tags,
        createdAt: user.created_at,
        updatedAt: user.updated_at,
      },
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
      data: {
        externalId: org.external_id,
        name: org.name,
        domains: org.domain_names,
        tags: org.tags,
        createdAt: org.created_at,
        updatedAt: org.updated_at,
      },
      metadata: {
        source: 'zendesk',
        syncedAt: new Date(),
        version: org.updated_at,
      },
    };
  }

  extractEntityType(record: unknown): string {
    const r = record as ZendeskWebhookPayload;
    if (r.ticket) return 'Ticket';
    if (r.user) return 'User';
    if (r.organization) return 'Organization';
    return 'Unknown';
  }

  extractExternalId(record: unknown): string {
    const r = record as ZendeskWebhookPayload;
    if (r.ticket) return String(r.ticket.id);
    if (r.user) return String(r.user.id);
    if (r.organization) return String(r.organization.id);
    return '';
  }

  extractVersion(record: unknown): string | undefined {
    const r = record as ZendeskWebhookPayload;
    if (r.ticket) return r.ticket.updated_at;
    if (r.user) return r.user.updated_at;
    if (r.organization) return r.organization.updated_at;
    return undefined;
  }
}
