// Slack Connector Normalizer
// Per Section 12: Connector ingestion

import { ConnectorNormalizer, NormalizedRecord } from './types';

interface SlackEventPayload {
  type: string;
  event?: {
    type: string;
    user?: string;
    channel?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    files?: Array<{
      id: string;
      name: string;
      mimetype: string;
      url_private: string;
    }>;
    reactions?: Array<{
      name: string;
      users: string[];
      count: number;
    }>;
  };
  team_id?: string;
  event_id?: string;
  event_time?: number;
}

export class SlackNormalizer implements ConnectorNormalizer {
  connectorType = 'slack';

  normalize(payload: unknown): NormalizedRecord[] {
    const slackPayload = payload as SlackEventPayload;
    const records: NormalizedRecord[] = [];

    if (!slackPayload.event) {
      return records;
    }

    const event = slackPayload.event;
    const entityType = this.mapEventType(event.type);

    const record: NormalizedRecord = {
      entityType,
      externalId: slackPayload.event_id || event.ts || '',
      data: {
        eventType: event.type,
        teamId: slackPayload.team_id,
        channelId: event.channel,
        userId: event.user,
        timestamp: event.ts,
        threadTimestamp: event.thread_ts,
        eventTime: slackPayload.event_time
          ? new Date(slackPayload.event_time * 1000)
          : undefined,
      },
      metadata: {
        source: 'slack',
        syncedAt: new Date(),
        version: event.ts,
      },
    };

    // Handle specific event types
    if (event.type === 'message' || event.type === 'app_mention') {
      record.data.text = event.text;
      record.data.isThreadReply = !!event.thread_ts;

      if (event.files) {
        record.data.files = event.files.map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimetype,
          url: f.url_private,
        }));
      }
    }

    if (event.type === 'reaction_added' || event.type === 'reaction_removed') {
      record.data.reactions = event.reactions;
    }

    records.push(record);

    return records;
  }

  extractEntityType(record: unknown): string {
    const r = record as { event?: { type: string } };
    return r.event ? this.mapEventType(r.event.type) : 'Unknown';
  }

  extractExternalId(record: unknown): string {
    const r = record as { event_id?: string; event?: { ts?: string } };
    return r.event_id || r.event?.ts || '';
  }

  extractVersion(record: unknown): string | undefined {
    const r = record as { event?: { ts?: string } };
    return r.event?.ts;
  }

  private mapEventType(slackType: string): string {
    const mapping: Record<string, string> = {
      message: 'Message',
      app_mention: 'Mention',
      reaction_added: 'Reaction',
      reaction_removed: 'Reaction',
      channel_created: 'Channel',
      channel_deleted: 'Channel',
      channel_rename: 'Channel',
      member_joined_channel: 'Membership',
      member_left_channel: 'Membership',
      user_change: 'User',
      team_join: 'User',
      file_created: 'File',
      file_deleted: 'File',
      file_shared: 'File',
    };
    return mapping[slackType] || 'Event';
  }
}
