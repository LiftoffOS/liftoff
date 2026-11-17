// Google Mail (Gmail) Connector Normalizer
// Per Section 12: Connector ingestion - normalizes Gmail API responses

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

const EmailAttachmentSchema = z.object({
  filename: z.string(),
  mimeType: z.string(),
  size: z.number(),
});

const EmailLabelColorSchema = z.object({
  textColor: z.string().optional(),
  backgroundColor: z.string().optional(),
});

const EmailDataSchema = z.object({
  id: z.string().describe('Gmail message id.'),
  threadId: z.string().optional(),
  snippet: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  sizeEstimate: z.number().optional(),
  subject: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  replyTo: z.string().optional(),
  messageId: z.string().optional(),
  inReplyTo: z.string().optional(),
  references: z.string().optional(),
  date: z.string().optional().describe('Message date header — anchor for "follow up N days after received" patterns.'),
  internalDate: z.date().optional(),
  mimeType: z.string().optional(),
  body: z.string().nullable().optional(),
  hasAttachments: z.boolean(),
  attachments: z.array(EmailAttachmentSchema).optional(),
  isUnread: z.boolean().optional(),
  isStarred: z.boolean().optional(),
  isImportant: z.boolean().optional(),
  isInbox: z.boolean().optional(),
  isSent: z.boolean().optional(),
  isDraft: z.boolean().optional(),
  isTrash: z.boolean().optional(),
  isSpam: z.boolean().optional(),
  isChat: z.boolean().optional(),
  categories: z.array(z.string()).optional(),
});

const EmailThreadDataSchema = z.object({
  id: z.string().describe('Gmail thread id.'),
  snippet: z.string().optional(),
  messageCount: z.number(),
  messageIds: z.array(z.string()).optional(),
  participants: z.array(z.string()).optional(),
  subjects: z.array(z.string()).optional(),
  hasUnread: z.boolean().optional(),
  firstMessageDate: z.date().optional(),
  lastMessageDate: z.date().optional().describe('Latest message timestamp in the thread.'),
});

const EmailLabelDataSchema = z.object({
  id: z.string().describe('Gmail label id.'),
  name: z.string(),
  type: z.string().optional(),
  messageListVisibility: z.string().optional(),
  labelListVisibility: z.string().optional(),
  color: EmailLabelColorSchema.optional(),
  messagesTotal: z.number().optional(),
  messagesUnread: z.number().optional(),
  threadsTotal: z.number().optional(),
  threadsUnread: z.number().optional(),
  isSystem: z.boolean(),
});

const EmailHistoryRefSchema = z.object({
  messageId: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
});

const EmailHistoryDataSchema = z.object({
  id: z.string().describe('Gmail history record id.'),
  historyId: z.string(),
  messagesAdded: z.array(EmailHistoryRefSchema).optional(),
  messagesDeleted: z.array(EmailHistoryRefSchema).optional(),
  labelsAdded: z.array(EmailHistoryRefSchema).optional(),
  labelsRemoved: z.array(EmailHistoryRefSchema).optional(),
  hasChanges: z.boolean(),
});

const EmailRefDataSchema = z.object({
  id: z.string().describe('Gmail message id (forwarding reference).'),
  messageId: z.string(),
  threadId: z.string(),
  requiresFetch: z.boolean(),
});

const EmailThreadRefDataSchema = z.object({
  id: z.string().describe('Gmail thread id (forwarding reference).'),
  threadId: z.string(),
  snippet: z.string().optional(),
  requiresFetch: z.boolean(),
});

const EmailNotificationDataSchema = z.object({
  id: z.string().describe('Gmail push-notification historyId.'),
  emailAddress: z.string(),
  historyId: z.string(),
  requiresFetch: z.boolean(),
});

// Gmail API Message structure
interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
  sizeEstimate?: number;
  raw?: string;
}

interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{
    name: string;
    value: string;
  }>;
  body?: {
    attachmentId?: string;
    size?: number;
    data?: string;
  };
  parts?: GmailMessagePart[];
}

// Gmail API Thread structure
interface GmailThread {
  id: string;
  historyId?: string;
  snippet?: string;
  messages?: GmailMessage[];
}

// Gmail API Label structure
interface GmailLabel {
  id: string;
  name: string;
  type?: 'system' | 'user';
  messageListVisibility?: 'show' | 'hide';
  labelListVisibility?: 'labelShow' | 'labelShowIfUnread' | 'labelHide';
  color?: {
    textColor?: string;
    backgroundColor?: string;
  };
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
  threadsUnread?: number;
}

