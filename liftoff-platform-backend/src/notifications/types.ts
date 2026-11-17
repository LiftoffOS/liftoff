export type NotificationType = 'task_update' | 'agent_activity' | 'escalation';
export type NotificationCadence = 'realtime' | 'daily' | 'weekly' | 'none';
// 'none' is a UI choice that suppresses task_update + agent_activity emails entirely.
// Rows with cadence='none' are never inserted (enqueueNotification short-circuits) — the DB
// CHECK constraint omits 'none' so a stray insert fails loudly. Escalations + perf recap
// have their own type toggles and ignore cadence.

export interface NotificationRow {
  id: string;
  accountId: string;
  tenantId: string | null;
  type: NotificationType;
  payload: Record<string, unknown>;
  cadence: NotificationCadence;
  createdAt: Date;
  deliveredAt: Date | null;
  deliveryError: string | null;
}

export interface EnqueueNotificationInput {
  accountId: string;
  tenantId: string | null;
  type: NotificationType;
  payload: {
    actorName?: string;     // human actor (agent_activity)
    internalAgentName?: string;  // Internal agent's user-given name — REQUIRED for task_update + escalation. Rendered to recipients as the agent name (UX convention).
    eventTitle?: string;
    eventSummary?: string;
    eventLink?: string;
    [k: string]: unknown;
  };
}

// preferences.notificationTypes key for each type
export const TYPE_TO_PREF_KEY: Record<NotificationType, 'taskUpdates' | 'teamActivity' | 'escalations'> = {
  task_update: 'taskUpdates',
  agent_activity: 'teamActivity',
  escalation: 'escalations',
};
