// Google Tasks Connector Normalizer
// Per Section 12: Connector ingestion - normalizes Google Tasks API responses

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';

const TaskLinkSchema = z.object({
  type: z.string().optional(),
  description: z.string().optional(),
  url: z.string().optional(),
});

const TaskDataSchema = z.object({
  id: z.string().describe('Google Tasks task id.'),
  title: z.string().optional(),
  notes: z.string().optional(),
  status: z.string().optional(),
  isCompleted: z.boolean(),
  parentTaskId: z.string().optional(),
  position: z.string().optional(),
  hasSubtasks: z.boolean(),
  dueDate: z.string().optional().describe('Task due date — anchor for "alert N days before due" patterns.'),
  completedDate: z.string().optional(),
  updatedAt: z.string().optional(),
  isOverdue: z.boolean(),
  isDueToday: z.boolean(),
  isDueSoon: z.boolean(),
  hasLinks: z.boolean(),
  links: z.array(TaskLinkSchema).optional(),
  hidden: z.boolean().optional(),
  deleted: z.boolean().optional(),
  selfLink: z.string().optional(),
});

const TaskListDataSchema = z.object({
  id: z.string().describe('Google Tasks task-list id.'),
  title: z.string(),
  updatedAt: z.string(),
  selfLink: z.string().optional(),
});

// Google Tasks API Task structure
interface GoogleTask {
  kind: string;
  id: string;
  etag: string;
  title: string;
  updated: string;
  selfLink?: string;
  parent?: string;
  position?: string;
  notes?: string;
  status?: 'needsAction' | 'completed';
  due?: string;
  completed?: string;
  deleted?: boolean;
  hidden?: boolean;
  links?: Array<{
    type?: string;
    description?: string;
    link?: string;
  }>;
}

// Google Tasks API TaskList structure
interface GoogleTaskList {
  kind: string;
  id: string;
  etag: string;
  title: string;
  updated: string;
  selfLink?: string;
}

// Google Tasks API List responses
interface GoogleTasksListResponse {
  kind: string;
  etag: string;
  nextPageToken?: string;
  items?: GoogleTask[];
}

interface GoogleTaskListsListResponse {
  kind: string;
  etag: string;
  nextPageToken?: string;
  items?: GoogleTaskList[];
}

type GoogleTasksPayload =
  | GoogleTask
  | GoogleTaskList
  | GoogleTasksListResponse
  | GoogleTaskListsListResponse;

export class GoogleTasksNormalizer implements ConnectorNormalizer {
  connectorType = 'google_tasks';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    Task: TaskDataSchema,
    TaskList: TaskListDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const records: NormalizedRecord[] = [];
    const tasksPayload = payload as GoogleTasksPayload;

    // Handle tasks list response
    if (this.isTasksListResponse(tasksPayload)) {
      for (const task of tasksPayload.items || []) {
        if (!task.deleted) {
          records.push(this.normalizeTask(task));
        }
      }
      return records;
    }

    // Handle task lists list response
    if (this.isTaskListsListResponse(tasksPayload)) {
      for (const taskList of tasksPayload.items || []) {
        records.push(this.normalizeTaskList(taskList));
      }
      return records;
    }

    // Handle single task list
    if (this.isTaskList(tasksPayload)) {
      records.push(this.normalizeTaskList(tasksPayload));
      return records;
    }

    // Handle single task
    if (this.isTask(tasksPayload)) {
      const task = tasksPayload as GoogleTask;
      if (!task.deleted) {
        records.push(this.normalizeTask(task));
      }
      return records;
    }