// Gmail API History record
interface GmailHistoryRecord {
  id: string;
  messages?: Array<{ id: string; threadId: string }>;
  messagesAdded?: Array<{
    message: { id: string; threadId: string; labelIds?: string[] };
  }>;
  messagesDeleted?: Array<{
    message: { id: string; threadId: string };
  }>;
  labelsAdded?: Array<{
    message: { id: string; threadId: string };
    labelIds: string[];
  }>;
  labelsRemoved?: Array<{
    message: { id: string; threadId: string };
    labelIds: string[];
  }>;
}

// Gmail List responses
interface GmailMessagesListResponse {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

interface GmailThreadsListResponse {
  threads?: Array<{ id: string; snippet?: string; historyId?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

interface GmailHistoryResponse {
  history?: GmailHistoryRecord[];
  nextPageToken?: string;
  historyId?: string;
}

// Gmail Push notification
interface GmailPushNotification {
  emailAddress: string;
  historyId: string;
}

type GmailPayload =
  | GmailMessage
  | GmailThread
  | GmailLabel
  | GmailMessagesListResponse
  | GmailThreadsListResponse
  | GmailHistoryResponse
  | GmailPushNotification;

export class GoogleMailNormalizer implements ConnectorNormalizer {
  connectorType = 'google_mail';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    Email: EmailDataSchema,
    EmailThread: EmailThreadDataSchema,
    EmailLabel: EmailLabelDataSchema,
    EmailHistory: EmailHistoryDataSchema,
    EmailRef: EmailRefDataSchema,
    EmailThreadRef: EmailThreadRefDataSchema,
    EmailNotification: EmailNotificationDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const records: NormalizedRecord[] = [];
    const gmailPayload = payload as GmailPayload;

    // Reactive polling path: the scheduler wraps `GoogleMailClient.list()`
    // results as `{ results: [item, …] }`, where each item is the `{id,
    // threadId}` message ref Gmail's messages.list returns.
    //
    // This normalizer only ever knew the RAW Gmail API shapes — `messages`,
    // `threads`, `history`, push notifications, single message/thread/label —
    // so every predicate below returned false for the scheduler's envelope and
    // `normalize` returned an empty array. Gmail polling therefore published
    // nothing, ever, and did it silently: no error, connector `active`,
    // Connections page green.
    //
    // Two other defects on this same path produced the identical symptom and
    // were each fixed believing they were the cause — an empty bearer token
    // 401ing every poll, then a 33-second cursor window that outran Gmail's
    // search indexing. A stage that drops records without saying so can absorb
    // any number of upstream repairs and still yield nothing, which is why the
    // poll summary now reports `normalized` alongside `fetched` and
    // `published`: so the next such gap names itself instead of being deduced.
    //
    // github.ts documents this same contract at the same seam. The envelope is
    // the scheduler's, not the vendor's; a normalizer that does not speak it is
    // not wired to the polling path at all.
    const scheduled = (payload as { results?: unknown })?.results;
    if (Array.isArray(scheduled)) {
      for (const item of scheduled) {
        const ref = item as { id?: unknown; threadId?: unknown };
        // A ref with no id cannot be addressed downstream, and inventing one
        // would publish an event nothing can act on.
        if (typeof ref?.id !== 'string') continue;
        records.push(this.normalizeMessageRef({
          id: ref.id,
          threadId: typeof ref.threadId === 'string' ? ref.threadId : ref.id,
        }));
      }
      return records;
    }

    // Handle messages list response
    if (this.isMessagesListResponse(gmailPayload)) {
      for (const msg of gmailPayload.messages || []) {
        records.push(this.normalizeMessageRef(msg));
      }
      return records;
    }

    // Handle threads list response
    if (this.isThreadsListResponse(gmailPayload)) {
      for (const thread of gmailPayload.threads || []) {
        records.push(this.normalizeThreadRef(thread));
      }
      return records;
    }

    // Handle history response
    if (this.isHistoryResponse(gmailPayload)) {
      for (const historyRecord of gmailPayload.history || []) {
        records.push(this.normalizeHistory(historyRecord));
      }
      return records;
    }

    // Handle push notification
    if (this.isPushNotification(gmailPayload)) {
      records.push(this.normalizePushNotification(gmailPayload));
      return records;
    }

    // Handle single thread
    if (this.isThread(gmailPayload)) {
      records.push(this.normalizeThread(gmailPayload));
      return records;
    }

    // Handle single message
    if (this.isMessage(gmailPayload)) {
      records.push(this.normalizeMessage(gmailPayload));
      return records;
    }

    // Handle label
    if (this.isLabel(gmailPayload)) {
      records.push(this.normalizeLabel(gmailPayload));
      return records;
    }

    return records;
  }

  private normalizeMessage(message: GmailMessage): NormalizedRecord {
    const headers = this.extractHeaders(message.payload?.headers || []);

    return {
      entityType: 'Email',
      externalId: message.id,
      data: EmailDataSchema.parse({
        id: message.id,
        // Core message data
        threadId: message.threadId,
        snippet: message.snippet,
        labelIds: message.labelIds,
        sizeEstimate: message.sizeEstimate,

        // Parsed headers
        subject: headers.subject,
        from: headers.from,
        to: headers.to,
        cc: headers.cc,
        bcc: headers.bcc,
        replyTo: headers.replyTo,
        messageId: headers.messageId,
        inReplyTo: headers.inReplyTo,
        references: headers.references,

        // Date information
        date: headers.date,
        internalDate: message.internalDate
          ? new Date(parseInt(message.internalDate, 10))
          : undefined,

        // Content
        mimeType: message.payload?.mimeType,
        body: this.extractBody(message.payload),
        hasAttachments: this.hasAttachments(message.payload),
        attachments: this.extractAttachments(message.payload),

        // Status flags (derived from labels)
        isUnread: message.labelIds?.includes('UNREAD'),
        isStarred: message.labelIds?.includes('STARRED'),
        isImportant: message.labelIds?.includes('IMPORTANT'),
        isInbox: message.labelIds?.includes('INBOX'),
        isSent: message.labelIds?.includes('SENT'),
        isDraft: message.labelIds?.includes('DRAFT'),
        isTrash: message.labelIds?.includes('TRASH'),
        isSpam: message.labelIds?.includes('SPAM'),
        isChat: message.labelIds?.includes('CHAT'),

        // Categories
        categories: this.extractCategories(message.labelIds),
      }),
      metadata: {
        source: 'google_mail',
        syncedAt: new Date(),
        version: message.historyId ?? hashCanonicalJson(message),
      },
    };
  }

  private normalizeThread(thread: GmailThread): NormalizedRecord {
    return {
      entityType: 'EmailThread',
      externalId: thread.id,
      data: EmailThreadDataSchema.parse({
        id: thread.id,
        snippet: thread.snippet,
        messageCount: thread.messages?.length || 0,
        messageIds: thread.messages?.map((m) => m.id),
        participants: this.extractParticipants(thread.messages),
        subjects: this.extractSubjects(thread.messages),
        hasUnread: thread.messages?.some((m) => m.labelIds?.includes('UNREAD')),
        firstMessageDate: this.getFirstMessageDate(thread.messages),
        lastMessageDate: this.getLastMessageDate(thread.messages),
      }),
      metadata: {
        source: 'google_mail',
        syncedAt: new Date(),
        version: thread.historyId ?? hashCanonicalJson(thread),
      },
    };
  }

  private normalizeLabel(label: GmailLabel): NormalizedRecord {
    return {
      entityType: 'EmailLabel',
      externalId: label.id,
      data: EmailLabelDataSchema.parse({
        id: label.id,
        name: label.name,
        type: label.type,
        messageListVisibility: label.messageListVisibility,
        labelListVisibility: label.labelListVisibility,
        color: label.color,
        messagesTotal: label.messagesTotal,
        messagesUnread: label.messagesUnread,
        threadsTotal: label.threadsTotal,
        threadsUnread: label.threadsUnread,
        isSystem: label.type === 'system',
      }),
      metadata: {
        source: 'google_mail',
        syncedAt: new Date(),
        version: hashCanonicalJson(label),
      },
    };
  }

  private normalizeHistory(history: GmailHistoryRecord): NormalizedRecord {
    return {
      entityType: 'EmailHistory',
      externalId: history.id,
      data: EmailHistoryDataSchema.parse({
        id: history.id,
        historyId: history.id,
        messagesAdded: history.messagesAdded?.map((ma) => ({
          messageId: ma.message.id,
          threadId: ma.message.threadId,
          labelIds: ma.message.labelIds,
        })),
        messagesDeleted: history.messagesDeleted?.map((md) => ({
          messageId: md.message.id,
          threadId: md.message.threadId,
        })),
        labelsAdded: history.labelsAdded?.map((la) => ({
          messageId: la.message.id,
          threadId: la.message.threadId,
          labelIds: la.labelIds,
        })),
        labelsRemoved: history.labelsRemoved?.map((lr) => ({
          messageId: lr.message.id,
          threadId: lr.message.threadId,
          labelIds: lr.labelIds,
        })),
        hasChanges:
          (history.messagesAdded?.length || 0) > 0 ||
          (history.messagesDeleted?.length || 0) > 0 ||
          (history.labelsAdded?.length || 0) > 0 ||
          (history.labelsRemoved?.length || 0) > 0,
      }),
      metadata: {
        source: 'google_mail',
        syncedAt: new Date(),
        version: history.id,
      },
    };
  }

  private normalizeMessageRef(ref: { id: string; threadId: string }): NormalizedRecord {
    return {
      entityType: 'EmailRef',
      externalId: ref.id,
      data: EmailRefDataSchema.parse({
        id: ref.id,
        messageId: ref.id,
        threadId: ref.threadId,
        requiresFetch: true,
      }),
      metadata: {
        source: 'google_mail',
        syncedAt: new Date(),
        version: hashCanonicalJson(ref),
      },
    };
  }

  private normalizeThreadRef(ref: {
    id: string;
    snippet?: string;
    historyId?: string;
  }): NormalizedRecord {
    return {
      entityType: 'EmailThreadRef',
      externalId: ref.id,
      data: EmailThreadRefDataSchema.parse({
        id: ref.id,
        threadId: ref.id,
        snippet: ref.snippet,
        requiresFetch: true,
      }),
      metadata: {
        source: 'google_mail',
        syncedAt: new Date(),
        version: ref.historyId ?? hashCanonicalJson(ref),
      },
    };
  }

  private normalizePushNotification(notification: GmailPushNotification): NormalizedRecord {
    return {
      entityType: 'EmailNotification',
      externalId: notification.historyId,
      data: EmailNotificationDataSchema.parse({
        id: notification.historyId,
        emailAddress: notification.emailAddress,
        historyId: notification.historyId,
        requiresFetch: true,
      }),
      metadata: {
        source: 'google_mail',
        syncedAt: new Date(),
        version: notification.historyId,
      },
    };
  }

  // Helper methods
  private extractHeaders(headers: Array<{ name: string; value: string }>): Record<string, string> {
    const result: Record<string, string> = {};
    const headerMap: Record<string, string> = {
      Subject: 'subject',
      From: 'from',
      To: 'to',
      Cc: 'cc',
      Bcc: 'bcc',
      'Reply-To': 'replyTo',
      Date: 'date',
      'Message-ID': 'messageId',
      'In-Reply-To': 'inReplyTo',
      References: 'references',
    };

    for (const header of headers) {
      const key = headerMap[header.name];
      if (key) {
        result[key] = header.value;
      }
    }

    return result;
  }

  private extractBody(part: GmailMessagePart | undefined): string | undefined {
    if (!part) return undefined;

    // Check for plain text body
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64').toString('utf-8');
    }

    // Check nested parts
    if (part.parts) {
      for (const subPart of part.parts) {
        const body = this.extractBody(subPart);
        if (body) return body;
      }
    }

    return undefined;
  }

