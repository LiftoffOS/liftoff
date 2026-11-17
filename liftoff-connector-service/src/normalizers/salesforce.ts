// Salesforce Connector Normalizer
// Per Section 12: Connector ingestion

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

interface SalesforceWebhookPayload {
  event?: {
    type: string;
    createdDate: string;
  };
  sobject?: Record<string, unknown>;
  records?: Array<Record<string, unknown>>;
}

const AddressSchema = z.object({
  street: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  postalCode: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
}).nullable();

const SalesforceBase = {
  id: z.string().describe('Salesforce 18-char Id.'),
  name: z.string().optional(),
  createdDate: z.string().optional(),
  lastModifiedDate: z.string().optional(),
  ownerId: z.string().optional(),
};

const AccountDataSchema = z.object({
  ...SalesforceBase,
  industry: z.string().optional(),
  website: z.string().optional(),
  phone: z.string().optional(),
  billingAddress: AddressSchema.optional(),
  shippingAddress: AddressSchema.optional(),
});

const ContactDataSchema = z.object({
  ...SalesforceBase,
  email: z.string().optional(),
  phone: z.string().optional(),
  accountId: z.string().optional(),
  title: z.string().optional(),
});

const OpportunityDataSchema = z.object({
  ...SalesforceBase,
  amount: z.union([z.number(), z.string()]).optional(),
  stage: z.string().optional(),
  closeDate: z.string().optional().describe('Opportunity close date — anchor for "alert N days before close" patterns.'),
  accountId: z.string().optional(),
});

const LeadDataSchema = z.object({
  ...SalesforceBase,
  email: z.string().optional(),
  company: z.string().optional(),
  status: z.string().optional(),
  isConverted: z.boolean().optional(),
});

const UnknownDataSchema = z.object({
  ...SalesforceBase,
});

const ENTITY_SCHEMA_MAP: Record<string, z.ZodTypeAny> = {
  Account: AccountDataSchema,
  Contact: ContactDataSchema,
  Opportunity: OpportunityDataSchema,
  Lead: LeadDataSchema,
};

function asOptionalString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  return typeof v === 'string' ? v : String(v);
}

function asOptionalBoolean(v: unknown): boolean | undefined {
  if (v === null || v === undefined) return undefined;
  return typeof v === 'boolean' ? v : Boolean(v);
}

export class SalesforceNormalizer implements ConnectorNormalizer {
  connectorType = 'salesforce';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    Account: AccountDataSchema,
    Contact: ContactDataSchema,
    Opportunity: OpportunityDataSchema,
    Lead: LeadDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const sfPayload = payload as SalesforceWebhookPayload;
    const records: NormalizedRecord[] = [];

    if (sfPayload.sobject) {
      records.push(this.normalizeRecord(sfPayload.sobject));
    }

    if (sfPayload.records && Array.isArray(sfPayload.records)) {
      for (const record of sfPayload.records) {
        records.push(this.normalizeRecord(record));
      }
    }

    return records;
  }

  private normalizeRecord(record: Record<string, unknown>): NormalizedRecord {
    const entityType = this.extractEntityType(record);
    const externalId = this.extractExternalId(record);

    // Declared-field-only construction. Salesforce SObjects can carry an
    // arbitrary set of custom fields; the published entity schema is the
    // truth about what the platform exposes, so unknown fields are dropped.
    const declared: Record<string, unknown> = {
      id: asOptionalString(record.Id) ?? '',
      name: asOptionalString(record.Name),
      createdDate: asOptionalString(record.CreatedDate),
      lastModifiedDate: asOptionalString(record.LastModifiedDate),
      ownerId: asOptionalString(record.OwnerId),
    };

    if (entityType === 'Account') {
      declared.industry = asOptionalString(record.Industry);
      declared.website = asOptionalString(record.Website);
      declared.phone = asOptionalString(record.Phone);
      declared.billingAddress = this.extractAddress(record, 'Billing');
      declared.shippingAddress = this.extractAddress(record, 'Shipping');
    } else if (entityType === 'Contact') {
      declared.email = asOptionalString(record.Email);
      declared.phone = asOptionalString(record.Phone);
      declared.accountId = asOptionalString(record.AccountId);
      declared.title = asOptionalString(record.Title);
    } else if (entityType === 'Opportunity') {
      const amount = record.Amount;
      declared.amount = amount === null || amount === undefined
        ? undefined
        : (typeof amount === 'number' || typeof amount === 'string' ? amount : String(amount));
      declared.stage = asOptionalString(record.StageName);
      declared.closeDate = asOptionalString(record.CloseDate);
      declared.accountId = asOptionalString(record.AccountId);
    } else if (entityType === 'Lead') {
      declared.email = asOptionalString(record.Email);
      declared.company = asOptionalString(record.Company);
      declared.status = asOptionalString(record.Status);
      declared.isConverted = asOptionalBoolean(record.IsConverted);
    }

    const schema = ENTITY_SCHEMA_MAP[entityType] ?? UnknownDataSchema;
    const data = schema.parse(declared);

    return {
      entityType,
      externalId,
      data,
      metadata: {
        source: 'salesforce',
        syncedAt: new Date(),
        version: (record.SystemModstamp as string | undefined) ?? hashCanonicalJson(record),
      },
    };
  }

  extractEntityType(record: unknown): string {
    const r = record as Record<string, unknown>;
    if (r.attributes && typeof r.attributes === 'object') {
      const attrs = r.attributes as Record<string, unknown>;
      if (attrs.type) return attrs.type as string;
    }
    if (r.AccountId && r.Email && r.FirstName) return 'Contact';
    if (r.StageName && r.Amount) return 'Opportunity';
    if (r.Industry && r.Website) return 'Account';
    if (r.Company && r.Status && r.IsConverted !== undefined) return 'Lead';
    return 'Unknown';
  }

  extractExternalId(record: unknown): string {
    const r = record as Record<string, unknown>;
    return (r.Id as string) || '';
  }

  extractVersion(record: unknown): string | undefined {
    const r = record as Record<string, unknown>;
    return r.SystemModstamp as string | undefined;
  }

  private extractAddress(record: Record<string, unknown>, prefix: string): Record<string, unknown> | null {
    const street = record[`${prefix}Street`];
    const city = record[`${prefix}City`];
    const state = record[`${prefix}State`];
    const postalCode = record[`${prefix}PostalCode`];
    const country = record[`${prefix}Country`];

    if (!street && !city && !state) return null;

    return {
      street: asOptionalString(street) ?? null,
      city: asOptionalString(city) ?? null,
      state: asOptionalString(state) ?? null,
      postalCode: asOptionalString(postalCode) ?? null,
      country: asOptionalString(country) ?? null,
    };
  }
}
