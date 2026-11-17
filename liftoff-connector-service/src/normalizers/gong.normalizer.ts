// Gong Connector Normalizer
//
// Gong is reactive via polling (no Composio trigger exists). The polling
// scheduler hands GongClient.list('Call') results to normalize() as
// { results: [call, ...] }. Field set is the documented Gong /v2/calls Call
// object, restricted to identity, timing, and the fields a reactive
// subscription would predicate on (duration, direction, primaryUserId).

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

interface GongCall {
  id?: string;
  url?: string;
  title?: string;
  scheduled?: string;
  started?: string;
  duration?: number;
  primaryUserId?: string;
  direction?: string;
  system?: string;
  scope?: string;
  language?: string;
  workspaceId?: string;
  meetingUrl?: string;
}

interface GongPayload {
  results?: GongCall[];
}

const CallDataSchema = z.object({
  id: z.string().describe('Gong call id.'),
  title: z.string().optional().describe('Call title.'),
  scheduled: z.string().optional().describe('Scheduled start ISO timestamp.'),
  started: z.string().optional().describe('Actual call start ISO timestamp — anchor for "alert N minutes after a call" patterns.'),
  duration: z.number().optional().describe('Call duration in seconds.'),
  primaryUserId: z.string().optional().describe('Gong user id of the call owner (the rep).'),
  direction: z.string().optional().describe('Call direction (Inbound, Outbound, Conference, Unknown).'),
  scope: z.string().optional().describe('Call scope (Internal, External, Unknown).'),
  language: z.string().optional().describe('Detected call language.'),
  workspaceId: z.string().optional().describe('Gong workspace id the call belongs to.'),
  url: z.string().optional().describe('Gong web URL for the call.'),
  meetingUrl: z.string().optional().describe('Original meeting URL (Zoom/Meet/Teams) if present.'),
});

export class GongNormalizer implements ConnectorNormalizer {
  connectorType = 'gong';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    Call: CallDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const calls = (payload as GongPayload)?.results ?? [];
    const records: NormalizedRecord[] = [];

    for (const call of calls) {
      if (call?.id === undefined || call.id === null) continue;
      const id = String(call.id);
      const declared: Record<string, unknown> = {
        id,
        title: call.title,
        scheduled: call.scheduled,
        started: call.started,
        duration: call.duration,
        primaryUserId: call.primaryUserId,
        direction: call.direction,
        scope: call.scope,
        language: call.language,
        workspaceId: call.workspaceId,
        url: call.url,
        meetingUrl: call.meetingUrl,
      };
      records.push({
        entityType: 'Call',
        externalId: id,
        data: declared,
        metadata: {
          source: 'gong',
          syncedAt: new Date(),
          version: call.started ?? hashCanonicalJson(call),
        },
      });
    }

    return records;
  }

  extractEntityType(_record: unknown): string {
    return 'Call';
  }

  extractExternalId(record: unknown): string {
    return String((record as GongCall).id ?? '');
  }

  extractVersion(record: unknown): string | undefined {
    return (record as GongCall).started;
  }
}
