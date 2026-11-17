// Slack Connector Normalizer
// Per Section 12: Connector ingestion

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

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

const SlackBaseFields = {
  id: z.string().describe('Slack event id (event_id, falling back to ts).'),
  eventType: z.string(),
  teamId: z.string().optional(),
  channelId: z.string().optional(),
  userId: z.string().optional(),
  timestamp: z.string().optional().describe('Slack message timestamp — anchor for "follow up N hours after received" patterns.'),
  threadTimestamp: z.string().optional(),
  eventTime: z.date().optional(),
};

const MessageDataSchema = z.object({
  ...SlackBaseFields,
  text: z.string().optional(),
  isThreadReply: z.boolean().optional(),
  files: z.array(z.object({
    id: z.string(),
    name: z.string(),
    mimeType: z.string(),
    url: z.string(),
  })).optional(),
});

const MentionDataSchema = MessageDataSchema;

const ReactionDataSchema = z.object({
  ...SlackBaseFields,
  reactions: z.array(z.object({
    name: z.string(),
    users: z.array(z.string()),
    count: z.number(),
  })).optional(),
});

const GenericEventSchema = z.object({ ...SlackBaseFields });

const ENTITY_SCHEMA_MAP: Record<string, z.ZodTypeAny> = {
  Message: MessageDataSchema,
  Mention: MentionDataSchema,
  Reaction: ReactionDataSchema,
  Channel: GenericEventSchema,
  Membership: GenericEventSchema,
  User: GenericEventSchema,
  File: GenericEventSchema,
  Event: GenericEventSchema,
};

export class SlackNormalizer implements ConnectorNormalizer {
  connectorType = 'slack';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    Message: MessageDataSchema,
    Mention: MentionDataSchema,
    Reaction: ReactionDataSchema,
    Channel: GenericEventSchema,
    Membership: GenericEventSchema,
    User: GenericEventSchema,
    File: GenericEventSchema,
    Event: GenericEventSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const slackPayload = payload as SlackEventPayload;
    const records: NormalizedRecord[] = [];

    if (!slackPayload.event) {
      return records;
    }

    const event = slackPayload.event;
    const entityType = this.mapEventType(event.type);
    const externalId = slackPayload.event_id || event.ts || '';

    const declared: Record<string, unknown> = {
      id: externalId,
      eventType: event.type,
      teamId: slackPayload.team_id,
      channelId: event.channel,
      userId: event.user,
      timestamp: event.ts,
      threadTimestamp: event.thread_ts,
      eventTime: slackPayload.event_time
        ? new Date(slackPayload.event_time * 1000)
        : undefined,
    };

    if (event.type === 'message' || event.type === 'app_mention') {
      declared.text = event.text;
      declared.isThreadReply = !!event.thread_ts;

      if (event.files) {
        declared.files = event.files.map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimetype,
          url: f.url_private,
        }));
      }
    }

    if (event.type === 'reaction_added' || event.type === 'reaction_removed') {
      declared.reactions = event.reactions;
    }

    const schema = ENTITY_SCHEMA_MAP[entityType] ?? GenericEventSchema;
    const data = schema.parse(declared);

    records.push({
      entityType,
      externalId,
      data,
      metadata: {
        source: 'slack',
        syncedAt: new Date(),
        version: event.ts ?? hashCanonicalJson(event),
      },
    });

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
