// Calendly Connector Normalizer
//
// Calendly is reactive via native polling (DCR OAuth bearer; no Composio, no
// native webhook wired). The polling scheduler hands CalendlyClient.list('Event')
// results to normalize() as { results: [event] }. Field set is the documented
// Calendly API v2 scheduled-event shape, restricted to the fields a reactive
// subscription would predicate on (status, start/end time, event type, location)
// plus identity.

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

interface CalendlyLocation {
  type?: string;
  location?: string;
  join_url?: string;
}

interface CalendlyEvent {
  uri?: string;
  name?: string;
  status?: string;
  start_time?: string;
  end_time?: string;
  event_type?: string;
  location?: CalendlyLocation | string | null;
  invitees_counter?: { total?: number; active?: number; limit?: number };
}

interface CalendlyPayload {
  results?: CalendlyEvent[];
}

const EventDataSchema = z.object({
  id: z.string().describe('Calendly scheduled-event UUID (tail of the event uri).'),
  name: z.string().optional().describe('Name of the scheduled event (the event type title).'),
  status: z.string().optional().describe('Event status (active, canceled).'),
  startTime: z.string().optional().describe('Event start ISO timestamp — anchor for "N minutes before a meeting" patterns.'),
  endTime: z.string().optional().describe('Event end ISO timestamp.'),
  eventType: z.string().optional().describe('URI of the event type this event was booked from.'),
  locationType: z.string().optional().describe('Location kind (zoom, google_conference, physical, custom, etc.).'),
  location: z.string().optional().describe('Human-readable location or join URL for the meeting.'),
  inviteeCount: z.number().optional().describe('Total number of invitees on the event.'),
});

function flattenLocation(loc: CalendlyEvent['location']): { locationType?: string; location?: string } {
  if (!loc) return {};
  if (typeof loc === 'string') return { location: loc };
  return {
    locationType: loc.type,
    location: loc.join_url ?? loc.location,
  };
}

export class CalendlyNormalizer implements ConnectorNormalizer {
  connectorType = 'calendly';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    Event: EventDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const events = (payload as CalendlyPayload)?.results ?? [];
    const records: NormalizedRecord[] = [];

    for (const event of events) {
      if (!event?.uri) continue;
      const id = String(event.uri.split('/').pop());
      const { locationType, location } = flattenLocation(event.location);
      const declared: Record<string, unknown> = {
        id,
        name: event.name,
        status: event.status,
        startTime: event.start_time,
        endTime: event.end_time,
        eventType: event.event_type,
        locationType,
        location,
        inviteeCount: event.invitees_counter?.total,
      };
      records.push({
        entityType: 'Event',
        externalId: id,
        data: declared,
        metadata: {
          source: 'calendly',
          syncedAt: new Date(),
          version: event.start_time ?? hashCanonicalJson(event),
        },
      });
    }

    return records;
  }

  extractEntityType(_record: unknown): string {
    return 'Event';
  }

  extractExternalId(record: unknown): string {
    const uri = (record as CalendlyEvent).uri ?? '';
    return uri ? String(uri.split('/').pop()) : '';
  }

  extractVersion(record: unknown): string | undefined {
    return (record as CalendlyEvent).start_time;
  }
}
