// Microsoft Contacts Connector Normalizer
// Per Section 12: Connector ingestion - normalizes Microsoft Graph API responses

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

// Contact structure
interface MicrosoftContact {
  id: string;
  changeKey?: string;
  displayName?: string;
  givenName?: string;
  surname?: string;
  middleName?: string;
  nickName?: string;
  title?: string;
  emailAddresses?: Array<{
    name?: string;
    address?: string;
  }>;
  businessPhones?: string[];
  homePhones?: string[];
  mobilePhone?: string;
  companyName?: string;
  department?: string;
  jobTitle?: string;
  manager?: string;
  businessAddress?: {
    street?: string;
    city?: string;
    state?: string;
    countryOrRegion?: string;
    postalCode?: string;
  };
  homeAddress?: {
    street?: string;
    city?: string;
    state?: string;
    countryOrRegion?: string;
    postalCode?: string;
  };
  birthday?: string;
  personalNotes?: string;
  categories?: string[];
  parentFolderId?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
}

// Contact Folder structure
interface MicrosoftContactFolder {
  id: string;
  displayName?: string;
  parentFolderId?: string;
}

// List response
interface ContactListResponse {
  '@odata.context'?: string;
  '@odata.nextLink'?: string;
  value: (MicrosoftContact | MicrosoftContactFolder)[];
}

type ContactPayload = MicrosoftContact | MicrosoftContactFolder | ContactListResponse;

const ContactEmailAddressSchema = z.object({
  name: z.string().optional(),
  address: z.string().optional(),
});

const ContactPhysicalAddressSchema = z.object({
  street: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  countryOrRegion: z.string().optional(),
  postalCode: z.string().optional(),
});

const ContactDataSchema = z.object({
  id: z.string().describe('Microsoft Contacts contact id.'),
  displayName: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  middleName: z.string().optional(),
  nickName: z.string().optional(),
  title: z.string().optional(),
  emails: z.array(ContactEmailAddressSchema).optional(),
  businessPhones: z.array(z.string()).optional(),
  homePhones: z.array(z.string()).optional(),
  mobilePhone: z.string().optional(),
  company: z.string().optional(),
  department: z.string().optional(),
  jobTitle: z.string().optional(),
  manager: z.string().optional(),
  businessAddress: ContactPhysicalAddressSchema.optional(),
  homeAddress: ContactPhysicalAddressSchema.optional(),
  birthday: z.string().optional().describe('Birthday — anchor for "alert N days before birthday" patterns.'),
  notes: z.string().optional(),
  categories: z.array(z.string()).optional(),
  parentFolderId: z.string().optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional(),
});

const ContactFolderDataSchema = z.object({
  id: z.string().describe('Microsoft Contacts folder id.'),
  displayName: z.string().optional(),
  parentFolderId: z.string().optional(),
});

export class MicrosoftContactsNormalizer implements ConnectorNormalizer {
  connectorType = 'microsoft_contacts';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    Contact: ContactDataSchema,
    ContactFolder: ContactFolderDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const records: NormalizedRecord[] = [];
    const contactPayload = payload as ContactPayload;

    // Reactive polling path: the scheduler wraps client.list() rows as
    // { results: [...] }. Normalize each row as an individual contact.
    const wrapped = (payload as { results?: unknown[] })?.results;
    if (Array.isArray(wrapped)) {
      for (const item of wrapped) {
        if (this.isContact(item as ContactPayload)) {
          records.push(this.normalizeContact(item as MicrosoftContact));
        }
      }
      return records;
    }

    // Handle list response
    if (this.isListResponse(contactPayload)) {
      for (const item of contactPayload.value) {
        records.push(this.normalizeItem(item));
      }
      return records;
    }

    // Handle single item
    if (this.isContact(contactPayload) || this.isContactFolder(contactPayload)) {
      records.push(this.normalizeItem(contactPayload));
      return records;
    }

    return records;
  }

  private normalizeItem(item: MicrosoftContact | MicrosoftContactFolder): NormalizedRecord {
    if (this.isContact(item)) {
      return this.normalizeContact(item);
    }
    return this.normalizeContactFolder(item as MicrosoftContactFolder);
  }

  private normalizeContact(contact: MicrosoftContact): NormalizedRecord {
    return {
      entityType: 'Contact',
      externalId: contact.id,
      data: ContactDataSchema.parse({
        id: contact.id,
        displayName: contact.displayName,
        firstName: contact.givenName,
        lastName: contact.surname,
        middleName: contact.middleName,
        nickName: contact.nickName,
        title: contact.title,
        emails: contact.emailAddresses?.map(e => ({
          name: e.name,
          address: e.address,
        })),
        businessPhones: contact.businessPhones,
        homePhones: contact.homePhones,
        mobilePhone: contact.mobilePhone,
        company: contact.companyName,
        department: contact.department,
        jobTitle: contact.jobTitle,
        manager: contact.manager,
        businessAddress: contact.businessAddress,
        homeAddress: contact.homeAddress,
        birthday: contact.birthday,
        notes: contact.personalNotes,
        categories: contact.categories,
        parentFolderId: contact.parentFolderId,
        createdAt: contact.createdDateTime,
        modifiedAt: contact.lastModifiedDateTime,
      }),
      metadata: {
        source: 'microsoft_contacts',
        syncedAt: new Date(),
        version: contact.changeKey ?? hashCanonicalJson(contact),
      },
    };
  }

  private normalizeContactFolder(folder: MicrosoftContactFolder): NormalizedRecord {
    return {
      entityType: 'ContactFolder',
      externalId: folder.id,
      data: ContactFolderDataSchema.parse({
        id: folder.id,
        displayName: folder.displayName,
        parentFolderId: folder.parentFolderId,
      }),
      metadata: {
        source: 'microsoft_contacts',
        syncedAt: new Date(),
        version: hashCanonicalJson(folder),
      },
    };
  }

  extractEntityType(record: unknown): string {
    const r = record as ContactPayload;
    if (this.isListResponse(r)) return 'ContactList';
    if (this.isContact(r)) return 'Contact';
    if (this.isContactFolder(r)) return 'ContactFolder';
    return 'Unknown';
  }

  extractExternalId(record: unknown): string {
    const r = record as ContactPayload;
    if (this.isContact(r) || this.isContactFolder(r)) return r.id;
    return '';
  }

  extractVersion(record: unknown): string | undefined {
    const r = record as ContactPayload;
    if (this.isContact(r)) return r.changeKey;
    return undefined;
  }

  private isListResponse(payload: ContactPayload): payload is ContactListResponse {
    return 'value' in payload && Array.isArray(payload.value);
  }

  private isContact(payload: ContactPayload): payload is MicrosoftContact {
    return 'id' in payload && ('displayName' in payload || 'givenName' in payload) && !('parentFolderId' in payload && !('givenName' in payload));
  }

  private isContactFolder(payload: ContactPayload): payload is MicrosoftContactFolder {
    return 'id' in payload && 'displayName' in payload && !('givenName' in payload) && !('emailAddresses' in payload);
  }
}
