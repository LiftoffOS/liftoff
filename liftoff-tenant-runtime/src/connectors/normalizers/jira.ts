// Jira Connector Normalizer
// Per Section 12: Connector ingestion

import { ConnectorNormalizer, NormalizedRecord } from './types';

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

export class JiraNormalizer implements ConnectorNormalizer {
  connectorType = 'jira';

  normalize(payload: unknown): NormalizedRecord[] {
    const jiraPayload = payload as JiraWebhookPayload;
    const records: NormalizedRecord[] = [];

    if (!jiraPayload.issue) {
      return records;
    }

    const issue = jiraPayload.issue;
    const fields = issue.fields;

    const record: NormalizedRecord = {
      entityType: 'Issue',
      externalId: issue.id,
      data: {
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
      },
      metadata: {
        source: 'jira',
        syncedAt: new Date(),
        version: fields.updated,
      },
    };

    // Include changelog if present
    if (jiraPayload.changelog) {
      record.data.changes = jiraPayload.changelog.items.map((item) => ({
        field: item.field,
        from: item.fromString,
        to: item.toString,
      }));
    }

    records.push(record);

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
