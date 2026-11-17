// Microsoft Contacts Connector Normalizer
// Per Section 12: Connector ingestion - normalizes Microsoft Graph API responses

import { ConnectorNormalizer, NormalizedRecord } from './types';
import { hashCanonicalJson } from './idempotency';

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

export class MicrosoftContactsNormalizer implements ConnectorNormalizer {
  connectorType = 'microsoft_contacts';

  normalize(payload: unknown): NormalizedRecord[] {
    const records: NormalizedRecord[] = [];
    const contactPayload = payload as ContactPayload;

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
      data: {
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
      },
      metadata: {
        source: 'microsoft_contacts',
        syncedAt: new Date(),
        version: contact.changeKey,
      },
    };
  }

  private normalizeContactFolder(folder: MicrosoftContactFolder): NormalizedRecord {
    return {
      entityType: 'ContactFolder',
      externalId: folder.id,
      data: {
        displayName: folder.displayName,
        parentFolderId: folder.parentFolderId,
      },
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
