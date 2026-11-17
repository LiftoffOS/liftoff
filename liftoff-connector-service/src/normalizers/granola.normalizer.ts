// Granola Meeting Notes Normalizer
// Normalizes Granola MCP list/get responses into the canonical NormalizedRecord shape.

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import type { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

interface GranolaMeeting {
  id: string;
  title: string;
  start_time: string;
  end_time: string;
  participants?: Array<{ email?: string; name?: string }>;
  transcript_url?: string;
  notes_url?: string;
  updated_at?: string;
}

const MeetingNotesDataSchema = z.object({
  id: z.string().describe('Granola meeting id.'),
  title: z.string().describe('Meeting title.'),
  started_at: z.string().describe('Meeting start ISO timestamp — anchor for "alert N minutes before start" patterns.'),
  ended_at: z.string().describe('Meeting end ISO timestamp.'),
  attendees: z.array(z.object({ email: z.string(), name: z.string() })).describe('Meeting attendees.'),
  transcript_available: z.boolean().describe('True if a transcript can be fetched.'),
  notes_url: z.string().nullable(),
});

export class GranolaNormalizer implements ConnectorNormalizer {
  readonly connectorType = 'granola';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    MeetingNotes: MeetingNotesDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const raw = payload as GranolaMeeting | { results?: GranolaMeeting[] } | GranolaMeeting[];
    let meetings: GranolaMeeting[];

    if (Array.isArray(raw)) {
      meetings = raw;
    } else if ('results' in (raw as object) && Array.isArray((raw as { results?: unknown[] }).results)) {
      meetings = (raw as { results: GranolaMeeting[] }).results;
    } else {
      meetings = [raw as GranolaMeeting];
    }

    return meetings.map(m => this.normalizeMeeting(m));
  }

  extractEntityType(_record: unknown): string {
    return 'MeetingNotes';
  }

  extractExternalId(record: unknown): string {
    return (record as GranolaMeeting).id;
  }

  extractVersion(record: unknown): string | undefined {
    return (record as GranolaMeeting).updated_at;
  }

  private normalizeMeeting(meeting: GranolaMeeting): NormalizedRecord {
    return {
      entityType: 'MeetingNotes',
      externalId: meeting.id,
      data: MeetingNotesDataSchema.parse({
        id: meeting.id,
        title: meeting.title,
        started_at: meeting.start_time,
        ended_at: meeting.end_time,
        attendees: (meeting.participants ?? []).map(p => ({
          email: p.email ?? '',
          name: p.name ?? '',
        })),
        transcript_available: !!meeting.transcript_url,
        notes_url: meeting.notes_url ?? null,
      }),
      metadata: {
        source: 'granola',
        syncedAt: new Date(),
        version: meeting.updated_at ?? hashCanonicalJson(meeting),
      },
    };
  }
}
