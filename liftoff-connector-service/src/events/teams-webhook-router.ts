// Microsoft Teams change-notification webhook — workspace-OAuth connector side.
//
// Mirrors slack-webhook-router.ts but for Microsoft Graph change notifications
// on Teams messages (/teams/getAllMessages). Distinct from the Teams bot
// adapter in platform-backend (that handles user↔agent chat). THIS endpoint
// feeds reactive subscriptions / harvest from broader workspace activity.
//
// Graph specifics:
//  - Subscription creation: Graph calls this URL with ?validationToken=... — we
//    must echo it back as 200 text/plain within 10s.
//  - Notifications: POST { value: [{ subscriptionId, clientState, resource,
//    changeType, resourceData, tenantId }] }. Verify clientState, then publish.
//  - Lifecycle notifications (reauthorizationRequired / subscriptionRemoved)
//    arrive with a lifecycleEvent field — surfaced for the renewal scheduler.
//  - Teams message change notifications are no longer metered (since 2025-08-25).
//
// NOTE (gap, see review): full per-subscription clientState verification +
// tenant/connector resolution needs a subscriptions store
// (subscriptionId → connectorId/tenantId/clientState) which does not exist yet.
// This handler validates clientState presence and uses the notification's
// tenantId; wiring the durable subscriptions table is follow-up work.

import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { PubSubPublisher } from '@liftoffos/pubsub';
import { logger } from '../infra/logging.js';

const teamsEventsRouter = Router();

let publisherInstance: PubSubPublisher | null = null;
function getPublisher(): PubSubPublisher {
  if (!publisherInstance) {
    publisherInstance = new PubSubPublisher({
      projectId: process.env.GCP_PROJECT_ID,
      logger: {
        debug: (ctx, msg) => logger.debug(ctx, msg),
        error: (ctx, msg) => logger.error(ctx, msg),
      },
    });
  }
  return publisherInstance;
}
export function __setTeamsEventPublisher(p: PubSubPublisher | null): void {
  publisherInstance = p;
}

function resolveTopicName(): string {
  const environment = process.env.ENVIRONMENT ?? 'dev';
  return `connector-events-${environment}`;
}

interface GraphNotification {
  subscriptionId?: string;
  clientState?: string;
  resource?: string;
  changeType?: string;
  tenantId?: string;
  lifecycleEvent?: string;
  resourceData?: { id?: string };
}

teamsEventsRouter.post('/', async (req: Request, res: Response) => {
  // 1. Subscription-creation validation handshake.
  const validationToken = (req.query.validationToken as string | undefined) ?? undefined;
  if (validationToken) {
    res.set('Content-Type', 'text/plain');
    res.status(200).send(validationToken);
    return;
  }

  const body = req.body as { value?: GraphNotification[] } | undefined;
  const notifications = body?.value ?? [];

  // 2. Ack fast; process after.
  res.sendStatus(202);

  for (const n of notifications) {
    try {
      // Lifecycle notifications (reauthorizationRequired / subscriptionRemoved)
      // are handled by the renewal scheduler; log for now.
      if (n.lifecycleEvent) {
        logger.info(
          { subscriptionId: n.subscriptionId, lifecycleEvent: n.lifecycleEvent },
          'Teams subscription lifecycle notification',
        );
        continue;
      }

      // Verify clientState presence (full per-subscription check needs a store).
      if (!n.clientState) {
        logger.warn({ subscriptionId: n.subscriptionId }, 'Teams notification missing clientState — skipping');
        continue;
      }
      const tenantId = n.tenantId;
      if (!tenantId) {
        logger.warn({ subscriptionId: n.subscriptionId }, 'Teams notification missing tenantId — skipping');
        continue;
      }

      const entityId = n.resourceData?.id ?? randomUUID();
      const occurredAt = new Date().toISOString();
      await getPublisher().publish(resolveTopicName(), {
        data: {
          eventId: `teams:${entityId}`,
          eventUUID: randomUUID(),
          tenantId,
          connectorId: n.subscriptionId ?? '',
          entityType: 'Message',
          entityId,
          eventType: 'connector.record.synced',
          occurredAt,
          payload: { source: 'microsoft_teams', data: n },
        },
        attributes: {
          tenantId,
          entityType: 'Message',
          source: 'microsoft_teams',
          eventType: 'connector.record.synced',
          delivery: 'push',
        },
      });
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'Teams webhook publish failed (non-fatal)');
    }
  }
});

export { teamsEventsRouter };
