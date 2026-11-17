// Linear Connector Normalizer
// Per Section 12: Connector ingestion

import { ConnectorNormalizer, NormalizedRecord } from './types';

interface LinearWebhookPayload {
  action: 'create' | 'update' | 'remove';
  type: string;
  data: {
    id: string;
    createdAt: string;
    updatedAt: string;
    archivedAt?: string;
    // Issue fields
    number?: number;
    title?: string;
    description?: string;
    priority?: number;
    priorityLabel?: string;
    state?: { id: string; name: string; type: string };
    assignee?: { id: string; name: string; email: string };
    creator?: { id: string; name: string; email: string };
    team?: { id: string; key: string; name: string };
    project?: { id: string; name: string };
    cycle?: { id: string; name: string; number: number };
    labels?: Array<{ id: string; name: string; color: string }>;
    estimate?: number;
    dueDate?: string;
    completedAt?: string;
    canceledAt?: string;
    // Comment fields
    body?: string;
    issue?: { id: string; identifier: string };
    user?: { id: string; name: string; email: string };
    // Project fields
    targetDate?: string;
    startDate?: string;
    lead?: { id: string; name: string };
    // Cycle fields
    startsAt?: string;
    endsAt?: string;
  };
  url?: string;
  organizationId?: string;
}

export class LinearNormalizer implements ConnectorNormalizer {
  connectorType = 'linear';

  normalize(payload: unknown): NormalizedRecord[] {
    const linearPayload = payload as LinearWebhookPayload;
    const records: NormalizedRecord[] = [];

    const entityType = this.mapType(linearPayload.type);
    const data = linearPayload.data;

    const record: NormalizedRecord = {
      entityType,
      externalId: data.id,
      data: {
        action: linearPayload.action,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        archivedAt: data.archivedAt,
        organizationId: linearPayload.organizationId,
        url: linearPayload.url,
      },
      metadata: {
        source: 'linear',
        syncedAt: new Date(),
        version: data.updatedAt,
      },
    };

    // Handle Issues
    if (entityType === 'Issue') {
      record.data.number = data.number;
      record.data.title = data.title;
      record.data.description = data.description;
      record.data.priority = data.priority;
      record.data.priorityLabel = data.priorityLabel;
      record.data.state = data.state?.name;
      record.data.stateType = data.state?.type;
      record.data.stateId = data.state?.id;
      record.data.assigneeId = data.assignee?.id;
      record.data.assigneeName = data.assignee?.name;
      record.data.assigneeEmail = data.assignee?.email;
      record.data.creatorId = data.creator?.id;
      record.data.creatorName = data.creator?.name;
      record.data.teamId = data.team?.id;
      record.data.teamKey = data.team?.key;
      record.data.teamName = data.team?.name;
      record.data.projectId = data.project?.id;
      record.data.projectName = data.project?.name;
      record.data.cycleId = data.cycle?.id;
      record.data.cycleName = data.cycle?.name;
      record.data.cycleNumber = data.cycle?.number;
      record.data.labels = data.labels?.map((l) => l.name);
      record.data.estimate = data.estimate;
      record.data.dueDate = data.dueDate;
      record.data.completedAt = data.completedAt;
      record.data.canceledAt = data.canceledAt;
    }

    // Handle Comments
    if (entityType === 'Comment') {
      record.data.body = data.body;
      record.data.issueId = data.issue?.id;
      record.data.issueIdentifier = data.issue?.identifier;
      record.data.authorId = data.user?.id;
      record.data.authorName = data.user?.name;
      record.data.authorEmail = data.user?.email;
    }

    // Handle Projects
    if (entityType === 'Project') {
      record.data.name = data.title;
      record.data.description = data.description;
      record.data.state = data.state?.name;
      record.data.targetDate = data.targetDate;
      record.data.startDate = data.startDate;
      record.data.leadId = data.lead?.id;
      record.data.leadName = data.lead?.name;
    }

    // Handle Cycles
    if (entityType === 'Cycle') {
      record.data.name = data.title;
      record.data.number = data.number;
      record.data.startsAt = data.startsAt;
      record.data.endsAt = data.endsAt;
      record.data.teamId = data.team?.id;
      record.data.teamName = data.team?.name;
    }

    records.push(record);

    return records;
  }

  extractEntityType(record: unknown): string {
    const r = record as LinearWebhookPayload;
    return this.mapType(r.type);
  }

  extractExternalId(record: unknown): string {
    const r = record as LinearWebhookPayload;
    return r.data?.id || '';
  }

  extractVersion(record: unknown): string | undefined {
    const r = record as LinearWebhookPayload;
    return r.data?.updatedAt;
  }

  private mapType(linearType: string): string {
    const mapping: Record<string, string> = {
      Issue: 'Issue',
      Comment: 'Comment',
      Project: 'Project',
      Cycle: 'Cycle',
      IssueLabel: 'Label',
      User: 'User',
      Team: 'Team',
    };
    return mapping[linearType] || linearType;
  }
}
