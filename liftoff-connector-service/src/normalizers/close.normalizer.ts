// Close Connector Normalizer
// Per Section 12: normalizes Close /api/v1/lead/ objects into NormalizedRecord.
//
// Close is MULTI-ENTITY for polling: CloseComposioClient.list('Lead') returns
// lead objects and list('Contact') returns the leads' embedded contacts, each
// stamped with a `__entity` discriminator ('lead' | 'contact'). The scheduler
// hands each batch to normalize({ results: [...] }) WITHOUT the entityType, so
// this normalizer reads `__entity` to emit the correct entityType + data shape,
// mirroring AttioNormalizer's `__attioObject` dispatch.
//
// Close leads carry id, display_name, status_label, date_created/date_updated.
// Close contacts carry id, name, title, emails[{ email, type }],
// phones[{ phone, type }]; the client injects leadId/leadName onto each contact.

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

const LeadDataSchema = z.object({
  id: z.string().describe('Close lead id.'),
  name: z.string().optional().describe('display_name.'),
  status: z.string().optional().describe('status_label.'),
  description: z.string().optional(),
  url: z.string().optional(),
  createdAt: z.string().optional().describe('date_created.'),
  updatedAt: z.string().optional().describe('date_updated.'),
});

const ContactDataSchema = z.object({
  id: z.string().describe('Close contact id.'),
  name: z.string().optional(),
  title: z.string().optional(),
  primaryEmail: z.string().optional(),
  emails: z.array(z.string()),
  phone: z.string().optional(),
  leadId: z.string().optional(),
  leadName: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

interface CloseRow {
  id?: unknown;
  __entity?: 'lead' | 'contact';
  // lead fields
  display_name?: unknown;
  status_label?: unknown;
  description?: unknown;
  url?: unknown;
  // contact fields
  name?: unknown;
  title?: unknown;
  emails?: unknown;
  phones?: unknown;
  leadId?: unknown;
  leadName?: unknown;
  // shared
  date_created?: unknown;
  date_updated?: unknown;
}

function asOptionalString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  return typeof v === 'string' ? v : String(v);
}

// Close emails: [{ email, type }]; phones: [{ phone, type }].
function pluck(v: unknown, key: 'email' | 'phone'): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const e of v) {
    if (e && typeof e === 'object') {
      const val = (e as Record<string, unknown>)[key];
      if (typeof val === 'string' && val.length > 0) out.push(val);
    } else if (typeof e === 'string' && e.length > 0) {
      out.push(e);
    }
  }
  return out;
}

export class CloseNormalizer implements ConnectorNormalizer {
  connectorType = 'close';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    Lead: LeadDataSchema,
    Contact: ContactDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const wrapped = (payload as { results?: CloseRow[] })?.results;
    const rows = Array.isArray(wrapped) ? wrapped : [payload as CloseRow];

    const records: NormalizedRecord[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const normalized = this.normalizeItem(row);
      if (normalized) records.push(normalized);
    }
    return records;
  }

  private normalizeItem(row: CloseRow): NormalizedRecord | undefined {
    const externalId = asOptionalString(row.id);
    if (!externalId) return undefined;
    if (row.__entity === 'lead') return this.normalizeLead(row, externalId);
    if (row.__entity === 'contact') return this.normalizeContact(row, externalId);
    return undefined;
  }

  private normalizeLead(row: CloseRow, externalId: string): NormalizedRecord {
    return {
      entityType: 'Lead',
      externalId,
      data: LeadDataSchema.parse({
        id: externalId,
        name: asOptionalString(row.display_name),
        status: asOptionalString(row.status_label),
        description: asOptionalString(row.description),
        url: asOptionalString(row.url),
        createdAt: asOptionalString(row.date_created),
        updatedAt: asOptionalString(row.date_updated),
      }),
      metadata: {
        source: 'close',
        syncedAt: new Date(),
        version: asOptionalString(row.date_updated) ?? asOptionalString(row.date_created) ?? hashCanonicalJson(row),
      },
    };
  }

  private normalizeContact(row: CloseRow, externalId: string): NormalizedRecord {
    const emails = pluck(row.emails, 'email');
    const phones = pluck(row.phones, 'phone');
    return {
      entityType: 'Contact',
      externalId,
      data: ContactDataSchema.parse({
        id: externalId,
        name: asOptionalString(row.name),
        title: asOptionalString(row.title),
        primaryEmail: emails[0],
        emails,
        phone: phones[0],
        leadId: asOptionalString(row.leadId),
        leadName: asOptionalString(row.leadName),
        createdAt: asOptionalString(row.date_created),
        updatedAt: asOptionalString(row.date_updated),
      }),
      metadata: {
        source: 'close',
        syncedAt: new Date(),
        version: asOptionalString(row.date_updated) ?? asOptionalString(row.date_created) ?? hashCanonicalJson(row),
      },
    };
  }

  extractEntityType(record: unknown): string {
    const r = record as CloseRow;
    if (r?.__entity === 'lead') return 'Lead';
    if (r?.__entity === 'contact') return 'Contact';
    return 'Unknown';
  }

  extractExternalId(record: unknown): string {
    return asOptionalString((record as CloseRow)?.id) ?? '';
  }

  extractVersion(record: unknown): string | undefined {
    return asOptionalString((record as CloseRow)?.date_updated);
  }
}
