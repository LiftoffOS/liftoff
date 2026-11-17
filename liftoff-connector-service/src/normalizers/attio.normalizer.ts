// Attio Connector Normalizer
// Per Section 12: normalizes Attio record-query responses into NormalizedRecord.
//
// Attio is MULTI-ENTITY for polling: the scheduler calls client.list('Contact')
// (object slug `people`) and client.list('Deal') (object slug `deals`)
// separately, then hands each batch to normalize({ results: [...] }) — WITHOUT
// the entityType. The client therefore stamps a `__attioObject` discriminator
// ('people' | 'deals') into each row's data, and this normalizer reads it to
// emit the correct entityType (people → Contact, deals → Deal), mirroring how
// microsoft-planner.normalizer discriminates plan/bucket/task by shape.
//
// Attio attribute values live under `values`, an attribute-slug → array map.
// Each entry is an array of value objects; we read the first (current) one.
// People `name` is personal-name (full_name/first_name/last_name);
// `email_addresses` is an array of email-address objects (email_address).
// Deals `name` is text (value), `value` is currency (currency_value), `stage`
// is status (status.title), `associated_company` is a record-reference
// (target_record_id).

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

const ContactDataSchema = z.object({
  id: z.string().describe('Attio People record id (record_id).'),
  fullName: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  emails: z.array(z.string()),
  primaryEmail: z.string().optional(),
  createdAt: z.string().optional(),
  webUrl: z.string().optional(),
});

const DealDataSchema = z.object({
  id: z.string().describe('Attio Deals record id (record_id).'),
  name: z.string().optional(),
  amount: z.number().optional().describe('Deal value (currency_value).'),
  currencyCode: z.string().optional(),
  stage: z.string().optional(),
  associatedCompanyId: z.string().optional(),
  createdAt: z.string().optional(),
  webUrl: z.string().optional(),
});

// ── Attio response shapes ─────────────────────────────────────────────────────
interface AttioValueObject {
  // personal-name
  full_name?: string;
  first_name?: string;
  last_name?: string;
  // email-address
  email_address?: string;
  // currency
  currency_value?: number;
  currency_code?: string;
  // status
  status?: { title?: string };
  // text / select / generic single-value
  value?: unknown;
  // record-reference
  target_record_id?: string;
  target_object?: string;
}

interface AttioRecord {
  id?: { record_id?: string } | string;
  created_at?: string;
  web_url?: string;
  values?: Record<string, AttioValueObject[]>;
  /** Discriminator stamped by AttioClient.list(): 'people' | 'deals'. */
  __attioObject?: 'people' | 'deals';
}

export class AttioNormalizer implements ConnectorNormalizer {
  connectorType = 'attio';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    Contact: ContactDataSchema,
    Deal: DealDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const records: NormalizedRecord[] = [];

    // Reactive polling path: scheduler wraps client.list() rows as
    // { results: [...] }. Each row carries the __attioObject discriminator.
    const wrapped = (payload as { results?: AttioRecord[] })?.results;
    const rows = Array.isArray(wrapped) ? wrapped : [payload as AttioRecord];

    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const normalized = this.normalizeItem(row);
      if (normalized) records.push(normalized);
    }
    return records;
  }

  private normalizeItem(row: AttioRecord): NormalizedRecord | undefined {
    const object = row.__attioObject;
    const externalId = this.recordId(row);
    if (!externalId) return undefined;

    if (object === 'deals') return this.normalizeDeal(row, externalId);
    if (object === 'people') return this.normalizeContact(row, externalId);
    return undefined;
  }

  private normalizeContact(row: AttioRecord, externalId: string): NormalizedRecord {
    const name = this.firstValue(row, 'name');
    const emails = (row.values?.email_addresses ?? [])
      .map(e => e.email_address)
      .filter((e): e is string => typeof e === 'string' && e.length > 0);

    return {
      entityType: 'Contact',
      externalId,
      data: ContactDataSchema.parse({
        id: externalId,
        fullName: name?.full_name,
        firstName: name?.first_name,
        lastName: name?.last_name,
        emails,
        primaryEmail: emails[0],
        createdAt: row.created_at,
        webUrl: row.web_url,
      }),
      metadata: {
        source: 'attio',
        syncedAt: new Date(),
        version: row.created_at ?? hashCanonicalJson(row),
      },
    };
  }

  private normalizeDeal(row: AttioRecord, externalId: string): NormalizedRecord {
    const nameVal = this.firstValue(row, 'name');
    const valueVal = this.firstValue(row, 'value');
    const stageVal = this.firstValue(row, 'stage');
    const companyVal = this.firstValue(row, 'associated_company');

    return {
      entityType: 'Deal',
      externalId,
      data: DealDataSchema.parse({
        id: externalId,
        name: this.text(nameVal),
        amount: typeof valueVal?.currency_value === 'number' ? valueVal.currency_value : undefined,
        currencyCode: valueVal?.currency_code,
        stage: stageVal?.status?.title ?? this.text(stageVal),
        associatedCompanyId: companyVal?.target_record_id,
        createdAt: row.created_at,
        webUrl: row.web_url,
      }),
      metadata: {
        source: 'attio',
        syncedAt: new Date(),
        version: row.created_at ?? hashCanonicalJson(row),
      },
    };
  }

  // ── helpers ─────────────────────────────────────────────────────────────────
  private recordId(row: AttioRecord): string {
    if (typeof row.id === 'string') return row.id;
    return row.id?.record_id ?? '';
  }

  private firstValue(row: AttioRecord, attr: string): AttioValueObject | undefined {
    const arr = row.values?.[attr];
    return Array.isArray(arr) ? arr[0] : undefined;
  }

  private text(v: AttioValueObject | undefined): string | undefined {
    if (!v) return undefined;
    if (typeof v.value === 'string') return v.value;
    if (typeof v.value === 'number') return String(v.value);
    return undefined;
  }

  extractEntityType(record: unknown): string {
    const r = record as AttioRecord;
    if (r?.__attioObject === 'people') return 'Contact';
    if (r?.__attioObject === 'deals') return 'Deal';
    return 'Unknown';
  }

  extractExternalId(record: unknown): string {
    return this.recordId(record as AttioRecord);
  }

  extractVersion(record: unknown): string | undefined {
    return (record as AttioRecord)?.created_at;
  }
}
