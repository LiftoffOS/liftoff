// Salesforce Connector Normalizer
// Per Section 12: Connector ingestion

import { ConnectorNormalizer, NormalizedRecord } from './types';

interface SalesforceWebhookPayload {
  event?: {
    type: string;
    createdDate: string;
  };
  sobject?: Record<string, unknown>;
  records?: Array<Record<string, unknown>>;
}

export class SalesforceNormalizer implements ConnectorNormalizer {
  connectorType = 'salesforce';

  normalize(payload: unknown): NormalizedRecord[] {
    const sfPayload = payload as SalesforceWebhookPayload;
    const records: NormalizedRecord[] = [];

    // Handle single record change event
    if (sfPayload.sobject) {
      records.push(this.normalizeRecord(sfPayload.sobject));
    }

    // Handle bulk records
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

    // Map Salesforce fields to normalized format
    const data: Record<string, unknown> = {
      id: record.Id,
      name: record.Name,
      createdDate: record.CreatedDate,
      lastModifiedDate: record.LastModifiedDate,
      ownerId: record.OwnerId,
    };

    // Copy all other fields
    for (const [key, value] of Object.entries(record)) {
      if (!['Id', 'Name', 'CreatedDate', 'LastModifiedDate', 'OwnerId', 'attributes'].includes(key)) {
        data[this.camelCase(key)] = value;
      }
    }

    // Handle specific object types
    if (entityType === 'Account') {
      data.industry = record.Industry;
      data.website = record.Website;
      data.phone = record.Phone;
      data.billingAddress = this.extractAddress(record, 'Billing');
      data.shippingAddress = this.extractAddress(record, 'Shipping');
    } else if (entityType === 'Contact') {
      data.email = record.Email;
      data.phone = record.Phone;
      data.accountId = record.AccountId;
      data.title = record.Title;
    } else if (entityType === 'Opportunity') {
      data.amount = record.Amount;
      data.stage = record.StageName;
      data.closeDate = record.CloseDate;
      data.accountId = record.AccountId;
    } else if (entityType === 'Lead') {
      data.email = record.Email;
      data.company = record.Company;
      data.status = record.Status;
      data.isConverted = record.IsConverted;
    }

    return {
      entityType,
      externalId,
      data,
      metadata: {
        source: 'salesforce',
        syncedAt: new Date(),
        version: record.SystemModstamp as string | undefined,
      },
    };
  }

  extractEntityType(record: unknown): string {
    const r = record as Record<string, unknown>;
    // Salesforce includes type in attributes
    if (r.attributes && typeof r.attributes === 'object') {
      const attrs = r.attributes as Record<string, unknown>;
      if (attrs.type) return attrs.type as string;
    }
    // Fallback to detecting by fields
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

  private camelCase(str: string): string {
    return str.charAt(0).toLowerCase() + str.slice(1);
  }

  private extractAddress(record: Record<string, unknown>, prefix: string): Record<string, unknown> | null {
    const street = record[`${prefix}Street`];
    const city = record[`${prefix}City`];
    const state = record[`${prefix}State`];
    const postalCode = record[`${prefix}PostalCode`];
    const country = record[`${prefix}Country`];

    if (!street && !city && !state) return null;

    return { street, city, state, postalCode, country };
  }
}
