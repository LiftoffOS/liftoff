// HubSpot Connector Normalizer
// Per Section 12: Connector ingestion

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

interface HubSpotWebhookPayload {
  subscriptionType?: string;
  objectId?: number;
  propertyName?: string;
  propertyValue?: string;
  changeSource?: string;
  objectType?: string;
  results?: Array<{
    id: string;
    properties: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
    archived?: boolean;
  }>;
}

// ── Zod schemas (single source of truth: runtime parse + JSON Schema export) ──
//
// HubSpot property values arrive as strings — even numeric fields like
// `amount` and `numberofemployees`. Schemas accept the string-typed shape
// for runtime safety; downstream consumers parse to number when needed.

const HubSpotBase = {
  id: z.string().describe('HubSpot object id.'),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  archived: z.boolean().optional(),
};

const ContactDataSchema = z.object({
  ...HubSpotBase,
  email: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  phone: z.string().optional(),
  company: z.string().optional(),
  lifecycleStage: z.string().optional(),
  leadStatus: z.string().optional(),
});

const CompanyDataSchema = z.object({
  ...HubSpotBase,
  name: z.string().optional(),
  domain: z.string().optional(),
  industry: z.string().optional(),
  phone: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  employeeCount: z.string().optional(),
  annualRevenue: z.string().optional(),
});

const DealDataSchema = z.object({
  ...HubSpotBase,
  name: z.string().optional(),
  amount: z.string().optional(),
  stage: z.string().optional(),
  closeDate: z.string().optional().describe('Deal close date — anchor for "alert N days before close" patterns.'),
  pipeline: z.string().optional(),
  ownerId: z.string().optional(),
});

const TicketDataSchema = z.object({
  ...HubSpotBase,
  subject: z.string().optional(),
  content: z.string().optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  category: z.string().optional(),
});

// Property-change webhook events carry { id, propertyName, propertyValue }
// alongside the entity-type. They aren't full records; the schema captures
// only the field set the platform actually publishes.
const WebhookEventDataSchema = z.object({
  id: z.string(),
  propertyName: z.string().optional(),
  propertyValue: z.string().optional(),
  changeSource: z.string().optional(),
});

const ENTITY_SCHEMA_MAP: Record<string, z.ZodTypeAny> = {
  Contact: ContactDataSchema,
  Company: CompanyDataSchema,
  Deal: DealDataSchema,
  Ticket: TicketDataSchema,
};

function asOptionalString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  return typeof v === 'string' ? v : String(v);
}

export class HubSpotNormalizer implements ConnectorNormalizer {
  connectorType = 'hubspot';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    Contact: ContactDataSchema,
    Company: CompanyDataSchema,
    Deal: DealDataSchema,
    Ticket: TicketDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const hsPayload = payload as HubSpotWebhookPayload;
    const records: NormalizedRecord[] = [];

    // Handle webhook subscription event
    if (hsPayload.objectId && hsPayload.objectType) {
      records.push({
        entityType: this.mapObjectType(hsPayload.objectType),
        externalId: String(hsPayload.objectId),
        data: WebhookEventDataSchema.parse({
          id: String(hsPayload.objectId),
          propertyName: hsPayload.propertyName,
          propertyValue: hsPayload.propertyValue,
          changeSource: hsPayload.changeSource,
        }),
        metadata: {
          source: 'hubspot',
          syncedAt: new Date(),
          version: hashCanonicalJson(hsPayload),
        },
      });
    }

    // Handle API results
    if (hsPayload.results && Array.isArray(hsPayload.results)) {
      for (const result of hsPayload.results) {
        records.push(this.normalizeRecord(result, hsPayload.objectType));
      }
    }

    return records;
  }

  private normalizeRecord(
    record: {
      id: string;
      properties: Record<string, unknown>;
      createdAt?: string;
      updatedAt?: string;
      archived?: boolean;
    },
    objectType?: string
  ): NormalizedRecord {
    const entityType = objectType ? this.mapObjectType(objectType) : 'Unknown';
    const props = record.properties;

    // Build the declared field set explicitly. The plan calls for declared
    // fields only — unknown HubSpot custom properties are intentionally
    // dropped so the published entity schema is the truth about what the
    // platform exposes.
    const declared: Record<string, unknown> = {
      id: record.id,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      archived: record.archived,
    };

    if (entityType === 'Contact') {
      declared.email = asOptionalString(props.email);
      declared.firstName = asOptionalString(props.firstname);
      declared.lastName = asOptionalString(props.lastname);
      declared.phone = asOptionalString(props.phone);
      declared.company = asOptionalString(props.company);
      declared.lifecycleStage = asOptionalString(props.lifecyclestage);
      declared.leadStatus = asOptionalString(props.hs_lead_status);
    } else if (entityType === 'Company') {
      declared.name = asOptionalString(props.name);
      declared.domain = asOptionalString(props.domain);
      declared.industry = asOptionalString(props.industry);
      declared.phone = asOptionalString(props.phone);
      declared.city = asOptionalString(props.city);
      declared.state = asOptionalString(props.state);
      declared.country = asOptionalString(props.country);
      declared.employeeCount = asOptionalString(props.numberofemployees);
      declared.annualRevenue = asOptionalString(props.annualrevenue);
    } else if (entityType === 'Deal') {
      declared.name = asOptionalString(props.dealname);
      declared.amount = asOptionalString(props.amount);
      declared.stage = asOptionalString(props.dealstage);
      declared.closeDate = asOptionalString(props.closedate);
      declared.pipeline = asOptionalString(props.pipeline);
      declared.ownerId = asOptionalString(props.hubspot_owner_id);
    } else if (entityType === 'Ticket') {
      declared.subject = asOptionalString(props.subject);
      declared.content = asOptionalString(props.content);
      declared.status = asOptionalString(props.hs_ticket_status);
      declared.priority = asOptionalString(props.hs_ticket_priority);
      declared.category = asOptionalString(props.hs_ticket_category);
    }

    // Parse through the entity's schema — unknown entity types fall back to
    // a minimal id-only schema rather than passing through ad-hoc data.
    const schema = ENTITY_SCHEMA_MAP[entityType] ?? z.object({ id: z.string() });
    const data = schema.parse(declared);

    return {
      entityType,
      externalId: record.id,
      data,
      metadata: {
        source: 'hubspot',
        syncedAt: new Date(),
        version: record.updatedAt ?? hashCanonicalJson(record),
      },
    };
  }

  extractEntityType(record: unknown): string {
    const r = record as { objectType?: string };
    return r.objectType ? this.mapObjectType(r.objectType) : 'Unknown';
  }

  extractExternalId(record: unknown): string {
    const r = record as { id?: string; objectId?: number };
    return r.id || String(r.objectId) || '';
  }

  extractVersion(record: unknown): string | undefined {
    const r = record as { updatedAt?: string };
    return r.updatedAt;
  }

  private mapObjectType(hsType: string): string {
    const mapping: Record<string, string> = {
      contact: 'Contact',
      contacts: 'Contact',
      company: 'Company',
      companies: 'Company',
      deal: 'Deal',
      deals: 'Deal',
      ticket: 'Ticket',
      tickets: 'Ticket',
    };
    return mapping[hsType.toLowerCase()] || hsType;
  }
}
