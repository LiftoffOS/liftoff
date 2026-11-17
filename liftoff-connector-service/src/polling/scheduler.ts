// Polling Scheduler
// Runs a polling cycle every minute. For each active connector whose type is
// in CONNECTOR_ENTITY_TYPES, calls list() on the appropriate client and
// publishes normalized records to Pub/Sub for the tenant runtime.

import { logger } from '../infra/logging.js';
import { getPool } from '../db/pool.js';
import {
  getDueConnectors,
  getSyncState,
  upsertSyncState,
  recordPollAuthFailure,
  recordPollError,
  clearPollFailures,
  type DueConnector,
} from './sync-state-store.js';
import {
  classifyPollFailure,
  shouldFlipToError,
  worseFailure,
  type PollFailureKind,
} from './poll-failure-state.js';
import { publishPollingEvent } from './event-publisher.js';
import { getNormalizer } from '../normalizers/index.js';
import { hashCanonicalJson } from '../infra/idempotency.js';
import { credentialService, OAuthRefreshError } from '../credentials/service.js';
import { markConnectorReconnectRequired } from '../oauth/connector-ops.js';
import { PerConnectorIdCredentialStore } from '../mcp/credential-store.js';
import type { ListResult } from '../clients/types.js';
import type { NormalizedRecord } from '../normalizers/types.js';

// ── REST client imports ──────────────────────────────────────────────────────
import { GoogleCalendarClient } from '../clients/google-calendar.js';
import { MicrosoftOutlookCalendarClient } from '../clients/microsoft-outlook-calendar.js';
import { MicrosoftOutlookMailClient } from '../clients/microsoft-outlook-mail.js';
import { SalesforceComposioClient } from '../clients/salesforce-composio.js';
import { GoogleMailClient } from '../clients/google-mail.js';
import { GoogleDriveClient } from '../clients/google-drive.js';
import { JiraClient } from '../clients/jira.js';
import { LinearClient } from '../clients/linear.js';
import { GongClient } from '../clients/gong.js';
import { WooCommerceClient } from '../clients/woocommerce.js';
import { MicrosoftContactsClient } from '../clients/microsoft-contacts.js';
import { MicrosoftPlannerClient } from '../clients/microsoft-planner.js';
import { BambooHRClient } from '../clients/bamboohr.js';
import { AsanaClient } from '../clients/asana.js';
import { CalendlyClient } from '../clients/calendly.js';
import { SendGridClient } from '../clients/sendgrid.js';
import { MicrosoftToDoClient } from '../clients/microsoft-todo.js';
import { MicrosoftOneNoteClient } from '../clients/microsoft-onenote.js';
import { MicrosoftSharePointClient } from '../clients/microsoft-sharepoint.js';
import { MicrosoftTeamsClient } from '../clients/microsoft-teams.js';
import { PayPalClient } from '../clients/paypal.js';
import { SentryClient } from '../clients/sentry.js';

import { CONNECTORS } from '../catalog/connectors.js';

// ── MCP client imports ───────────────────────────────────────────────────────
import { HubSpotMCPClient } from '../clients/hubspot-mcp.js';
import { ZoomMCPClient } from '../clients/zoom-mcp.js';
import { GenericMCPClient } from '../clients/generic-mcp.js';
import { NotionMCPClient } from '../clients/notion-mcp.js';
import { AttioMCPClient } from '../clients/attio-mcp.js';
import { StripeMCPClient } from '../clients/stripe-mcp.js';
import { GitHubMCPClient } from '../clients/github-mcp.js';
import { GitLabClient } from '../clients/gitlab.js';
import { IntercomComposioClient } from '../clients/intercom-composio.js';
import { PipedriveComposioClient } from '../clients/pipedrive-composio.js';
import { CloseComposioClient } from '../clients/close-composio.js';
import { ComposioGenericPollClient } from '../clients/composio-generic-poll-client.js';
import { getPollSpec, getEntityPollIntervalMs } from './composio-poll-spec.js';

const POLL_INTERVAL_MS = 60_000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let lastCleanupAt = 0;

function serializeErr(err: unknown): { message: string; stack?: string } | string {
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  return String(err);
}

