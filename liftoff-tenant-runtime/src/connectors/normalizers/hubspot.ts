// HubSpot Connector Normalizer
// Per Section 12: Connector ingestion

import { ConnectorNormalizer, NormalizedRecord } from './types';
import { hashCanonicalJson } from './idempotency';

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

export class HubSpotNormalizer implements ConnectorNormalizer {
  connectorType = 'hubspot';

  normalize(payload: unknown): NormalizedRecord[] {
    const hsPayload = payload as HubSpotWebhookPayload;
    const records: NormalizedRecord[] = [];

    // Handle webhook subscription event
    if (hsPayload.objectId && hsPayload.objectType) {
      records.push({
        entityType: this.mapObjectType(hsPayload.objectType),
        externalId: String(hsPayload.objectId),
        data: {
          [hsPayload.propertyName || 'value']: hsPayload.propertyValue,
          changeSource: hsPayload.changeSource,
        },
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

    const data: Record<string, unknown> = {
      id: record.id,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      archived: record.archived,
    };

    // Map HubSpot properties
    if (entityType === 'Contact') {
      data.email = props.email;
      data.firstName = props.firstname;
      data.lastName = props.lastname;
      data.phone = props.phone;
      data.company = props.company;
      data.lifecycleStage = props.lifecyclestage;
      data.leadStatus = props.hs_lead_status;
    } else if (entityType === 'Company') {
      data.name = props.name;
      data.domain = props.domain;
      data.industry = props.industry;
      data.phone = props.phone;
      data.city = props.city;
      data.state = props.state;
      data.country = props.country;
      data.employeeCount = props.numberofemployees;
      data.annualRevenue = props.annualrevenue;
    } else if (entityType === 'Deal') {
      data.name = props.dealname;
      data.amount = props.amount;
      data.stage = props.dealstage;
      data.closeDate = props.closedate;
      data.pipeline = props.pipeline;
      data.ownerId = props.hubspot_owner_id;
    } else if (entityType === 'Ticket') {
      data.subject = props.subject;
      data.content = props.content;
      data.status = props.hs_ticket_status;
      data.priority = props.hs_ticket_priority;
      data.category = props.hs_ticket_category;
    }

    // Copy remaining properties
    for (const [key, value] of Object.entries(props)) {
      if (!(key in data)) {
        data[key] = value;
      }
    }

    return {
      entityType,
      externalId: record.id,
      data,
      metadata: {
        source: 'hubspot',
        syncedAt: new Date(),
        version: record.updatedAt,
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
