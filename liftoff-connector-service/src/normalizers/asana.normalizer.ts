// Asana Connector Normalizer
//
// Asana is reactive via native polling (static_oauth REST client; no Composio,
// no native webhook wired). The polling scheduler hands AsanaClient.list('Task')
// results to normalize() as { results: [task] }. Field set is the documented
// Asana REST API Task shape, restricted to the fields a reactive subscription
// would predicate on (completed, due_on, assignee, projects) plus identity +
// the modified_at timestamp (also the version anchor for incremental sync).

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

interface AsanaUserRef {
  gid?: string;
  name?: string;
}

interface AsanaProjectRef {
  gid?: string;
  name?: string;
}

interface AsanaTask {
  gid?: string;
  name?: string;
  completed?: boolean;
  due_on?: string | null;
  modified_at?: string;
  assignee?: AsanaUserRef | null;
  projects?: AsanaProjectRef[];
}

interface AsanaPayload {
  results?: AsanaTask[];
}

const AssigneeSchema = z.object({
  gid: z.string().optional().describe('Asana user gid of the assignee.'),
  name: z.string().optional().describe('Display name of the assignee.'),
});

const ProjectRefSchema = z.object({
  gid: z.string().optional().describe('Asana project gid.'),
  name: z.string().optional().describe('Project name.'),
});

const TaskDataSchema = z.object({
  id: z.string().describe('Asana task gid.'),
  name: z.string().optional().describe('Task name / title.'),
  completed: z.boolean().optional().describe('Whether the task is marked complete.'),
  dueOn: z.string().optional().describe('Due date (YYYY-MM-DD), if set.'),
  modifiedAt: z.string().optional().describe('Last-modified ISO timestamp — anchor for incremental sync and "alert N hours after change" patterns.'),
  assignee: AssigneeSchema.optional().describe('User the task is assigned to.'),
  projects: z.array(ProjectRefSchema).optional().describe('Projects the task belongs to.'),
});

export class AsanaNormalizer implements ConnectorNormalizer {
  connectorType = 'asana';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    Task: TaskDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const tasks = (payload as AsanaPayload)?.results ?? [];
    const records: NormalizedRecord[] = [];

    for (const task of tasks) {
      if (task?.gid === undefined || task.gid === null) continue;
      const id = String(task.gid);
      const declared: Record<string, unknown> = {
        id,
        name: task.name,
        completed: task.completed,
        dueOn: task.due_on ?? undefined,
        modifiedAt: task.modified_at,
        assignee: task.assignee
          ? { gid: task.assignee.gid, name: task.assignee.name }
          : undefined,
        projects: Array.isArray(task.projects)
          ? task.projects.map((p) => ({ gid: p.gid, name: p.name }))
          : undefined,
      };
      records.push({
        entityType: 'Task',
        externalId: id,
        data: declared,
        metadata: {
          source: 'asana',
          syncedAt: new Date(),
          version: task.modified_at ?? hashCanonicalJson(task),
        },
      });
    }

    return records;
  }

  extractEntityType(_record: unknown): string {
    return 'Task';
  }

  extractExternalId(record: unknown): string {
    return String((record as AsanaTask).gid ?? '');
  }

  extractVersion(record: unknown): string | undefined {
    return (record as AsanaTask).modified_at;
  }
}