async function runCleanup(): Promise<void> {
  if (Date.now() - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = Date.now();
  try {
    const pool = await getPool();
    await pool.query('SELECT cleanup_expired_connector_jobs()');
    await pool.query('SELECT cleanup_expired_idempotency_keys()');
  } catch (err) {
    logger.warn({ err: serializeErr(err) }, 'polling: cleanup failed');
  }
}

// Derived — no hardcoded list. To add a new polled connector:
// 1. Implement list() in the client  2. Add normalizer  3. Set listImplemented: true in connectors.ts
const CONNECTOR_ENTITY_TYPES: Record<string, string[]> = Object.fromEntries(
  Object.entries(CONNECTORS)
    .filter(([connectorType, def]) => {
      const hasReadyPolling = def.polling?.some(p => p.listImplemented);
      if (hasReadyPolling && !getNormalizer(connectorType)) {
        logger.error({ connectorType }, 'listImplemented:true but no normalizer registered — skipping');
        return false;
      }
      return hasReadyPolling;
    })
    .map(([connectorType, def]) => [
      connectorType,
      def.polling!.filter(p => p.listImplemented).map(p => p.entityType),
    ])
);

export function startPollingScheduler(): NodeJS.Timeout {
  void runPollingCycle();
  return setInterval(() => void runPollingCycle(), POLL_INTERVAL_MS);
}

/**
 * Reset next_sync_at to now() so the scheduler's next tick (≤60 s) picks
 * this connector up immediately. Used by the force-sync endpoint.
 */
export async function enqueueImmediate(connectorId: string): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE connector_sync_state
     SET next_sync_at = now()
     WHERE connector_id = $1`,
    [connectorId],
  );
}

/**
 * Resets last_sync_at to epoch so the scheduler's next tick fetches full
 * history for every entity type of this connector.
 * Used by the harvest-service backfill job (one-time historical backfill).
 */
export async function enqueueBackfill(connectorId: string): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE connector_sync_state
     SET last_sync_at = '1970-01-01 00:00:00+00'::timestamptz,
         next_sync_at = now()
     WHERE connector_id = $1`,
    [connectorId],
  );
}

async function runPollingCycle(): Promise<void> {
  void runCleanup();
  const pollableTypes = Object.keys(CONNECTOR_ENTITY_TYPES);
  let due: DueConnector[];
  try {
    due = await getDueConnectors(pollableTypes);
  } catch (err) {
    logger.error({ err: serializeErr(err) }, 'polling: failed to fetch due connectors');
    return;
  }

  if (due.length === 0) return;

  logger.info({ count: due.length }, 'polling cycle start');

  await Promise.allSettled(
    due.map(({ connectorId, tenantId, connectorType }) =>
      pollConnector(connectorId, tenantId, connectorType),
    ),
  );
}

async function pollConnector(connectorId: string, tenantId: string, connectorType: string): Promise<void> {
  const entityTypes = CONNECTOR_ENTITY_TYPES[connectorType] ?? [];
  // One verdict per connector per cycle. A bad credential fails every entity it
  // polls, so counting per entity would reach any threshold N times faster
  // without being N times more certain.
  let worst: PollFailureKind | null = null;
  let firstError: unknown = null;

  for (const entityType of entityTypes) {
    try {
      await pollEntityType(connectorId, tenantId, connectorType, entityType);
    } catch (err) {
      logger.error({ connectorId, connectorType, entityType, err: serializeErr(err) }, 'poll entity type failed');
      const kind = classifyPollFailure(err);
      const promoted = worseFailure(worst, kind);
      // Keep the error that justifies the verdict, so the message recorded on
      // the connector is the one the classification was made from.
      if (promoted !== worst || firstError === null) firstError = err;
      worst = promoted;
    }
  }

  const message = firstError instanceof Error ? firstError.message : String(firstError ?? '');

  if (worst === null) {
    // A cycle with no failures ends any run in progress.
    await clearPollFailures(connectorId).catch((err) =>
      logger.warn({ connectorId, err: serializeErr(err) }, 'failed to clear poll failure state'));
    return;
  }

  if (worst === 'code') {
    // Deliberately does NOT flip the status. The UI renders `error` as
    // "Reconnect", and reconnecting cannot fix a client that never sends the
    // token — it would send someone round a loop that changes nothing. This
    // needs an engineer, so it gets its own event to alert on.
    logger.error(
      { connectorId, tenantId, connectorType, err: message, event: 'poll_client_auth_defect' },
      'poll failed because the client sent no credential — this is a code defect, not a reconnect',
    );
    await recordPollError(connectorId, message).catch(() => undefined);
    return;
  }

  if (worst === 'transient') {
    await recordPollError(connectorId, message).catch(() => undefined);
    return;
  }

  const consecutive = await recordPollAuthFailure(connectorId, message).catch((err) => {
    logger.warn({ connectorId, err: serializeErr(err) }, 'failed to record poll auth failure');
    return 0;
  });
  if (shouldFlipToError(worst, consecutive)) {
    logger.warn(
      { connectorId, tenantId, connectorType, consecutive, err: message },
      'connector rejected on every poll — marking reconnect required',
    );
    await markConnectorReconnectRequired(tenantId, connectorId, connectorType);
  }
}

