// Opaque notification links.
//
// A notification's URL carries only a link id. Resolving it server-side is what
// keeps internal agent and thread ids out of the address bar, browser history,
// referrer headers, and the body of every email we send.

import { api } from './api'

/** Which chat the thread id belongs to. The four surfaces are separate stacks
 *  with separate tables, so a thread id alone does not say where to go. */
export type NotificationSurface = 'agent' | 'liftoff' | 'insights' | 'team_plan'

/**
 * What a notification link id resolves to.
 *
 * A discriminated union rather than one shape with nullable fields, matching
 * ChatShareResolution: a chat link always has a thread, an agent chat link also
 * has the agent that owns it, and a review link has neither.
 */
export type NotificationLinkResolution =
  | {
      tenantId: string
      destination: 'chat'
      surface: 'agent'
      agentId: string
      threadId: string
      recordId: string | null
    }
  | {
      tenantId: string
      destination: 'chat'
      surface: 'liftoff' | 'insights' | 'team_plan'
      threadId: string
      recordId: string | null
    }
  | {
      tenantId: string
      destination: 'review'
      recordId: string | null
    }

export async function resolveNotificationLink(
  notificationId: string,
): Promise<NotificationLinkResolution> {
  return await api.get<NotificationLinkResolution>(
    `/api/notification-links/${encodeURIComponent(notificationId)}`,
  )
}
