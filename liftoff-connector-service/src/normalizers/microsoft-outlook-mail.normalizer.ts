// Microsoft Outlook Mail Connector Normalizer
// Per Section 12: Connector ingestion - normalizes Microsoft Graph API responses

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

const EmailAddressSchema = z.object({ name: z.string().optional(), address: z.string().optional() });

const MessageDataSchema = z.object({
  id: z.string().describe('Outlook mail message id.'),
  subject: z.string().optional(),
  bodyPreview: z.string().optional(),
  bodyContentType: z.string().optional(),
  from: EmailAddressSchema.optional(),
  toRecipients: z.array(EmailAddressSchema).optional(),
  ccRecipients: z.array(EmailAddressSchema).optional(),
  hasAttachments: z.boolean().optional(),
  importance: z.string().optional(),
  isRead: z.boolean().optional(),
  isDraft: z.boolean().optional(),
  webLink: z.string().optional(),
  parentFolderId: z.string().optional(),
  conversationId: z.string().optional(),
  receivedAt: z.string().optional().describe('Message received timestamp — anchor for "follow up N hours after received" patterns.'),
  sentAt: z.string().optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional(),
});

const MailFolderDataSchema = z.object({
  id: z.string().describe('Outlook mail folder id.'),
  displayName: z.string().optional(),
  parentFolderId: z.string().optional(),
  childFolderCount: z.number().optional(),
  unreadItemCount: z.number().optional(),
  totalItemCount: z.number().optional(),
});

// Outlook Mail Message structure
interface OutlookMessage {
  id: string;
  changeKey?: string;
  subject?: string;
  bodyPreview?: string;
  body?: {
    contentType?: string;
    content?: string;
  };
  from?: {
    emailAddress?: {
      name?: string;
      address?: string;
    };
  };
  toRecipients?: Array<{
    emailAddress?: {
      name?: string;
      address?: string;
    };
  }>;
  ccRecipients?: Array<{
    emailAddress?: {
      name?: string;
      address?: string;
    };
  }>;
  receivedDateTime?: string;
  sentDateTime?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  hasAttachments?: boolean;
  importance?: string;
  isRead?: boolean;
  isDraft?: boolean;
  webLink?: string;
  parentFolderId?: string;
  conversationId?: string;
}

// Outlook Mail Folder structure
interface OutlookMailFolder {
  id: string;
  displayName?: string;
  parentFolderId?: string;
  childFolderCount?: number;
  unreadItemCount?: number;
  totalItemCount?: number;
}

// List response
interface OutlookListResponse {
  '@odata.context'?: string;
  '@odata.nextLink'?: string;
  value: (OutlookMessage | OutlookMailFolder)[];
}

type OutlookMailPayload = OutlookMessage | OutlookMailFolder | OutlookListResponse;

export class MicrosoftOutlookMailNormalizer implements ConnectorNormalizer {
  connectorType = 'microsoft_outlook_mail';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    Message: MessageDataSchema,
    Draft: MessageDataSchema,
    MailFolder: MailFolderDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const records: NormalizedRecord[] = [];
    const mailPayload = payload as OutlookMailPayload;

    // Handle list response
    if (this.isListResponse(mailPayload)) {
      for (const item of mailPayload.value) {
        records.push(this.normalizeItem(item));
      }
      return records;
    }

    // Handle single item
    if (this.isMessage(mailPayload) || this.isMailFolder(mailPayload)) {
      records.push(this.normalizeItem(mailPayload));
      return records;
    }

    return records;
  }

  private normalizeItem(item: OutlookMessage | OutlookMailFolder): NormalizedRecord {
    if (this.isMessage(item)) {
      return this.normalizeMessage(item);
    }
    return this.normalizeMailFolder(item as OutlookMailFolder);
  }

  private normalizeMessage(message: OutlookMessage): NormalizedRecord {
    return {
      entityType: message.isDraft ? 'Draft' : 'Message',
      externalId: message.id,
      data: MessageDataSchema.parse({
        id: message.id,
        subject: message.subject,
        bodyPreview: message.bodyPreview,
        bodyContentType: message.body?.contentType,
        from: message.from?.emailAddress ? {
          name: message.from.emailAddress.name,
          address: message.from.emailAddress.address,
        } : undefined,
        toRecipients: message.toRecipients?.map(r => ({
          name: r.emailAddress?.name,
          address: r.emailAddress?.address,
        })),
        ccRecipients: message.ccRecipients?.map(r => ({
          name: r.emailAddress?.name,
          address: r.emailAddress?.address,
        })),
        hasAttachments: message.hasAttachments,
        importance: message.importance,
        isRead: message.isRead,
        isDraft: message.isDraft,
        webLink: message.webLink,
        parentFolderId: message.parentFolderId,
        conversationId: message.conversationId,
        receivedAt: message.receivedDateTime,
        sentAt: message.sentDateTime,
        createdAt: message.createdDateTime,
        modifiedAt: message.lastModifiedDateTime,
      }),
      metadata: {
        source: 'microsoft_outlook_mail',
        syncedAt: new Date(),
        version: message.changeKey ?? hashCanonicalJson(message),
      },
    };
  }

  private normalizeMailFolder(folder: OutlookMailFolder): NormalizedRecord {
    return {
      entityType: 'MailFolder',
      externalId: folder.id,
      data: MailFolderDataSchema.parse({
        id: folder.id,
        displayName: folder.displayName,
        parentFolderId: folder.parentFolderId,
        childFolderCount: folder.childFolderCount,
        unreadItemCount: folder.unreadItemCount,
        totalItemCount: folder.totalItemCount,
      }),
      metadata: {
        source: 'microsoft_outlook_mail',
        syncedAt: new Date(),
        version: hashCanonicalJson(folder),
      },
    };
  }

  extractEntityType(record: unknown): string {
    const r = record as OutlookMailPayload;
    if (this.isListResponse(r)) return 'MessageList';
    if (this.isMessage(r)) return r.isDraft ? 'Draft' : 'Message';
    if (this.isMailFolder(r)) return 'MailFolder';
    return 'Unknown';
  }

  extractExternalId(record: unknown): string {
    const r = record as OutlookMailPayload;
    if (this.isMessage(r) || this.isMailFolder(r)) return r.id;
    return '';
  }

  extractVersion(record: unknown): string | undefined {
    const r = record as OutlookMailPayload;
    if (this.isMessage(r)) return r.changeKey;
    return undefined;
  }

  private isListResponse(payload: OutlookMailPayload): payload is OutlookListResponse {
    return 'value' in payload && Array.isArray(payload.value);
  }

  private isMessage(payload: OutlookMailPayload): payload is OutlookMessage {
    return 'id' in payload && ('subject' in payload || 'from' in payload || 'isDraft' in payload);
  }

  private isMailFolder(payload: OutlookMailPayload): payload is OutlookMailFolder {
    return 'id' in payload && 'displayName' in payload && 'totalItemCount' in payload;
  }
}
