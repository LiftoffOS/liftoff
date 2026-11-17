// Pipedrive Connector Normalizer
// Per Section 12: normalizes Pipedrive /recents entries into NormalizedRecord.
//
// Pipedrive is MULTI-ENTITY for polling: PipedriveComposioClient.list('Deal')
// and list('Contact') each call PIPEDRIVE_GET_RECENTS and return the full
// Pipedrive object under `data`, stamped with a `__entity` discriminator
// ('deal' | 'person'). The scheduler hands each batch to
// normalize({ results: [...] }) WITHOUT the entityType, so this normalizer
// reads `__entity` to emit the correct entityType + data shape (deal → Deal,
// person → Contact), mirroring AttioNormalizer's `__attioObject` dispatch.
//
// Pipedrive person_id / org_id can be a bare number or an object
// { value, name }; email / phone are arrays of { value, primary, label }
// (older accounts may return a bare string). Helpers below coalesce both.

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

const DealDataSchema = z.object({
  id: z.string().describe('Pipedrive deal id.'),
  name: z.string().optional().describe('Deal title.'),
  amount: z.number().optional().describe('Deal value.'),
  currencyCode: z.string().optional(),
  status: z.string().optional().describe('open | won | lost | deleted.'),
  stageId: z.number().optional(),
  personId: z.number().optional(),
  orgId: z.number().optional(),
  createdAt: z.string().optional().describe('add_time.'),
  updatedAt: z.string().optional().describe('update_time.'),
});

const ContactDataSchema = z.object({
  id: z.string().describe('Pipedrive person id.'),
  name: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  primaryEmail: z.string().optional(),
  emails: z.array(z.string()),
  phone: z.string().optional(),
  orgId: z.number().optional(),
  createdAt: z.string().optional().describe('add_time.'),
  updatedAt: z.string().optional().describe('update_time.'),
});

interface PipedriveRow {
  id?: number | string;
  __entity?: 'deal' | 'person';
  // deal fields
  title?: unknown;
  value?: unknown;
  currency?: unknown;
  status?: unknown;
  stage_id?: unknown;
  person_id?: unknown;
  org_id?: unknown;
  // person fields
  name?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  email?: unknown;
  phone?: unknown;
  // shared
  add_time?: unknown;
  update_time?: unknown;
}

function asOptionalString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  return typeof v === 'string' ? v : String(v);
}

function asOptionalNumber(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  // { value, name } reference shape (Pipedrive person_id / org_id).
  if (typeof v === 'object') {
    const inner = (v as { value?: unknown }).value;
    if (typeof inner === 'number') return inner;
    if (typeof inner === 'string' && !Number.isNaN(Number(inner))) return Number(inner);
  }
  return undefined;
}

// Pipedrive email/phone: array of { value, primary, label } | bare string.
function extractContactChannels(v: unknown): { all: string[]; primary?: string } {
  if (typeof v === 'string' && v.length > 0) return { all: [v], primary: v };
  if (Array.isArray(v)) {
    const entries: Array<{ value?: unknown; primary?: unknown }> = v.map((e) =>
      e && typeof e === 'object' ? (e as { value?: unknown; primary?: unknown }) : { value: e },
    );
    const valid = entries.filter((e) => typeof e.value === 'string' && (e.value as string).length > 0);
    const all = valid.map((e) => e.value as string);
    const primary = (valid.find((e) => e.primary === true)?.value as string | undefined) ?? all[0];
    return { all, primary };
  }
  return { all: [] };
}

export class PipedriveNormalizer implements ConnectorNormalizer {
  connectorType = 'pipedrive';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    Deal: DealDataSchema,
    Contact: ContactDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const wrapped = (payload as { results?: PipedriveRow[] })?.results;
    const rows = Array.isArray(wrapped) ? wrapped : [payload as PipedriveRow];

    const records: NormalizedRecord[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const normalized = this.normalizeItem(row);
      if (normalized) records.push(normalized);
    }
    return records;
  }

  private normalizeItem(row: PipedriveRow): NormalizedRecord | undefined {
    const externalId = asOptionalString(row.id);
    if (!externalId) return undefined;
    if (row.__entity === 'deal') return this.normalizeDeal(row, externalId);
    if (row.__entity === 'person') return this.normalizeContact(row, externalId);
    return undefined;
  }

  private normalizeDeal(row: PipedriveRow, externalId: string): NormalizedRecord {
    return {
      entityType: 'Deal',
      externalId,
      data: DealDataSchema.parse({
        id: externalId,
        name: asOptionalString(row.title),
        amount: asOptionalNumber(row.value),
        currencyCode: asOptionalString(row.currency),
        status: asOptionalString(row.status),
        stageId: asOptionalNumber(row.stage_id),
        personId: asOptionalNumber(row.person_id),
        orgId: asOptionalNumber(row.org_id),
        createdAt: asOptionalString(row.add_time),
        updatedAt: asOptionalString(row.update_time),
      }),
      metadata: {
        source: 'pipedrive',
        syncedAt: new Date(),
        version: asOptionalString(row.update_time) ?? asOptionalString(row.add_time) ?? hashCanonicalJson(row),
      },
    };
  }

  private normalizeContact(row: PipedriveRow, externalId: string): NormalizedRecord {
    const emails = extractContactChannels(row.email);
    const phones = extractContactChannels(row.phone);
    return {
      entityType: 'Contact',
      externalId,
      data: ContactDataSchema.parse({
        id: externalId,
        name: asOptionalString(row.name),
        firstName: asOptionalString(row.first_name),
        lastName: asOptionalString(row.last_name),
        primaryEmail: emails.primary,
        emails: emails.all,
        phone: phones.primary,
        orgId: asOptionalNumber(row.org_id),
        createdAt: asOptionalString(row.add_time),
        updatedAt: asOptionalString(row.update_time),
      }),
      metadata: {
        source: 'pipedrive',
        syncedAt: new Date(),
        version: asOptionalString(row.update_time) ?? asOptionalString(row.add_time) ?? hashCanonicalJson(row),
      },
    };
  }

  extractEntityType(record: unknown): string {
    const r = record as PipedriveRow;
    if (r?.__entity === 'deal') return 'Deal';
    if (r?.__entity === 'person') return 'Contact';
    return 'Unknown';
  }

  extractExternalId(record: unknown): string {
    return asOptionalString((record as PipedriveRow)?.id) ?? '';
  }

  extractVersion(record: unknown): string | undefined {
    return asOptionalString((record as PipedriveRow)?.update_time);
  }
}
