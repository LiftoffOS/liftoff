// Intercom Connector Normalizer
// Per Section 12: Connector ingestion

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

interface IntercomWebhookPayload {
  results?: Array<Record<string, unknown>>;
  type?: string;
  topic?: string;
  data?: {
    item: {
      type: string;
      id: string;
      user_id?: string;
      admin_id?: string;
      created_at: number;
      updated_at?: number;
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
      email?: string;
      phone?: string;
      name?: string;
      role?: string;
      external_id?: string;
      signed_up_at?: number;
      last_seen_at?: number;
      custom_attributes?: Record<string, unknown>;
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

const IntercomBase = {
  id: z.string().describe('Intercom resource id.'),
  type: z.string().optional(),
  topic: z.string().optional(),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
};

const ConversationDataSchema = z.object({
  ...IntercomBase,
  title: z.string().optional(),
  state: z.string().optional(),
  isOpen: z.boolean().optional(),
  isRead: z.boolean().optional(),
  priority: z.string().optional(),
  userId: z.string().optional(),
  adminId: z.string().optional(),
  source: z.object({
    type: z.string(),
    id: z.string(),
    delivered_as: z.string(),
  }).optional(),
  tags: z.array(z.string()).optional(),
  latestMessage: z.object({
    id: z.string(),
    body: z.string(),
    authorType: z.string(),
    authorId: z.string(),
    authorName: z.string().optional(),
    authorEmail: z.string().optional(),
  }).optional(),
});

const ContactDataSchema = z.object({
  ...IntercomBase,
  email: z.string().optional(),
  phone: z.string().optional(),
  name: z.string().optional(),
  role: z.string().optional(),
  externalId: z.string().optional(),
  signedUpAt: z.date().optional(),
  lastSeenAt: z.date().optional().describe('Last activity timestamp.'),
  customAttributes: z.record(z.unknown()).optional(),
});

const CompanyDataSchema = z.object({
  ...IntercomBase,
  companyId: z.string().optional(),
  name: z.string().optional(),
  industry: z.string().optional(),
  website: z.string().optional(),
  monthlySpend: z.number().optional(),
  userCount: z.number().optional(),
  plan: z.object({ id: z.string(), name: z.string() }).optional(),
  remoteCreatedAt: z.date().optional(),
});

const GenericIntercomDataSchema = z.object({
  ...IntercomBase,
});

const ENTITY_SCHEMA_MAP: Record<string, z.ZodTypeAny> = {
  Conversation: ConversationDataSchema,
  Contact: ContactDataSchema,
  Company: CompanyDataSchema,
  Admin: GenericIntercomDataSchema,
  Tag: GenericIntercomDataSchema,
  Note: GenericIntercomDataSchema,
  Event: GenericIntercomDataSchema,
};

export class IntercomNormalizer implements ConnectorNormalizer {
  connectorType = 'intercom';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    Conversation: ConversationDataSchema,
    Contact: ContactDataSchema,
    Company: CompanyDataSchema,
    Admin: GenericIntercomDataSchema,
    Tag: GenericIntercomDataSchema,
    Note: GenericIntercomDataSchema,
    Event: GenericIntercomDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const icPayload = payload as IntercomWebhookPayload;
    const records: NormalizedRecord[] = [];

    // Batch polling results — raw item shape. Re-route each through the
    // single-item path so they go through the same Zod parse as webhooks.
    if (icPayload.results && Array.isArray(icPayload.results)) {
      for (const raw of icPayload.results) {
        const rawType = raw.type as string | undefined;
        const entityType = rawType ? this.mapItemType(rawType) : 'Event';
        const declared = this.buildDeclared(entityType, raw as Record<string, unknown>, undefined);
        const schema = ENTITY_SCHEMA_MAP[entityType] ?? GenericIntercomDataSchema;
        records.push({
          entityType,
          externalId: String(raw.id),
          data: schema.parse(declared),
          metadata: {
            source: 'intercom',
            syncedAt: new Date(),
            version: raw.updated_at ? String(raw.updated_at) : hashCanonicalJson(raw),
          },
        });
      }
      return records;
    }

    if (!icPayload.data?.item) {
      return records;
    }

    const item = icPayload.data.item;
    const entityType = this.mapItemType(item.type ?? '');
    const declared = this.buildDeclared(entityType, item as unknown as Record<string, unknown>, icPayload.topic);
    const schema = ENTITY_SCHEMA_MAP[entityType] ?? GenericIntercomDataSchema;

    records.push({
      entityType,
      externalId: item.id,
      data: schema.parse(declared),
      metadata: {
        source: 'intercom',
        syncedAt: new Date(),
        version: item.updated_at ? String(item.updated_at) : hashCanonicalJson(item),
      },
    });

    return records;
  }

  private buildDeclared(
    entityType: string,
    item: Record<string, unknown>,
    topic: string | undefined,
  ): Record<string, unknown> {
    const declared: Record<string, unknown> = {
      id: String(item.id ?? ''),
      type: item.type as string | undefined,
      topic,
      createdAt: typeof item.created_at === 'number' ? new Date(item.created_at * 1000) : undefined,
      updatedAt: typeof item.updated_at === 'number' ? new Date(item.updated_at * 1000) : undefined,
    };

    if (entityType === 'Conversation') {
      declared.title = item.title;
      declared.state = item.state;
      declared.isOpen = item.open as boolean | undefined;
      declared.isRead = item.read as boolean | undefined;
      declared.priority = item.priority;
      declared.userId = item.user_id;
      declared.adminId = item.admin_id;
      declared.source = item.source;
      // Intercom returns tags as a flat array (webhooks) OR a tag.list object
      // { type:'tag.list', tags:[...] } (REST /conversations). Handle both.
      const tagsRaw = item.tags as unknown;
      const tagsArr: Array<{ name?: string }> | undefined = Array.isArray(tagsRaw)
        ? (tagsRaw as Array<{ name?: string }>)
        : (tagsRaw && typeof tagsRaw === 'object' && Array.isArray((tagsRaw as { tags?: unknown }).tags)
          ? ((tagsRaw as { tags: Array<{ name?: string }> }).tags)
          : undefined);
      declared.tags = tagsArr?.map((t) => t.name).filter((n): n is string => typeof n === 'string');
      const cm = item.conversation_message as IntercomWebhookPayload['data'] extends infer T
        ? T extends { item: { conversation_message?: infer C } }
          ? C
          : never
        : never;
      if (cm) {
        declared.latestMessage = {
          id: cm.id,
          body: cm.body,
          authorType: cm.author.type,
          authorId: cm.author.id,
          authorName: cm.author.name,
          authorEmail: cm.author.email,
        };
      }
    } else if (entityType === 'Contact') {
      declared.email = item.email;
      declared.phone = item.phone;
      declared.name = item.name;
      declared.role = item.role;
      declared.externalId = item.external_id;
      declared.signedUpAt = typeof item.signed_up_at === 'number'
        ? new Date(item.signed_up_at * 1000)
        : undefined;
      declared.lastSeenAt = typeof item.last_seen_at === 'number'
        ? new Date(item.last_seen_at * 1000)
        : undefined;
      declared.customAttributes = item.custom_attributes;
    } else if (entityType === 'Company') {
      declared.companyId = item.company_id;
      declared.name = item.name;
      declared.industry = item.industry;
      declared.website = item.website;
      declared.monthlySpend = item.monthly_spend;
      declared.userCount = item.user_count;
      declared.plan = item.plan;
      declared.remoteCreatedAt = typeof item.remote_created_at === 'number'
        ? new Date(item.remote_created_at * 1000)
        : undefined;
    }

    // Intercom returns null liberally for absent fields (e.g. source, user_id,
    // admin_id on API-created conversations). Our Zod schemas use .optional()
    // which accepts undefined but NOT null, so coalesce top-level nulls →
    // undefined before parsing — otherwise normalize() throws on real data.
    for (const k of Object.keys(declared)) {
      if (declared[k] === null) declared[k] = undefined;
    }

    return declared;
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
