// Microsoft Outlook Mail Connector Normalizer
// Per Section 12: Connector ingestion - normalizes Microsoft Graph API responses

import { ConnectorNormalizer, NormalizedRecord } from './types';
import { hashCanonicalJson } from './idempotency';

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
      data: {
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
      },
      metadata: {
        source: 'microsoft_outlook_mail',
        syncedAt: new Date(),
        version: message.changeKey,
      },
    };
  }

  private normalizeMailFolder(folder: OutlookMailFolder): NormalizedRecord {
    return {
      entityType: 'MailFolder',
      externalId: folder.id,
      data: {
        displayName: folder.displayName,
        parentFolderId: folder.parentFolderId,
        childFolderCount: folder.childFolderCount,
        unreadItemCount: folder.unreadItemCount,
        totalItemCount: folder.totalItemCount,
      },
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