  private hasAttachments(part: GmailMessagePart | undefined): boolean {
    if (!part) return false;
    if (part.filename && part.body?.attachmentId) return true;
    if (part.parts) {
      return part.parts.some((p) => this.hasAttachments(p));
    }
    return false;
  }

  private extractAttachments(
    part: GmailMessagePart | undefined
  ): Array<{ filename: string; mimeType: string; size: number }> {
    const attachments: Array<{ filename: string; mimeType: string; size: number }> = [];

    const extract = (p: GmailMessagePart) => {
      if (p.filename && p.body?.attachmentId) {
        attachments.push({
          filename: p.filename,
          mimeType: p.mimeType || 'application/octet-stream',
          size: p.body.size || 0,
        });
      }
      if (p.parts) {
        p.parts.forEach(extract);
      }
    };

    if (part) extract(part);
    return attachments;
  }

  private extractCategories(labelIds: string[] | undefined): string[] {
    if (!labelIds) return [];
    const categoryPrefixes = ['CATEGORY_'];
    return labelIds
      .filter((id) => categoryPrefixes.some((p) => id.startsWith(p)))
      .map((id) => id.replace('CATEGORY_', '').toLowerCase());
  }

  private extractParticipants(messages: GmailMessage[] | undefined): string[] {
    const participants = new Set<string>();

    for (const message of messages || []) {
      const headers = message.payload?.headers || [];
      for (const header of headers) {
        if (['From', 'To', 'Cc'].includes(header.name)) {
          // Simple extraction - in production would use proper email parsing
          participants.add(header.value);
        }
      }
    }

    return Array.from(participants);
  }

