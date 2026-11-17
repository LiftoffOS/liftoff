// Microsoft To Do Connector Normalizer
// Per Section 12: Connector ingestion - normalizes Microsoft Graph API responses

import { ConnectorNormalizer, NormalizedRecord } from './types';
import { hashCanonicalJson } from './idempotency';

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

  normalize(payload: unknown): NormalizedRecord[] {
    const records: NormalizedRecord[] = [];
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
      data: {
        displayName: list.displayName,
        isOwner: list.isOwner,
        isShared: list.isShared,
        wellknownListName: list.wellknownListName,
      },
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
      data: {
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
      },
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
