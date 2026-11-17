// Jira Connector Normalizer
// Per Section 12: Connector ingestion

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';

interface JiraWebhookPayload {
  webhookEvent?: string;
  issue?: {
    id: string;
    key: string;
    self: string;
    fields: {
      summary: string;
      description?: string;
      status: { name: string; id: string };
      priority?: { name: string; id: string };
      issuetype: { name: string; id: string };
      project: { key: string; name: string; id: string };
      assignee?: { accountId: string; displayName: string; emailAddress: string };
      reporter?: { accountId: string; displayName: string; emailAddress: string };
      created: string;
      updated: string;
      duedate?: string;
      labels?: string[];
      components?: Array<{ id: string; name: string }>;
      fixVersions?: Array<{ id: string; name: string }>;
      customfield_10001?: unknown; // Sprint
      customfield_10002?: number; // Story points
    };
  };
  changelog?: {
    id: string;
    items: Array<{
      field: string;
      fieldtype: string;
      from: string | null;
      fromString: string | null;
      to: string | null;
      toString: string | null;
    }>;
  };
  user?: {
    accountId: string;
    displayName: string;
  };
  timestamp?: number;
}

const IssueDataSchema = z.object({
  id: z.string().describe('Jira issue id.'),
  key: z.string().describe('Human-readable Jira key (e.g. ENG-123).'),
  summary: z.string(),
  description: z.string().optional(),
  status: z.string(),
  statusId: z.string(),
  priority: z.string().optional(),
  priorityId: z.string().optional(),
  issueType: z.string(),
  issueTypeId: z.string(),
  projectKey: z.string(),
  projectName: z.string(),
  projectId: z.string(),
  assigneeId: z.string().optional(),
  assigneeName: z.string().optional(),
  assigneeEmail: z.string().optional(),
  reporterId: z.string().optional(),
  reporterName: z.string().optional(),
  reporterEmail: z.string().optional(),
  created: z.string(),
  updated: z.string(),
  dueDate: z.string().optional().describe('Issue due date — anchor for "alert N days before due" patterns.'),
  labels: z.array(z.string()),
  components: z.array(z.string()),
  fixVersions: z.array(z.string()),
  storyPoints: z.number().optional(),
  webhookEvent: z.string().optional(),
  changedBy: z.string().optional(),
  changedById: z.string().optional(),
  changes: z.array(z.object({
    field: z.string(),
    from: z.string().nullable(),
    to: z.string().nullable(),
  })).optional(),
});

export class JiraNormalizer implements ConnectorNormalizer {
  connectorType = 'jira';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    Issue: IssueDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const jiraPayload = payload as JiraWebhookPayload;
    const records: NormalizedRecord[] = [];

    if (!jiraPayload.issue) {
      return records;
    }

    const issue = jiraPayload.issue;
    const fields = issue.fields;

    const declared: Record<string, unknown> = {
      id: issue.id,
      key: issue.key,
      summary: fields.summary,
      description: fields.description,
      status: fields.status.name,
      statusId: fields.status.id,
      priority: fields.priority?.name,
      priorityId: fields.priority?.id,
      issueType: fields.issuetype.name,
      issueTypeId: fields.issuetype.id,
      projectKey: fields.project.key,
      projectName: fields.project.name,
      projectId: fields.project.id,
      assigneeId: fields.assignee?.accountId,
      assigneeName: fields.assignee?.displayName,
      assigneeEmail: fields.assignee?.emailAddress,
      reporterId: fields.reporter?.accountId,
      reporterName: fields.reporter?.displayName,
      reporterEmail: fields.reporter?.emailAddress,
      created: fields.created,
      updated: fields.updated,
      dueDate: fields.duedate,
      labels: fields.labels || [],
      components: fields.components?.map((c) => c.name) || [],
      fixVersions: fields.fixVersions?.map((v) => v.name) || [],
      storyPoints: fields.customfield_10002,
      webhookEvent: jiraPayload.webhookEvent,
      changedBy: jiraPayload.user?.displayName,
      changedById: jiraPayload.user?.accountId,
    };

    if (jiraPayload.changelog) {
      declared.changes = jiraPayload.changelog.items.map((item) => ({
        field: item.field,
        from: item.fromString,
        to: item.toString,
      }));
    }

    records.push({
      entityType: 'Issue',
      externalId: issue.id,
      data: IssueDataSchema.parse(declared),
      metadata: {
        source: 'jira',
        syncedAt: new Date(),
        version: fields.updated,
      },
    });

    return records;
  }

  extractEntityType(record: unknown): string {
    const r = record as { issue?: { fields?: { issuetype?: { name?: string } } } };
    return r.issue?.fields?.issuetype?.name || 'Issue';
  }

  extractExternalId(record: unknown): string {
    const r = record as { issue?: { id?: string } };
    return r.issue?.id || '';
  }

  extractVersion(record: unknown): string | undefined {
    const r = record as { issue?: { fields?: { updated?: string } } };
    return r.issue?.fields?.updated;
  }
}