  private extractSubjects(messages: GmailMessage[] | undefined): string[] {
    const subjects = new Set<string>();

    for (const message of messages || []) {
      const headers = message.payload?.headers || [];
      const subjectHeader = headers.find((h) => h.name === 'Subject');
      if (subjectHeader?.value) {
        subjects.add(subjectHeader.value);
      }
    }

    return Array.from(subjects);
  }

  private getFirstMessageDate(messages: GmailMessage[] | undefined): Date | undefined {
    if (!messages?.length) return undefined;
    const dates = messages
      .map((m) => (m.internalDate ? parseInt(m.internalDate, 10) : 0))
      .filter((d) => d > 0);
    return dates.length > 0 ? new Date(Math.min(...dates)) : undefined;
  }

  private getLastMessageDate(messages: GmailMessage[] | undefined): Date | undefined {
    if (!messages?.length) return undefined;
    const dates = messages
      .map((m) => (m.internalDate ? parseInt(m.internalDate, 10) : 0))
      .filter((d) => d > 0);
    return dates.length > 0 ? new Date(Math.max(...dates)) : undefined;
  }

  extractEntityType(record: unknown): string {
    const r = record as GmailPayload;
    if (this.isMessagesListResponse(r)) return 'EmailList';
    if (this.isThreadsListResponse(r)) return 'EmailThreadList';
    if (this.isHistoryResponse(r)) return 'EmailHistoryList';
    if (this.isPushNotification(r)) return 'EmailNotification';
    if (this.isThread(r)) return 'EmailThread';
    if (this.isMessage(r)) return 'Email';
    if (this.isLabel(r)) return 'EmailLabel';
    return 'Unknown';
  }