async function pollEntityType(
  connectorId: string,
  tenantId: string,
  connectorType: string,
  entityType: string,
): Promise<void> {
  const syncState = await getSyncState(connectorId, entityType);

  // Per-entity poll interval (spec'd connectors may throttle low-velocity
  // entities to cut Composio call volume/cost). When the configured interval
  // exceeds the base cycle, skip this entity until its next_sync_at is due;
  // entities on the default interval poll every cycle exactly as before.
  const intervalMs = getEntityPollIntervalMs(connectorType, entityType) ?? POLL_INTERVAL_MS;
  if (
    intervalMs > POLL_INTERVAL_MS &&
    syncState?.nextSyncAt &&
    Date.now() < syncState.nextSyncAt.getTime()
  ) {
    return;
  }

  // The cursor is rewound by an overlap, and a record that arrives late is not
  // lost forever.
  //
  // `upsertSyncState` advances `last_sync_at` to NOW at the end of every poll,
  // whether or not anything was fetched. Without an overlap the search window
  // is therefore exactly one cycle wide — `since` sits one cycle (say 33
  // seconds) before the query — and any vendor-side visibility lag drops the
  // record PERMANENTLY:
  //
  //   poll N    queries after:T-33s   → message not yet searchable, 0 results
  //   poll N    sets last_sync_at = T
  //   poll N+1  queries after:T       → message's own timestamp is T-10s,
  //                                     which is < T, so it never matches again
  //
  // Nothing errors, nothing is published, and the connector stays green. It is
  // the same shape of silent loss as the empty bearer token: the system reports
  // health while the work does not happen.
  //
  // Gmail is the case that matters here — search indexing is not synchronous
  // with delivery — but the hazard is generic, which is why the overlap lives
  // in the scheduler rather than in one client.
  //
  // Safe to re-fetch: the runtime dedupes on `eventId` (`<externalId>-<content
  // hash>`) via markEventSeen, so a record seen twice is skipped the second
  // time, while a record whose CONTENT changed hashes differently and is
  // correctly re-delivered.
  const POLL_LOOKBACK_OVERLAP_MS = 5 * 60_000;
  const since = syncState?.lastSyncAt
    ? new Date(syncState.lastSyncAt.getTime() - POLL_LOOKBACK_OVERLAP_MS)
    : new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Build the client for this connector type
  const client = await buildClient(connectorId, tenantId, connectorType);
  if (!client) {
    // WS-5.5 — log enrichment so triage knows which tenant + binding fired.
    logger.warn({ connectorType, connectorId, tenantId }, 'polling: no client for connector type');
    return;
  }

  const normalizer = getNormalizer(connectorType);

  let pageToken = syncState?.lastPageToken;
  // Durable cross-cycle resume token (durableCursor-mode specs). Seeded from the
  // persisted state; advanced to the latest non-null token the client emits, and
  // written back after the drain so the next cycle resumes forward instead of
  // re-scanning from the oldest record.
  let syncCursor = syncState?.lastSyncCursor;
  let totalPublished = 0;
  // Counted so a cycle that publishes nothing can still say WHY. See the
  // summary log at the end of this function.
  let totalFetched = 0;
  let totalDroppedByFilter = 0;
  // Counted separately from `fetched` because the NORMALIZER can drop records
  // silently: Gmail's returned an empty array for every poll for the life of
  // the connector because it did not recognise this scheduler's `{results:[…]}`
  // envelope, and `fetched=1 published=0` alone did not say which stage ate it.
  let totalNormalized = 0;
  let pages = 0;

  do {
    let result: ListResult;
    try {
      result = await client.list(entityType, { since, pageToken, syncCursor, limit: 100 });
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('write-only') || msg.includes('does not support list')) {
        logger.debug({ connectorType, entityType }, 'list() not supported, skipping');
        return;
      }
      if (err instanceof OAuthRefreshError) {
        await markConnectorReconnectRequired(err.tenantId, err.connectorId, err.vendor);
      }
      throw err;
    }

    pages++;
    totalFetched += result.records.length;

    if (result.records.length > 0) {
      const normalized: NormalizedRecord[] = normalizer
        ? normalizer.normalize({ results: result.records.map(r => r.data) })
        : result.records.map(r => ({
            entityType,
            externalId: r.id,
            data: r.data,
            metadata: { source: connectorType, syncedAt: new Date(), version: hashCanonicalJson(r.data) },
          }));

      totalNormalized += normalized.length;
      const filtered = applyPublishFilter(connectorType, entityType, normalized);
      totalDroppedByFilter += normalized.length - filtered.length;

      await Promise.all(
        filtered.map(record =>
          publishPollingEvent({ connectorId, connectorType, entityType, tenantId, record }),
        ),
      );
      totalPublished += filtered.length;
    }

    if (result.syncCursor != null) syncCursor = result.syncCursor;
    pageToken = result.nextPageToken;
    await upsertSyncState(connectorId, entityType, new Date(), pageToken, intervalMs, syncCursor);
  } while (pageToken);

  // Every poll reports, including the ones that publish nothing.
  //
  // This used to log ONLY when totalPublished > 0, which made the zero case
  // unreadable from outside: "the vendor returned no new records", "the
  // response parsed to nothing", and "the filter dropped everything" all
  // looked identical — silence. Gmail sat in that silence while a support
  // mailbox went unread, and the only way to tell healthy from broken was to
  // read the source and guess.
  //
  // A poll that fetched nothing is not an error and does not deserve a warning,
  // but it is a FACT, and a fact nobody records cannot be checked. The counts
  // separate the three cases outright: fetched=0 is a quiet vendor, fetched>0
  // with published=0 names the filter, and the absence of this line altogether
  // means the poll never ran.
  //
  // `since` is included because it is the other half of every "why did it not
  // pick up my record" question — a cursor that has run ahead of the record
  // looks exactly like a vendor with nothing to say.
  logger.info(
    {
      connectorId,
      connectorType,
      entityType,
      since: since.toISOString(),
      pages,
      fetched: totalFetched,
      normalized: totalNormalized,
      droppedByFilter: totalDroppedByFilter,
      published: totalPublished,
      event: 'poll_entity_complete',
    },
    'poll complete',
  );
}

