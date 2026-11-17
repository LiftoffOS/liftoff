// Microsoft Planner Connector Normalizer
// Per Section 12: Connector ingestion - normalizes Microsoft Graph API responses

import { ConnectorNormalizer, NormalizedRecord } from './types';

// Planner Plan structure
interface PlannerPlan {
  '@odata.etag'?: string;
  id: string;
  title?: string;
  owner?: string;
  createdDateTime?: string;
  createdBy?: {
    user?: {
      id?: string;
      displayName?: string;
    };
  };
  container?: {
    containerId?: string;
    type?: string;
    url?: string;
  };
}

// Planner Bucket structure
interface PlannerBucket {
  '@odata.etag'?: string;
  id: string;
  name?: string;
  planId?: string;
  orderHint?: string;
}

// Planner Task structure
interface PlannerTask {
  '@odata.etag'?: string;
  id: string;
  planId?: string;
  bucketId?: string;
  title?: string;
  orderHint?: string;
  percentComplete?: number;
  startDateTime?: string;
  dueDateTime?: string;
  completedDateTime?: string;
  completedBy?: {
    user?: {
      id?: string;
      displayName?: string;
    };
  };
  hasDescription?: boolean;
  previewType?: string;
  referenceCount?: number;
  checklistItemCount?: number;
  activeChecklistItemCount?: number;
  conversationThreadId?: string;
  priority?: number;
  createdDateTime?: string;
  createdBy?: {
    user?: {
      id?: string;
      displayName?: string;
    };
  };
  assignments?: Record<string, {
    '@odata.type'?: string;
    assignedBy?: {
      user?: {
        id?: string;
        displayName?: string;
      };
    };
    assignedDateTime?: string;
    orderHint?: string;
  }>;
  appliedCategories?: Record<string, boolean>;
}

// List response
interface PlannerListResponse {
  '@odata.context'?: string;
  '@odata.nextLink'?: string;
  value: (PlannerPlan | PlannerBucket | PlannerTask)[];
}

type PlannerPayload = PlannerPlan | PlannerBucket | PlannerTask | PlannerListResponse;

export class MicrosoftPlannerNormalizer implements ConnectorNormalizer {
  connectorType = 'microsoft_planner';

  normalize(payload: unknown): NormalizedRecord[] {
    const records: NormalizedRecord[] = [];
    const plannerPayload = payload as PlannerPayload;

    // Handle list response
    if (this.isListResponse(plannerPayload)) {
      for (const item of plannerPayload.value) {
        records.push(this.normalizeItem(item));
      }
      return records;
    }

    // Handle single item
    if (this.isPlan(plannerPayload) || this.isBucket(plannerPayload) || this.isTask(plannerPayload)) {
      records.push(this.normalizeItem(plannerPayload));
      return records;
    }

    return records;
  }

  private normalizeItem(item: PlannerPlan | PlannerBucket | PlannerTask): NormalizedRecord {
    if (this.isPlan(item)) {
      return this.normalizePlan(item);
    }
    if (this.isBucket(item)) {
      return this.normalizeBucket(item);
    }
    return this.normalizeTask(item as PlannerTask);
  }

  private normalizePlan(plan: PlannerPlan): NormalizedRecord {
    return {
      entityType: 'Plan',
      externalId: plan.id,
      data: {
        title: plan.title,
        owner: plan.owner,
        createdBy: plan.createdBy?.user ? {
          id: plan.createdBy.user.id,
          displayName: plan.createdBy.user.displayName,
        } : undefined,
        container: plan.container ? {
          containerId: plan.container.containerId,
          type: plan.container.type,
          url: plan.container.url,
        } : undefined,
        createdAt: plan.createdDateTime,
      },
      metadata: {
        source: 'microsoft_planner',
        syncedAt: new Date(),
        version: plan['@odata.etag'],
      },
    };
  }

