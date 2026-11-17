// Intercom Connector Normalizer
// Per Section 12: Connector ingestion

import { ConnectorNormalizer, NormalizedRecord } from './types';

interface IntercomWebhookPayload {
  type: string;
  topic: string;
  data: {
    item: {
      type: string;
      id: string;
      user_id?: string;
      admin_id?: string;
      created_at: number;
      updated_at?: number;
      // Conversation fields
      title?: string;
      state?: string;
      open?: boolean;
      read?: boolean;
      priority?: string;
      source?: {
        type: string;
        id: string;
        delivered_as: string;
      };
      conversation_message?: {
        type: string;
        id: string;
        body: string;
        author: {
          type: string;
          id: string;
          name?: string;
          email?: string;
        };
      };
      tags?: Array<{ id: string; name: string }>;
      // Contact fields
      email?: string;
      phone?: string;
      name?: string;
      role?: string;
      external_id?: string;
      signed_up_at?: number;
      last_seen_at?: number;
      custom_attributes?: Record<string, unknown>;
      // Company fields
      company_id?: string;
      remote_created_at?: number;
      monthly_spend?: number;
      user_count?: number;
      industry?: string;
      website?: string;
      plan?: { id: string; name: string };
    };
  };
}

export class IntercomNormalizer implements ConnectorNormalizer {
  connectorType = 'intercom';

  normalize(payload: unknown): NormalizedRecord[] {
    const icPayload = payload as IntercomWebhookPayload;
    const records: NormalizedRecord[] = [];

    if (!icPayload.data?.item) {
      return records;
    }

    const item = icPayload.data.item;
    const entityType = this.mapItemType(item.type);

    const record: NormalizedRecord = {
      entityType,
      externalId: item.id,
      data: {
        type: item.type,
        topic: icPayload.topic,
        createdAt: item.created_at ? new Date(item.created_at * 1000) : undefined,
        updatedAt: item.updated_at ? new Date(item.updated_at * 1000) : undefined,
      },
      metadata: {
        source: 'intercom',
        syncedAt: new Date(),
        version: item.updated_at ? String(item.updated_at) : undefined,
      },
    };

    // Handle conversations
    if (entityType === 'Conversation') {
      record.data.title = item.title;
      record.data.state = item.state;
      record.data.isOpen = item.open;
      record.data.isRead = item.read;
      record.data.priority = item.priority;
      record.data.userId = item.user_id;
      record.data.adminId = item.admin_id;
      record.data.source = item.source;
      record.data.tags = item.tags?.map((t) => t.name);

      if (item.conversation_message) {
        record.data.latestMessage = {
          id: item.conversation_message.id,
          body: item.conversation_message.body,
          authorType: item.conversation_message.author.type,
          authorId: item.conversation_message.author.id,
          authorName: item.conversation_message.author.name,
          authorEmail: item.conversation_message.author.email,
        };
      }
    }

    // Handle contacts/users
    if (entityType === 'Contact') {
      record.data.email = item.email;
      record.data.phone = item.phone;
      record.data.name = item.name;
      record.data.role = item.role;
      record.data.externalId = item.external_id;
      record.data.signedUpAt = item.signed_up_at
        ? new Date(item.signed_up_at * 1000)
        : undefined;
      record.data.lastSeenAt = item.last_seen_at
        ? new Date(item.last_seen_at * 1000)
        : undefined;
      record.data.customAttributes = item.custom_attributes;
    }

    // Handle companies
    if (entityType === 'Company') {
      record.data.companyId = item.company_id;
      record.data.name = item.name;
      record.data.industry = item.industry;
      record.data.website = item.website;
      record.data.monthlySpend = item.monthly_spend;
      record.data.userCount = item.user_count;
      record.data.plan = item.plan;
      record.data.remoteCreatedAt = item.remote_created_at
        ? new Date(item.remote_created_at * 1000)
        : undefined;
    }

    records.push(record);

    return records;
  }

  extractEntityType(record: unknown): string {
    const r = record as IntercomWebhookPayload;
    return r.data?.item ? this.mapItemType(r.data.item.type) : 'Unknown';
  }

  extractExternalId(record: unknown): string {
    const r = record as IntercomWebhookPayload;
    return r.data?.item?.id || '';
  }

  extractVersion(record: unknown): string | undefined {
    const r = record as IntercomWebhookPayload;
    return r.data?.item?.updated_at ? String(r.data.item.updated_at) : undefined;
  }

  private mapItemType(icType: string): string {
    const mapping: Record<string, string> = {
      conversation: 'Conversation',
      contact: 'Contact',
      user: 'Contact',
      lead: 'Contact',
      company: 'Company',
      admin: 'Admin',
      tag: 'Tag',
      note: 'Note',
    };
    return mapping[icType.toLowerCase()] || 'Event';
  }
}
