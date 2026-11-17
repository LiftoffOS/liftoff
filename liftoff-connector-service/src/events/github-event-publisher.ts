// GitHub App webhook → agent trigger.
//
// The App receives `pull_request` and `issues` deliveries and until now dropped
// them. This turns each into the event the tenant runtime already routes, over
// the hop described in `connector-webhook-event.ts` — read that header before
// changing where this publishes.
//
// TOPIC SELECTION IS THE RUNTIME'S JOB, NOT THIS FILE'S.
// `Liftoff-Tenant-Runtime/src/scheduling/event-trigger.ts` resolves
// (source, entityType) to every topic the catalog lists for that entity — for
// GitHub's PullRequest row, all six of pr.opened / pr.updated /
// pr.ready_for_review / pr.reopened / pr.merged / code.pushed — and narrows
// with `githubEventMatches`, which reads GitHub's NATIVE webhook fields off
// `payload.data`. So the publisher's job is to hand over the vendor body
// unreshaped. Do not normalise it: `normalizeSearchPullRequest` emits none of
// those fields, and an agent fed that shape matches nothing while every hop
// reports success.
//
// WHY THE ACTION ALLOW-LISTS ARE HERE AND NOT ONLY IN THE RUNTIME.
// The runtime drops `labeled` / `edited` / `review_requested` anyway
// (`DEFAULT_GITHUB_ALLOWED_ACTIONS`), so forwarding them changes no agent's
// behaviour and only ships more externally-authored text across a service
// boundary into agent context. Volume has a real data-handling cost.

import { findTenantsHoldingInstallation } from '../oauth/github-app-pending.js';
import { logger } from '../infra/logging.js';
import { stripPermissionKeys } from './permission-keys.js';
import { publishConnectorWebhookEvent } from './connector-webhook-event.js';

/**
 * GitHub event name → the shared entity vocabulary the catalog and the runtime
 * both speak. Only the entities this service actually forwards appear here;
 * anything else returns null and is not published, which is what keeps the
 * `nativeEventDelivery` flag on the catalog rows honest.
 */
function entityTypeFor(githubEvent: string): 'PullRequest' | 'Issue' | null {
  if (githubEvent === 'pull_request') return 'PullRequest';
  if (githubEvent === 'issues') return 'Issue';
  return null;
}

/**
 * `closed` is in the list only because it is how a merge arrives: GitHub has no
 * `merged` action, it sends `closed` with `pull_request.merged === true`, and
 * the runtime's pr.merged gate (`requireMerged`) checks exactly that pair. A
 * closed-but-unmerged pull request reaches the runtime and is dropped there.
 */
const FORWARDED_PULL_REQUEST_ACTIONS = new Set([
  'opened',
  'synchronize',
  'ready_for_review',
  'reopened',
  'closed',
]);

/** Matches the runtime's ACTIONABLE_ISSUE_ACTIONS — new work, not edits. */
const FORWARDED_ISSUE_ACTIONS = new Set(['opened', 'reopened', 'assigned']);

function isForwardedAction(entityType: 'PullRequest' | 'Issue', action: string | undefined): boolean {
  if (!action) return false;
  return entityType === 'PullRequest'
    ? FORWARDED_PULL_REQUEST_ACTIONS.has(action)
    : FORWARDED_ISSUE_ACTIONS.has(action);
}

/**
 * GitHub's own numeric id for the entity — stable across every redelivery and
 * every subsequent event about the same pull request, which the delivery id is
 * not. Read from the ORIGINAL body: these are GitHub's ids, never
 * permission keys, so stripping cannot affect them.
 */
function entityIdFor(
  entityType: 'PullRequest' | 'Issue',
  body: Record<string, unknown>,
  deliveryId: string,
): string {
  const node = entityType === 'PullRequest'
    ? (body.pull_request as { id?: number | string } | undefined)
    : (body.issue as { id?: number | string } | undefined);
  return node?.id !== undefined ? String(node.id) : deliveryId;
}

export interface PublishGithubWebhookEventInput {
  /** Installation id off the delivery — the only tenant handle a webhook carries. */
  installationId: number;
  /** `X-GitHub-Event`. */
  githubEvent: string;
  /** `X-GitHub-Delivery` — becomes the runtime's dedupe key. */
  deliveryId: string;
  /** Parsed delivery body. */
  body: Record<string, unknown>;
}

/**
 * Publish a GitHub webhook delivery to every tenant holding the installation.
 *
 * Returns the number of tenants published to — 0 is a normal outcome for an
 * event we do not forward, and callers log the distinction rather than treating
 * a quiet return as success.
 *
 * Fans out because one installation can legitimately be held by more than one
 * tenant (a contractor in two workspaces, an agency, a shared org), and
 * `findTenantsHoldingInstallation` is the same exact-match lookup the
 * installation lifecycle handlers use.
 */
export async function publishGithubWebhookEvent(
  input: PublishGithubWebhookEventInput,
): Promise<number> {
  const { installationId, githubEvent, deliveryId, body } = input;

  const entityType = entityTypeFor(githubEvent);
  if (!entityType) return 0;

  const action = typeof body.action === 'string' ? body.action : undefined;
  if (!isForwardedAction(entityType, action)) {
    logger.debug(
      { installation_id: installationId, github_event: githubEvent, action, delivery_id: deliveryId },
      'github_webhook_event_not_forwarded',
    );
    return 0;
  }

  const holders = await findTenantsHoldingInstallation(installationId);
  if (holders.length === 0) {
    // Not an error: the installation exists on GitHub's side but no connector
    // row here holds it — an uninstall race, or a repository added to an
    // installation this workspace never bound. Named so it is distinguishable
    // from a publish that failed.
    logger.info(
      { installation_id: installationId, github_event: githubEvent, action, delivery_id: deliveryId },
      'github_webhook_event_no_holding_connector',
    );
    return 0;
  }

  // The signature proved GitHub delivered this. It did not prove who wrote the
  // pull-request body inside it.
  const stripped = stripPermissionKeys(body);
  if (stripped.changed) {
    logger.warn(
      { installation_id: installationId, github_event: githubEvent, delivery_id: deliveryId },
      'github_webhook_stripped_self_declared_permission_keys',
    );
  }

  const entityId = entityIdFor(entityType, body, deliveryId);
  let published = 0;

  for (const holder of holders) {
    try {
      await publishConnectorWebhookEvent({
        source: 'github',
        subtype: githubEvent,
        entityType,
        entityId,
        tenantId: holder.tenantId,
        connectorId: holder.connectorId,
        // Scoped per tenant: two tenants holding one installation each get their
        // own dedupe row, so one tenant's delivery cannot suppress the other's.
        eventId: `${deliveryId}:${holder.tenantId}`,
        data: stripped.value,
      });
      published += 1;
    } catch (err) {
      // One tenant's publish failing must not cost the others theirs.
      logger.error(
        {
          err: (err as Error).message,
          installation_id: installationId,
          tenant_id: holder.tenantId,
          connector_id: holder.connectorId,
          github_event: githubEvent,
          delivery_id: deliveryId,
        },
        'github_webhook_event_publish_failed',
      );
    }
  }

  return published;
}