  extractExternalId(record: unknown): string {
    const r = record as GmailPayload;
    if (this.isMessagesListResponse(r)) return r.nextPageToken || '';
    if (this.isThreadsListResponse(r)) return r.nextPageToken || '';
    if (this.isHistoryResponse(r)) return r.historyId || '';
    if (this.isPushNotification(r)) return r.historyId;
    if (this.isThread(r)) return r.id;
    if (this.isMessage(r)) return r.id;
    if (this.isLabel(r)) return r.id;
    return '';
  }

  extractVersion(record: unknown): string | undefined {
    const r = record as GmailPayload;
    if (this.isMessage(r)) return r.historyId;
    if (this.isThread(r)) return r.historyId;
    if (this.isHistoryResponse(r)) return r.historyId;
    if (this.isPushNotification(r)) return r.historyId;
    return undefined;
  }

  private isMessagesListResponse(payload: GmailPayload): payload is GmailMessagesListResponse {
    return 'messages' in payload && Array.isArray((payload as any).messages);
  }

  private isThreadsListResponse(payload: GmailPayload): payload is GmailThreadsListResponse {
    return 'threads' in payload && Array.isArray((payload as any).threads);
  }

  private isHistoryResponse(payload: GmailPayload): payload is GmailHistoryResponse {
    return 'history' in payload && Array.isArray((payload as any).history);
  }

  private isPushNotification(payload: GmailPayload): payload is GmailPushNotification {
    return 'emailAddress' in payload && 'historyId' in payload;
  }

  private isThread(payload: GmailPayload): payload is GmailThread {
    return 'id' in payload && 'messages' in payload && !('payload' in payload);
  }

  private isMessage(payload: GmailPayload): payload is GmailMessage {
    return 'id' in payload && 'threadId' in payload && !('messages' in payload);
  }

  private isLabel(payload: GmailPayload): payload is GmailLabel {
    return 'id' in payload && 'name' in payload && !('threadId' in payload);
  }
}
