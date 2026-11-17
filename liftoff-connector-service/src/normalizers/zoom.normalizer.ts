// Zoom Recording Normalizer
// Normalizes Zoom cloud recording API responses into the canonical NormalizedRecord shape.

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import type { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

interface ZoomRecording {
  uuid: string;
  id: string | number;
  topic: string;
  start_time: string;
  duration: number;
  share_url?: string;
  recording_files?: Array<{ file_type: string }>;
}

const MeetingNotesDataSchema = z.object({
  id: z.string().describe('Zoom meeting uuid.'),
  title: z.string(),
  started_at: z.string().describe('Meeting start ISO timestamp — anchor for "alert N minutes before start" patterns.'),
  ended_at: z.string(),
  attendees: z.array(z.object({ email: z.string(), name: z.string() })),
  transcript_available: z.boolean(),
  notes_url: z.string().nullable(),
});

export class ZoomNormalizer implements ConnectorNormalizer {
  readonly connectorType = 'zoom';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    MeetingNotes: MeetingNotesDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const raw = payload as ZoomRecording | { meetings?: ZoomRecording[] } | ZoomRecording[];
    let recordings: ZoomRecording[];

    if (Array.isArray(raw)) {
      recordings = raw;
    } else if ('meetings' in (raw as object)) {
      recordings = (raw as { meetings?: ZoomRecording[] }).meetings ?? [];
    } else {
      recordings = [raw as ZoomRecording];
    }

    return recordings.map(r => this.normalizeRecording(r));
  }

  extractEntityType(_record: unknown): string {
    return 'MeetingNotes';
  }

  extractExternalId(record: unknown): string {
    return String((record as ZoomRecording).uuid);
  }

  extractVersion(record: unknown): string | undefined {
    return String((record as ZoomRecording).id);
  }

  private normalizeRecording(recording: ZoomRecording): NormalizedRecord {
    const durationMs = (recording.duration ?? 0) * 60 * 1000;
    const startedAt = recording.start_time;
    const endedAt = new Date(new Date(startedAt).getTime() + durationMs).toISOString();

    return {
      entityType: 'MeetingNotes',
      externalId: String(recording.uuid),
      data: MeetingNotesDataSchema.parse({
        id: String(recording.uuid),
        title: recording.topic,
        started_at: startedAt,
        ended_at: endedAt,
        attendees: [],
        transcript_available: (recording.recording_files ?? []).some(f => f.file_type === 'TRANSCRIPT'),
        notes_url: recording.share_url ?? null,
      }),
      metadata: {
        source: 'zoom',
        syncedAt: new Date(),
        version: hashCanonicalJson(recording),
      },
    };
  }
}
