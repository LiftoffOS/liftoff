// Linear Connector Normalizer
// Per Section 12: Connector ingestion

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';

interface LinearWebhookPayload {
  action: 'create' | 'update' | 'remove';
  type: string;
  data: {
    id: string;
    createdAt: string;
    updatedAt: string;
    archivedAt?: string;
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
    body?: string;
    issue?: { id: string; identifier: string };
    user?: { id: string; name: string; email: string };
    targetDate?: string;
    startDate?: string;
    lead?: { id: string; name: string };
    startsAt?: string;
    endsAt?: string;
  };
  url?: string;
  organizationId?: string;
}

const LinearBase = {
  id: z.string().describe('Linear entity id.'),
  action: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().optional(),
  organizationId: z.string().optional(),
  url: z.string().optional(),
};

const IssueDataSchema = z.object({
  ...LinearBase,
  number: z.number().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  priority: z.number().optional(),
  priorityLabel: z.string().optional(),
  state: z.string().optional(),
  stateType: z.string().optional(),
  stateId: z.string().optional(),
  assigneeId: z.string().optional(),
  assigneeName: z.string().optional(),
  assigneeEmail: z.string().optional(),
  creatorId: z.string().optional(),
  creatorName: z.string().optional(),
  teamId: z.string().optional(),
  teamKey: z.string().optional(),
  teamName: z.string().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  cycleId: z.string().optional(),
  cycleName: z.string().optional(),
  cycleNumber: z.number().optional(),
  labels: z.array(z.string()).optional(),
  estimate: z.number().optional(),
  dueDate: z.string().optional().describe('Issue due date — anchor for "alert N days before due" patterns.'),
  completedAt: z.string().optional(),
  canceledAt: z.string().optional(),
});

const CommentDataSchema = z.object({
  ...LinearBase,
  body: z.string().optional(),
  issueId: z.string().optional(),
  issueIdentifier: z.string().optional(),
  authorId: z.string().optional(),
  authorName: z.string().optional(),
  authorEmail: z.string().optional(),
});

const ProjectDataSchema = z.object({
  ...LinearBase,
  name: z.string().optional(),
  description: z.string().optional(),
  state: z.string().optional(),
  targetDate: z.string().optional().describe('Project target completion date — anchor for "alert N days before target" patterns.'),
  startDate: z.string().optional(),
  leadId: z.string().optional(),
  leadName: z.string().optional(),
});

const CycleDataSchema = z.object({
  ...LinearBase,
  name: z.string().optional(),
  number: z.number().optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional().describe('Cycle end timestamp — anchor for "alert N days before cycle end" patterns.'),
  teamId: z.string().optional(),
  teamName: z.string().optional(),
});

const GenericDataSchema = z.object({ ...LinearBase });

const ENTITY_SCHEMA_MAP: Record<string, z.ZodTypeAny> = {
  Issue: IssueDataSchema,
  Comment: CommentDataSchema,
  Project: ProjectDataSchema,
  Cycle: CycleDataSchema,
  Label: GenericDataSchema,
  User: GenericDataSchema,
  Team: GenericDataSchema,
};

export class LinearNormalizer implements ConnectorNormalizer {
  connectorType = 'linear';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    Issue: IssueDataSchema,
    Comment: CommentDataSchema,
    Project: ProjectDataSchema,
    Cycle: CycleDataSchema,
    Label: GenericDataSchema,
    User: GenericDataSchema,
    Team: GenericDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const linearPayload = payload as LinearWebhookPayload;
    const records: NormalizedRecord[] = [];

    const entityType = this.mapType(linearPayload.type);
    const data = linearPayload.data;

    const declared: Record<string, unknown> = {
      id: data.id,
      action: linearPayload.action,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      archivedAt: data.archivedAt,
      organizationId: linearPayload.organizationId,
      url: linearPayload.url,
    };

    if (entityType === 'Issue') {
      declared.number = data.number;
      declared.title = data.title;
      declared.description = data.description;
      declared.priority = data.priority;
      declared.priorityLabel = data.priorityLabel;
      declared.state = data.state?.name;
      declared.stateType = data.state?.type;
      declared.stateId = data.state?.id;
      declared.assigneeId = data.assignee?.id;
      declared.assigneeName = data.assignee?.name;
      declared.assigneeEmail = data.assignee?.email;
      declared.creatorId = data.creator?.id;
      declared.creatorName = data.creator?.name;
      declared.teamId = data.team?.id;
      declared.teamKey = data.team?.key;
      declared.teamName = data.team?.name;
      declared.projectId = data.project?.id;
      declared.projectName = data.project?.name;
      declared.cycleId = data.cycle?.id;
      declared.cycleName = data.cycle?.name;
      declared.cycleNumber = data.cycle?.number;
      declared.labels = data.labels?.map((l) => l.name);
      declared.estimate = data.estimate;
      declared.dueDate = data.dueDate;
      declared.completedAt = data.completedAt;
      declared.canceledAt = data.canceledAt;
    }

    if (entityType === 'Comment') {
      declared.body = data.body;
      declared.issueId = data.issue?.id;
      declared.issueIdentifier = data.issue?.identifier;
      declared.authorId = data.user?.id;
      declared.authorName = data.user?.name;
      declared.authorEmail = data.user?.email;
    }

    if (entityType === 'Project') {
      declared.name = data.title;
      declared.description = data.description;
      declared.state = data.state?.name;
      declared.targetDate = data.targetDate;
      declared.startDate = data.startDate;
      declared.leadId = data.lead?.id;
      declared.leadName = data.lead?.name;
    }

    if (entityType === 'Cycle') {
      declared.name = data.title;
      declared.number = data.number;
      declared.startsAt = data.startsAt;
      declared.endsAt = data.endsAt;
      declared.teamId = data.team?.id;
      declared.teamName = data.team?.name;
    }

    const schema = ENTITY_SCHEMA_MAP[entityType] ?? GenericDataSchema;

    records.push({
      entityType,
      externalId: data.id,
      data: schema.parse(declared),
      metadata: {
        source: 'linear',
        syncedAt: new Date(),
        version: data.updatedAt,
      },
    });

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
