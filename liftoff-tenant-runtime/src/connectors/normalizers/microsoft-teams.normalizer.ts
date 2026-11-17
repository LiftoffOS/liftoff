// Microsoft Teams Connector Normalizer
// Per Section 12: Connector ingestion - normalizes Microsoft Graph API responses

import { ConnectorNormalizer, NormalizedRecord } from './types';
import { hashCanonicalJson } from './idempotency';

// Teams Team structure
interface TeamsTeam {
  id: string;
  displayName?: string;
  description?: string;
  visibility?: 'private' | 'public';
  isArchived?: boolean;
  webUrl?: string;
  createdDateTime?: string;
}

// Teams Channel structure
interface TeamsChannel {
  id: string;
  displayName?: string;
  description?: string;
  membershipType?: 'standard' | 'private' | 'unknownFutureValue';
  webUrl?: string;
  email?: string;
  createdDateTime?: string;
  teamId?: string;
}

// Teams Message structure
interface TeamsMessage {
  id: string;
  replyToId?: string;
  etag?: string;
  messageType?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  deletedDateTime?: string;
  subject?: string;
  body?: {
    contentType?: string;
    content?: string;
  };
  from?: {
    user?: {
      id?: string;
      displayName?: string;
      userIdentityType?: string;
    };
  };
  attachments?: Array<{
    id?: string;
    contentType?: string;
    name?: string;
  }>;
  mentions?: Array<{
    id?: number;
    mentionText?: string;
    mentioned?: {
      user?: {
        id?: string;
        displayName?: string;
      };
    };
  }>;
  reactions?: Array<{
    reactionType?: string;
    createdDateTime?: string;
    user?: {
      displayName?: string;
    };
  }>;
  importance?: string;
  webUrl?: string;
  channelIdentity?: {
    teamId?: string;
    channelId?: string;
  };
}

// List response
interface TeamsListResponse {
  '@odata.context'?: string;
  '@odata.nextLink'?: string;
  value: (TeamsTeam | TeamsChannel | TeamsMessage)[];
}

type TeamsPayload = TeamsTeam | TeamsChannel | TeamsMessage | TeamsListResponse;

export class MicrosoftTeamsNormalizer implements ConnectorNormalizer {
  connectorType = 'microsoft_teams';

  normalize(payload: unknown): NormalizedRecord[] {
    const records: NormalizedRecord[] = [];
    const teamsPayload = payload as TeamsPayload;

    // Handle list response
    if (this.isListResponse(teamsPayload)) {
      for (const item of teamsPayload.value) {
        records.push(this.normalizeItem(item));
      }
      return records;
    }

    // Handle single item
    if (this.isTeam(teamsPayload) || this.isChannel(teamsPayload) || this.isMessage(teamsPayload)) {
      records.push(this.normalizeItem(teamsPayload));
      return records;
    }

    return records;
  }

  private normalizeItem(item: TeamsTeam | TeamsChannel | TeamsMessage): NormalizedRecord {
    if (this.isTeam(item)) {
      return this.normalizeTeam(item);
    }
    if (this.isChannel(item)) {
      return this.normalizeChannel(item);
    }
    return this.normalizeMessage(item as TeamsMessage);
  }

  private normalizeTeam(team: TeamsTeam): NormalizedRecord {
    return {
      entityType: 'Team',
      externalId: team.id,
      data: {
        displayName: team.displayName,
        description: team.description,
        visibility: team.visibility,
        isArchived: team.isArchived,
        webUrl: team.webUrl,
        createdAt: team.createdDateTime,
      },
      metadata: {
        source: 'microsoft_teams',
        syncedAt: new Date(),
        version: hashCanonicalJson(team),
      },
    };
  }

  private normalizeChannel(channel: TeamsChannel): NormalizedRecord {
    return {
      entityType: 'Channel',
      externalId: channel.teamId ? `${channel.teamId}:${channel.id}` : channel.id,
      data: {
        displayName: channel.displayName,
        description: channel.description,
        membershipType: channel.membershipType,
        webUrl: channel.webUrl,
        email: channel.email,
        teamId: channel.teamId,
        createdAt: channel.createdDateTime,
      },
      metadata: {
        source: 'microsoft_teams',
        syncedAt: new Date(),
        version: hashCanonicalJson(channel),
      },
    };
  }

  private normalizeMessage(message: TeamsMessage): NormalizedRecord {
    const teamId = message.channelIdentity?.teamId;
    const channelId = message.channelIdentity?.channelId;
    const externalId = teamId && channelId
      ? `${teamId}:${channelId}:${message.id}`
      : message.id;

    return {
      entityType: message.replyToId ? 'Reply' : 'Message',
      externalId,
      data: {
        messageType: message.messageType,
        subject: message.subject,
        bodyContentType: message.body?.contentType,
        bodyPreview: message.body?.content?.substring(0, 200),
        from: message.from?.user ? {
          id: message.from.user.id,
          displayName: message.from.user.displayName,
        } : undefined,
        replyToId: message.replyToId,
        hasAttachments: (message.attachments?.length || 0) > 0,
        attachmentCount: message.attachments?.length || 0,
        mentionCount: message.mentions?.length || 0,
        reactionCount: message.reactions?.length || 0,
        importance: message.importance,
        webUrl: message.webUrl,
        teamId,
        channelId,
        isDeleted: !!message.deletedDateTime,
        createdAt: message.createdDateTime,
        modifiedAt: message.lastModifiedDateTime,
        deletedAt: message.deletedDateTime,
      },
      metadata: {
        source: 'microsoft_teams',
        syncedAt: new Date(),
        version: message.etag,
      },
    };
  }

  extractEntityType(record: unknown): string {
    const r = record as TeamsPayload;
    if (this.isListResponse(r)) return 'ItemList';
    if (this.isTeam(r)) return 'Team';
    if (this.isChannel(r)) return 'Channel';
    if (this.isMessage(r)) return r.replyToId ? 'Reply' : 'Message';
    return 'Unknown';
  }

  extractExternalId(record: unknown): string {
    const r = record as TeamsPayload;
    if (this.isTeam(r) || this.isChannel(r) || this.isMessage(r)) return r.id;
    return '';
  }

  extractVersion(record: unknown): string | undefined {
    const r = record as TeamsPayload;
    if (this.isMessage(r)) return r.etag;
    return undefined;
  }

  private isListResponse(payload: TeamsPayload): payload is TeamsListResponse {
    return 'value' in payload && Array.isArray(payload.value);
  }

  private isTeam(payload: TeamsPayload): payload is TeamsTeam {
    return 'id' in payload && 'displayName' in payload && 'visibility' in payload;
  }

  private isChannel(payload: TeamsPayload): payload is TeamsChannel {
    return 'id' in payload && 'displayName' in payload && 'membershipType' in payload;
  }

  private isMessage(payload: TeamsPayload): payload is TeamsMessage {
    return 'id' in payload && ('body' in payload || 'messageType' in payload);
  }
}
