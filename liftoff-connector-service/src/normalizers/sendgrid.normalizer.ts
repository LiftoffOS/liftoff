// SendGrid Connector Normalizer
//
// SendGrid is reactive via native polling (api_key sidecar connector; no
// Composio, no native webhook wired). The polling scheduler hands
// SendGridClient.list('Contact') results to normalize() as { results: [contact] }.
// Field set is the documented SendGrid Marketing Contacts shape returned by
// POST /v3/marketing/contacts/search, restricted to identity + the fields a
// reactive subscription would predicate on (name, email, phone, list_ids) plus
// timestamps. updated_at is the version anchor for "contact changed" patterns.

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

interface SendGridContact {
  id?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  phone_number?: string;
  created_at?: string;
  updated_at?: string;
  list_ids?: string[];
}

interface SendGridPayload {
  results?: SendGridContact[];
}

const ContactDataSchema = z.object({
  id: z.string().describe('SendGrid contact id.'),
  email: z.string().optional().describe('Primary email address of the contact.'),
  firstName: z.string().optional().describe('Contact first name.'),
  lastName: z.string().optional().describe('Contact last name.'),
  phoneNumber: z.string().optional().describe('Contact phone number.'),
  createdAt: z.string().optional().describe('Contact creation ISO timestamp (UTC).'),
  updatedAt: z.string().optional().describe('Contact last-modified ISO timestamp (UTC) — anchor for "contact updated" patterns.'),
  listIds: z.array(z.string()).optional().describe('Marketing list ids the contact belongs to.'),
});

export class SendGridNormalizer implements ConnectorNormalizer {
  connectorType = 'sendgrid';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    Contact: ContactDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const contacts = (payload as SendGridPayload)?.results ?? [];
    const records: NormalizedRecord[] = [];

    for (const contact of contacts) {
      if (contact?.id === undefined || contact.id === null) continue;
      const id = String(contact.id);
      const declared: Record<string, unknown> = {
        id,
        email: contact.email,
        firstName: contact.first_name,
        lastName: contact.last_name,
        phoneNumber: contact.phone_number,
        createdAt: contact.created_at,
        updatedAt: contact.updated_at,
        listIds: Array.isArray(contact.list_ids) ? contact.list_ids : undefined,
      };
      records.push({
        entityType: 'Contact',
        externalId: id,
        data: declared,
        metadata: {
          source: 'sendgrid',
          syncedAt: new Date(),
          version: contact.updated_at ?? hashCanonicalJson(contact),
        },
      });
    }

    return records;
  }

  extractEntityType(_record: unknown): string {
    return 'Contact';
  }

  extractExternalId(record: unknown): string {
    return String((record as SendGridContact).id ?? '');
  }

  extractVersion(record: unknown): string | undefined {
    return (record as SendGridContact).updated_at;
  }
}
