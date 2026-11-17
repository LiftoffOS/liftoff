// Microsoft To Do Connector Normalizer
// Per Section 12: Connector ingestion - normalizes Microsoft Graph API responses

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

const TaskListDataSchema = z.object({
  id: z.string().describe('Microsoft To-Do list id.'),
  displayName: z.string().optional(),
  isOwner: z.boolean().optional(),
  isShared: z.boolean().optional(),
  wellknownListName: z.string().optional(),
});

const TaskDataSchema = z.object({
  id: z.string().describe('Microsoft To-Do task id (composite listId:taskId).'),
  title: z.string().optional(),
  bodyContentType: z.string().optional(),
  bodyContent: z.string().optional(),
  status: z.string().optional(),
  importance: z.string().optional(),
  isCompleted: z.boolean(),
  isReminderOn: z.boolean().optional(),
  reminderDateTime: z.string().optional(),
  reminderTimeZone: z.string().optional(),
  dueDateTime: z.string().optional().describe('Task due date — anchor for "alert N days before due" patterns.'),
  dueTimeZone: z.string().optional(),
  completedDateTime: z.string().optional(),
  hasAttachments: z.boolean().optional(),
  categories: z.array(z.string()).optional(),
  linkedResourceCount: z.number(),
  listId: z.string().optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional(),
});

// To Do Task List structure
interface ToDoTaskList {
  id: string;
  displayName?: string;
  isOwner?: boolean;
  isShared?: boolean;
  wellknownListName?: 'none' | 'defaultList' | 'flaggedEmails' | 'unknownFutureValue';
}

// To Do Task structure
interface ToDoTask {
  id: string;
  title?: string;
  body?: {
    contentType?: string;
    content?: string;
  };
  status?: 'notStarted' | 'inProgress' | 'completed' | 'waitingOnOthers' | 'deferred';
  importance?: 'low' | 'normal' | 'high';
  isReminderOn?: boolean;
  reminderDateTime?: {
    dateTime?: string;
    timeZone?: string;
  };
  dueDateTime?: {
    dateTime?: string;
    timeZone?: string;
  };
  completedDateTime?: {
    dateTime?: string;
    timeZone?: string;
  };
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  hasAttachments?: boolean;
  categories?: string[];
  linkedResources?: Array<{
    id?: string;
    webUrl?: string;
    applicationName?: string;
    displayName?: string;
  }>;
  listId?: string;
}

// List response
interface ToDoListResponse {
  '@odata.context'?: string;
  '@odata.nextLink'?: string;
  value: (ToDoTaskList | ToDoTask)[];
}

type ToDoPayload = ToDoTaskList | ToDoTask | ToDoListResponse;

export class MicrosoftToDoNormalizer implements ConnectorNormalizer {
  connectorType = 'microsoft_todo';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    TaskList: TaskListDataSchema,
    Task: TaskDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const records: NormalizedRecord[] = [];

    // Polling path: the scheduler hands us { results: [row.data, ...] } where
    // each row is a raw To Do task (already stamped with its owning listId by
    // the client's list() fan-out). Normalize each as a Task.
    const wrapped = (payload as { results?: ToDoTask[] })?.results;
    if (Array.isArray(wrapped)) {
      for (const item of wrapped) {
        records.push(this.normalizeTask(item));
      }
      return records;
    }

    const todoPayload = payload as ToDoPayload;

    // Handle list response
    if (this.isListResponse(todoPayload)) {
      for (const item of todoPayload.value) {
        records.push(this.normalizeItem(item));
      }
      return records;
    }

    // Handle single item
    if (this.isTaskList(todoPayload) || this.isTask(todoPayload)) {
      records.push(this.normalizeItem(todoPayload));
      return records;
    }

    return records;
  }

  private normalizeItem(item: ToDoTaskList | ToDoTask): NormalizedRecord {
    if (this.isTaskList(item)) {
      return this.normalizeTaskList(item);
    }
    return this.normalizeTask(item as ToDoTask);
  }

  private normalizeTaskList(list: ToDoTaskList): NormalizedRecord {
    return {
      entityType: 'TaskList',
      externalId: list.id,
      data: TaskListDataSchema.parse({
        id: list.id,
        displayName: list.displayName,
        isOwner: list.isOwner,
        isShared: list.isShared,
        wellknownListName: list.wellknownListName,
      }),
      metadata: {
        source: 'microsoft_todo',
        syncedAt: new Date(),
        version: hashCanonicalJson(list),
      },
    };
  }

  private normalizeTask(task: ToDoTask): NormalizedRecord {
    const externalId = task.listId ? `${task.listId}:${task.id}` : task.id;

    return {
      entityType: 'Task',
      externalId,
      data: TaskDataSchema.parse({
        id: externalId,
        title: task.title,
        bodyContentType: task.body?.contentType,
        bodyContent: task.body?.content,
        status: task.status,
        importance: task.importance,
        isCompleted: task.status === 'completed',
        isReminderOn: task.isReminderOn,
        reminderDateTime: task.reminderDateTime?.dateTime,
        reminderTimeZone: task.reminderDateTime?.timeZone,
        dueDateTime: task.dueDateTime?.dateTime,
        dueTimeZone: task.dueDateTime?.timeZone,
        completedDateTime: task.completedDateTime?.dateTime,
        hasAttachments: task.hasAttachments,
        categories: task.categories,
        linkedResourceCount: task.linkedResources?.length || 0,
        listId: task.listId,
        createdAt: task.createdDateTime,
        modifiedAt: task.lastModifiedDateTime,
      }),
      metadata: {
        source: 'microsoft_todo',
        syncedAt: new Date(),
        version: task.lastModifiedDateTime ?? hashCanonicalJson(task),
      },
    };
  }

  extractEntityType(record: unknown): string {
    const r = record as ToDoPayload;
    if (this.isListResponse(r)) return 'ItemList';
    if (this.isTaskList(r)) return 'TaskList';
    if (this.isTask(r)) return 'Task';
    return 'Unknown';
  }

  extractExternalId(record: unknown): string {
    const r = record as ToDoPayload;
    if (this.isTaskList(r) || this.isTask(r)) return r.id;
    return '';
  }

  extractVersion(_record: unknown): string | undefined {
    return undefined;
  }

  private isListResponse(payload: ToDoPayload): payload is ToDoListResponse {
    return 'value' in payload && Array.isArray(payload.value);
  }

  private isTaskList(payload: ToDoPayload): payload is ToDoTaskList {
    return 'id' in payload && 'displayName' in payload && !('title' in payload);
  }

  private isTask(payload: ToDoPayload): payload is ToDoTask {
    return 'id' in payload && ('title' in payload || 'status' in payload);
  }
}