    return records;
  }

  private normalizeTask(task: GoogleTask): NormalizedRecord {
    return {
      entityType: 'Task',
      externalId: task.id,
      data: TaskDataSchema.parse({
        id: task.id,
        // Core task data
        title: task.title,
        notes: task.notes,
        status: task.status,
        isCompleted: task.status === 'completed',

        // Hierarchy
        parentTaskId: task.parent,
        position: task.position,
        hasSubtasks: false, // Will be updated when processing children

        // Dates
        dueDate: task.due ? this.parseRfc3339Date(task.due) : undefined,
        completedDate: task.completed ? this.parseRfc3339Date(task.completed) : undefined,
        updatedAt: task.updated,

        // Derived status
        isOverdue: this.isOverdue(task),
        isDueToday: this.isDueToday(task),
        isDueSoon: this.isDueSoon(task),

        // Links/attachments
        hasLinks: !!task.links?.length,
        links: task.links?.map((l) => ({
          type: l.type,
          description: l.description,
          url: l.link,
        })),

        // State
        hidden: task.hidden,
        deleted: task.deleted,

        // Reference
        selfLink: task.selfLink,
      }),
      metadata: {
        source: 'google_tasks',
        syncedAt: new Date(),
        version: task.updated,
        etag: task.etag,
      },
    };
  }

  private normalizeTaskList(taskList: GoogleTaskList): NormalizedRecord {
    return {
      entityType: 'TaskList',
      externalId: taskList.id,
      data: TaskListDataSchema.parse({
        id: taskList.id,
        title: taskList.title,
        updatedAt: taskList.updated,
        selfLink: taskList.selfLink,
      }),
      metadata: {
        source: 'google_tasks',
        syncedAt: new Date(),
        version: taskList.updated,
        etag: taskList.etag,
      },
    };
  }

  private parseRfc3339Date(dateString: string): string {
    // Google Tasks uses RFC 3339 format
    // Returns ISO string for consistency
    try {
      const date = new Date(dateString);
      return date.toISOString();
    } catch {
      return dateString;
    }
  }

  private isOverdue(task: GoogleTask): boolean {
    if (!task.due || task.status === 'completed') return false;
    const dueDate = new Date(task.due);
    const now = new Date();
    // Compare dates only (ignore time)
    dueDate.setHours(0, 0, 0, 0);
    now.setHours(0, 0, 0, 0);
    return dueDate < now;
  }

  private isDueToday(task: GoogleTask): boolean {
    if (!task.due || task.status === 'completed') return false;
    const dueDate = new Date(task.due);
    const now = new Date();
    return (
      dueDate.getFullYear() === now.getFullYear() &&
      dueDate.getMonth() === now.getMonth() &&
      dueDate.getDate() === now.getDate()
    );
  }

  private isDueSoon(task: GoogleTask): boolean {
    if (!task.due || task.status === 'completed') return false;
    const dueDate = new Date(task.due);
    const now = new Date();
    const threeDaysFromNow = new Date(now);
    threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);

    dueDate.setHours(0, 0, 0, 0);
    now.setHours(0, 0, 0, 0);
    threeDaysFromNow.setHours(0, 0, 0, 0);

    return dueDate >= now && dueDate <= threeDaysFromNow;
  }

  extractEntityType(record: unknown): string {
    const r = record as GoogleTasksPayload;
    if (this.isTasksListResponse(r)) return 'TaskList';
    if (this.isTaskListsListResponse(r)) return 'TaskListList';
    if (this.isTaskList(r)) return 'TaskList';
    if (this.isTask(r)) return 'Task';
    return 'Unknown';
  }

  extractExternalId(record: unknown): string {
    const r = record as GoogleTasksPayload;
    if (this.isTasksListResponse(r)) {
      return (r as GoogleTasksListResponse).nextPageToken || (r as GoogleTasksListResponse).etag;
    }
    if (this.isTaskListsListResponse(r)) {
      return (r as GoogleTaskListsListResponse).nextPageToken || (r as GoogleTaskListsListResponse).etag;
    }
    if (this.isTaskList(r)) return (r as GoogleTaskList).id;
    if (this.isTask(r)) return (r as GoogleTask).id;
    return '';
  }

  extractVersion(record: unknown): string | undefined {
    const r = record as GoogleTasksPayload;
    if (this.isTask(r)) return r.updated;
    if (this.isTaskList(r)) return r.updated;
    if (this.isTasksListResponse(r)) return r.etag;
    if (this.isTaskListsListResponse(r)) return r.etag;
    return undefined;
  }

  private isTasksListResponse(payload: GoogleTasksPayload): payload is GoogleTasksListResponse {
    return (
      'kind' in payload &&
      payload.kind === 'tasks#tasks' &&
      'items' in payload
    );
  }

  private isTaskListsListResponse(
    payload: GoogleTasksPayload
  ): payload is GoogleTaskListsListResponse {
    return (
      'kind' in payload &&
      payload.kind === 'tasks#taskLists' &&
      'items' in payload
    );
  }

  private isTaskList(payload: GoogleTasksPayload): payload is GoogleTaskList {
    return (
      'kind' in payload &&
      payload.kind === 'tasks#taskList' &&
      'id' in payload &&
      'title' in payload &&
      !('status' in payload)
    );
  }

  private isTask(payload: GoogleTasksPayload): payload is GoogleTask {
    return (
      'kind' in payload &&
      payload.kind === 'tasks#task' &&
      'id' in payload &&
      'title' in payload
    );
  }
}