  private normalizeBucket(bucket: PlannerBucket): NormalizedRecord {
    return {
      entityType: 'Bucket',
      externalId: bucket.id,
      data: {
        name: bucket.name,
        planId: bucket.planId,
        orderHint: bucket.orderHint,
      },
      metadata: {
        source: 'microsoft_planner',
        syncedAt: new Date(),
        version: bucket['@odata.etag'],
      },
    };
  }

  private normalizeTask(task: PlannerTask): NormalizedRecord {
    const assignees = task.assignments
      ? Object.entries(task.assignments).map(([userId, assignment]) => ({
          userId,
          displayName: assignment.assignedBy?.user?.displayName,
          assignedDateTime: assignment.assignedDateTime,
        }))
      : [];

    const categories = task.appliedCategories
      ? Object.entries(task.appliedCategories)
          .filter(([, applied]) => applied)
          .map(([category]) => category)
      : [];

    return {
      entityType: 'Task',
      externalId: task.id,
      data: {
        title: task.title,
        planId: task.planId,
        bucketId: task.bucketId,
        percentComplete: task.percentComplete,
        isCompleted: task.percentComplete === 100,
        priority: task.priority,
        priorityLabel: this.getPriorityLabel(task.priority),
        hasDescription: task.hasDescription,
        previewType: task.previewType,
        referenceCount: task.referenceCount,
        checklistItemCount: task.checklistItemCount,
        activeChecklistItemCount: task.activeChecklistItemCount,
        assignees,
        assigneeCount: assignees.length,
        categories,
        createdBy: task.createdBy?.user ? {
          id: task.createdBy.user.id,
          displayName: task.createdBy.user.displayName,
        } : undefined,
        completedBy: task.completedBy?.user ? {
          id: task.completedBy.user.id,
          displayName: task.completedBy.user.displayName,
        } : undefined,
        startDateTime: task.startDateTime,
        dueDateTime: task.dueDateTime,
        completedDateTime: task.completedDateTime,
        createdAt: task.createdDateTime,
      },
      metadata: {
        source: 'microsoft_planner',
        syncedAt: new Date(),
        version: task['@odata.etag'],
      },
    };
  }

  private getPriorityLabel(priority?: number): string {
    switch (priority) {
      case 0:
      case 1:
        return 'Urgent';
      case 2:
      case 3:
      case 4:
        return 'Important';
      case 5:
      case 6:
      case 7:
        return 'Medium';
      case 8:
      case 9:
      case 10:
        return 'Low';
      default:
        return 'Medium';
    }
  }

  extractEntityType(record: unknown): string {
    const r = record as PlannerPayload;
    if (this.isListResponse(r)) return 'ItemList';
    if (this.isPlan(r)) return 'Plan';
    if (this.isBucket(r)) return 'Bucket';
    if (this.isTask(r)) return 'Task';
    return 'Unknown';
  }

  extractExternalId(record: unknown): string {
    const r = record as PlannerPayload;
    if (this.isPlan(r) || this.isBucket(r) || this.isTask(r)) return r.id;
    return '';
  }

  extractVersion(record: unknown): string | undefined {
    const r = record as PlannerPayload;
    if (this.isPlan(r) || this.isBucket(r) || this.isTask(r)) return r['@odata.etag'];
    return undefined;
  }

  private isListResponse(payload: PlannerPayload): payload is PlannerListResponse {
    return 'value' in payload && Array.isArray(payload.value);
  }

  private isPlan(payload: PlannerPayload): payload is PlannerPlan {
    return 'id' in payload && 'title' in payload && 'owner' in payload;
  }

  private isBucket(payload: PlannerPayload): payload is PlannerBucket {
    return 'id' in payload && 'name' in payload && 'planId' in payload && !('title' in payload);
  }

  private isTask(payload: PlannerPayload): payload is PlannerTask {
    return 'id' in payload && 'title' in payload && 'planId' in payload && 'bucketId' in payload;
  }
}