/**
 * Build a ConnectorClient for the given connector type.
 * REST clients get a CredentialProvider closure.
 * MCP clients get a PerConnectorIdCredentialStore.
 */
async function buildClient(connectorId: string, tenantId: string, connectorType: string) {
  // Credential provider for REST clients. tenantId/connectorId are forwarded
  // so clients can throw OAuthRefreshError({ tenantId, connectorId }) on
  // reconnect-required vendor responses (e.g. Outlook 403 insufficient_scope).
  const credentialProvider = async () => {
    const creds = await credentialService.getCredentials(tenantId, connectorId);
    return {
      accessToken: creds.accessToken ?? creds.apiKey ?? '',
      instanceUrl: creds.instanceUrl,
      // composio_managed connectors carry no bearer token — pass connectorConfig
      // so the client's tryComposioProxy routes polling through Composio's signed
      // proxy (else the direct-HTTP path 401s with the empty token, e.g. the
      // perpetual "Gmail list failed: 401").
      connectorConfig: creds.connectorConfig,
      tenantId,
      connectorId,
    };
  };

  // Credential store for MCP clients
  const credentialStore = new PerConnectorIdCredentialStore(tenantId, connectorId);

  switch (connectorType) {
    // REST clients
    case 'google_calendar':
      return new GoogleCalendarClient(credentialProvider);
    case 'microsoft_outlook_calendar':
      return new MicrosoftOutlookCalendarClient(credentialProvider);
    case 'microsoft_outlook_mail':
      return new MicrosoftOutlookMailClient(credentialProvider);
    case 'salesforce': {
      // Salesforce is composio_managed (OAuth): Composio's
      // managed app holds the token, so `credentialProvider` has nothing for the
      // native SalesforceClient to send. Lead/Opportunity/Contact polling runs
      // through each object's Composio list action, incremental on
      // SystemModstamp, keyed on the connectedAccountId.
      const creds = await credentialService.getCredentials(tenantId, connectorId);
      const connectedAccountId = creds.connectorConfig?.composioConnectedAccountId;
      if (typeof connectedAccountId !== 'string' || !connectedAccountId) {
        throw new Error(
          `salesforce connector ${connectorId} has no composioConnectedAccountId — reconnect required`,
        );
      }
      return new SalesforceComposioClient({ tenantId, connectedAccountId });
    }
    case 'google_mail':
      return new GoogleMailClient(credentialProvider);
    case 'google_drive':
      // google_drive has a client + GoogleDriveNormalizer + listImplemented:true,
      // but the buildClient case was missing, so the scheduler logged "no client
      // for connector type" and skipped it every cycle. Wire the existing client.
      return new GoogleDriveClient(credentialProvider);
    case 'atlassian_jira':
      return new JiraClient(credentialProvider);
    case 'linear':
      return new LinearClient(credentialProvider);
    case 'microsoft_contacts':
      return new MicrosoftContactsClient(credentialProvider);
    case 'microsoft_planner':
      return new MicrosoftPlannerClient(credentialProvider);
    case 'bamboohr':
      return new BambooHRClient(credentialProvider);
    case 'asana':
      return new AsanaClient(credentialProvider);
    case 'calendly':
      return new CalendlyClient(credentialProvider);
    case 'sendgrid':
      return new SendGridClient(credentialProvider);
    case 'microsoft_todo':
      return new MicrosoftToDoClient(credentialProvider);
    case 'microsoft_onenote':
      return new MicrosoftOneNoteClient(credentialProvider);
    case 'microsoft_sharepoint':
      return new MicrosoftSharePointClient(credentialProvider);
    case 'microsoft_teams':
      return new MicrosoftTeamsClient(credentialProvider);
    case 'paypal':
      return new PayPalClient(credentialProvider);
    case 'sentry':
      return new SentryClient(credentialProvider);

    // MCP clients
    case 'hubspot':
      return new HubSpotMCPClient({ tenantId, credentialStore });
    case 'zoom':
      return new ZoomMCPClient({ tenantId, credentialStore });
    case 'granola':
      return new GenericMCPClient({
        tenantId,
        connectorType: 'granola',
        mcpUrl: 'https://mcp.granola.ai/mcp',
        credentialStore,
      });
    case 'notion':
      return new NotionMCPClient({ tenantId, credentialStore });
    case 'attio':
      return new AttioMCPClient({ tenantId, credentialStore });
    case 'stripe':
      return new StripeMCPClient({ tenantId, credentialStore });
    case 'github':
      return new GitHubMCPClient({ tenantId, credentialStore });
    case 'gitlab':
      // GitLab's MCP exposes no "list my MRs/issues" tool, so poll the REST API
      // directly with the `api`-scoped OAuth token (see clients/gitlab.ts).
      return new GitLabClient({ tenantId, credentialStore });
    // datadog, apollo, folk migrated to the generic ComposioPollSpec path
    // (see composio-poll-spec.ts) and handled by the `default` branch below.
    case 'intercom': {
      // Intercom is composio_managed: reactive Conversation polling runs through
      // the Composio INTERCOM_LIST_CONVERSATIONS action (Composio has no Intercom
      // trigger and no contact-list action, so only Conversation events are
      // polled). Keyed on the connectedAccountId in connectorConfig.
      const creds = await credentialService.getCredentials(tenantId, connectorId);
      const connectedAccountId = creds.connectorConfig?.composioConnectedAccountId;
      if (typeof connectedAccountId !== 'string' || !connectedAccountId) {
        throw new Error(
          `intercom connector ${connectorId} has no composioConnectedAccountId — reconnect required`,
        );
      }
      return new IntercomComposioClient({ tenantId, connectedAccountId });
    }
    case 'pipedrive': {
      // Pipedrive is composio_managed (api_key): Composio holds the API token +
      // domain. Reactive Deal/Contact polling runs through the Composio
      // PIPEDRIVE_GET_RECENTS action, keyed on the connectedAccountId.
      const creds = await credentialService.getCredentials(tenantId, connectorId);
      const connectedAccountId = creds.connectorConfig?.composioConnectedAccountId;
      if (typeof connectedAccountId !== 'string' || !connectedAccountId) {
        throw new Error(
          `pipedrive connector ${connectorId} has no composioConnectedAccountId — reconnect required`,
        );
      }
      return new PipedriveComposioClient({ tenantId, connectedAccountId });
    }
    case 'close': {
      // Close is composio_managed (api_key) but Composio ships no list action
      // for Close leads/contacts, so reactive Lead/Contact polling routes
      // through the Composio HTTP proxy (raw GET /api/v1/lead/) rather than a
      // structured action. Keyed on the connectedAccountId.
      const creds = await credentialService.getCredentials(tenantId, connectorId);
      const connectedAccountId = creds.connectorConfig?.composioConnectedAccountId;
      if (typeof connectedAccountId !== 'string' || !connectedAccountId) {
        throw new Error(
          `close connector ${connectorId} has no composioConnectedAccountId — reconnect required`,
        );
      }
      return new CloseComposioClient({ tenantId, connectedAccountId });
    }

    // Gong is composio_managed auth (no raw bearer token), so its REST calls
    // must route through the Composio proxy, which needs connectorConfig
    // (composioConnectedAccountId). The shared credentialProvider above strips
    // connectorConfig; give Gong a provider that forwards it. Scoped to Gong so
    // other composio_managed connectors (jira/gmail) keep their existing
    // trigger-based reactive path and are not switched to proxy polling here.
    case 'gong': {
      const gongCredentialProvider = async () => {
        const creds = await credentialService.getCredentials(tenantId, connectorId);
        return {
          accessToken: creds.accessToken ?? '',
          instanceUrl: creds.instanceUrl,
          connectorConfig: creds.connectorConfig,
          tenantId,
          connectorId,
        };
      };
      return new GongClient(gongCredentialProvider);
    }

    // WooCommerce uses HTTP Basic auth (consumerKey:consumerSecret). The client
    // reads the key from accessToken and the secret from refreshToken, but the
    // shared credentialProvider above drops refreshToken — give Woo a provider
    // that forwards it (and the store URL via instanceUrl).
    case 'woocommerce': {
      const wooCredentialProvider = async () => {
        const creds = await credentialService.getCredentials(tenantId, connectorId);
        return {
          accessToken: creds.accessToken ?? '',
          refreshToken: creds.refreshToken,
          instanceUrl: creds.instanceUrl,
          tenantId,
          connectorId,
        };
      };
      return new WooCommerceClient(wooCredentialProvider);
    }

    default: {
      // Generic composio poller: any connector with a ComposioPollSpec is served
      // by the one data-driven client. Keyed on the composioConnectedAccountId
      // like the datadog/intercom/apollo/folk/close cases above.
      const spec = getPollSpec(connectorType);
      if (spec) {
        const creds = await credentialService.getCredentials(tenantId, connectorId);
        const connectedAccountId = creds.connectorConfig?.composioConnectedAccountId;
        if (typeof connectedAccountId !== 'string' || !connectedAccountId) {
          throw new Error(
            `${connectorType} connector ${connectorId} has no composioConnectedAccountId — reconnect required`,
          );
        }
        return new ComposioGenericPollClient(spec, tenantId, connectedAccountId);
      }
      return null;
    }
  }
}

// CalendarEvent: only publish events starting in the 25–35 minute window ahead
// so the Account Executive agent fires at the right time, not on every calendar sync.
function applyPublishFilter(
  connectorType: string,
  entityType: string,
  records: NormalizedRecord[],
): NormalizedRecord[] {
  if (
    entityType === 'CalendarEvent' &&
    (connectorType === 'google_calendar' || connectorType === 'microsoft_outlook_calendar')
  ) {
    const now = Date.now();
    const windowStart = now + 25 * 60 * 1000;
    const windowEnd = now + 35 * 60 * 1000;
    return records.filter(r => {
      const startAt = r.data['startDateTime'] as string | undefined;
      if (!startAt) return false;
      const start = new Date(startAt).getTime();
      return start >= windowStart && start <= windowEnd;
    });
  }
  return records;
}
