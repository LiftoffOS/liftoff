// Sentry Connector Normalizer
//
// Sentry is reactive via native polling of the REST Issues API (api_key
// connector). The polling scheduler hands SentryClient.list('Issue') results to
// normalize() as { results: [issue, ...] }. Field set is the documented Sentry
// issue shape, restricted to what a reactive subscription would predicate on
// (level, status, counts, project) plus identity + timestamps.

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

interface SentryIssue {
  id?: string | number;
  shortId?: string;
  title?: string;
  culprit?: string;
  level?: string;
  status?: string;
  substatus?: string;
  count?: string | number;
  userCount?: number;
  firstSeen?: string;
  lastSeen?: string;
  permalink?: string;
  isUnhandled?: boolean;
  priority?: string;
  project?: { id?: string | number; slug?: string; name?: string };
  metadata?: { type?: string; value?: string; filename?: string };
}

const IssueDataSchema = z.object({
  id: z.string().describe('Sentry issue (group) id.'),
  shortId: z.string().optional().describe('Human-facing short id, e.g. PROJECT-1A2.'),
  title: z.string().optional(),
  culprit: z.string().optional().describe('Where the issue originates (transaction/function).'),
  level: z.string().optional().describe('Severity (fatal, error, warning, info, debug).'),
  status: z.string().optional().describe('Issue status (unresolved, resolved, ignored).'),
  substatus: z.string().optional(),
  eventCount: z.number().optional().describe('Number of events in this issue.'),
  userCount: z.number().optional().describe('Number of distinct users affected.'),
  firstSeen: z.string().optional(),
  lastSeen: z.string().optional().describe('Most recent event ISO timestamp — anchor for "alert when an issue reappears" patterns.'),
  permalink: z.string().optional(),
  isUnhandled: z.boolean().optional(),
  priority: z.string().optional(),
  projectSlug: z.string().optional(),
  errorType: z.string().optional().describe('Exception type from issue metadata.'),
  errorValue: z.string().optional().describe('Exception message from issue metadata.'),
});

export class SentryNormalizer implements ConnectorNormalizer {
  connectorType = 'sentry';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    Issue: IssueDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const rows = (payload as { results?: SentryIssue[] })?.results ?? [];
    const records: NormalizedRecord[] = [];
    for (const issue of rows) {
      if (issue?.id === undefined || issue.id === null) continue;
      const id = String(issue.id);
      records.push({
        entityType: 'Issue',
        externalId: id,
        data: {
          id,
          shortId: issue.shortId,
          title: issue.title,
          culprit: issue.culprit,
          level: issue.level,
          status: issue.status,
          substatus: issue.substatus,
          eventCount: issue.count !== undefined ? Number(issue.count) : undefined,
          userCount: issue.userCount,
          firstSeen: issue.firstSeen,
          lastSeen: issue.lastSeen,
          permalink: issue.permalink,
          isUnhandled: issue.isUnhandled,
          priority: issue.priority,
          projectSlug: issue.project?.slug,
          errorType: issue.metadata?.type,
          errorValue: issue.metadata?.value,
        },
        metadata: {
          source: 'sentry',
          syncedAt: new Date(),
          version: issue.lastSeen ?? hashCanonicalJson(issue),
        },
      });
    }
    return records;
  }

  extractEntityType(): string {
    return 'Issue';
  }

  extractExternalId(record: unknown): string {
    return String((record as SentryIssue).id ?? '');
  }

  extractVersion(record: unknown): string | undefined {
    return (record as SentryIssue).lastSeen;
  }
}
