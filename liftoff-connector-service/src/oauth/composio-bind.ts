// Completing a Composio connect: the single place a composio_managed
// connection becomes a Liftoff connector row.
//
// This exists because binding inline in GET /callback makes a BROWSER
// REDIRECT load-bearing for correctness. If Composio does not return the
// browser to us, connections go ACTIVE (and billed) at Composio while Liftoff
// writes nothing at all — the data is simply lost, silently. Composio publishes no "connection became
// ACTIVE" webhook (their catalogue is `composio_connected_account_expired`,
// `composio_trigger_disabled`, `composio_trigger_message` v1/v2), so there is
// no push signal to subscribe to; recovery has to be a pull.
//
// So the bind is a function two callers share:
//   - GET /callback          — the fast path, when the browser does come back
//   - the reconciler          — the safety net, when it does not
//
// Keeping them literally the same function is the point. A reconciler that
// re-implemented the four adoption paths would drift from /callback and adopt
// rows differently, which is worse than not having one.

import { logger } from '../infra/logging.js';
import {
  findConnectorByTenantAndType,
  findConnectorByTenantTypeAndExternalAccountId,
  findMigrationMarkedConnector,
  adoptMigrationMarkedConnector,
  createConnectorReusingOnAccountConflict,
  getConnectorById,
  updateConnectorStatus,
  mergeConnectorConfig,
  deleteOAuthState,
  type OAuthStateRow,
} from './connector-ops.js';
import { getComposio, type ComposioConnectedAccount } from './composio-client.js';
import { ensureComposioTriggerArmed } from './composio-trigger-arm.js';
import { extractComposioIdentity } from './identity-fetchers.js';
import { emitCredentialsStored } from '../events/publisher.js';
import { CONNECTOR_DISPLAY_NAMES } from '../types.js';

/** Where the completion came from — carried into the log line so we can see
 *  how often the browser round-trip is actually failing in production. */
export type CompletionSource = 'callback' | 'reconciler';

/**
 * Turn an ACTIVE Composio connected account into a Liftoff connector row,
 * publish `credentials_stored`, and consume the oauth_state row.
 *
 * Idempotent by construction: every path either adopts an existing row or
 * creates one behind the unique (tenant, type, account) index, so a
 * reconciler racing a late /callback converges on the same connector rather
 * than duplicating it.
 */
export async function completeComposioConnection(args: {
  state: string;
  oauthState: OAuthStateRow;
  connectedAccount: ComposioConnectedAccount;
  composioAuthConfigId: string;
  source: CompletionSource;
}): Promise<{ connectorId: string }> {
  const { state, oauthState, connectedAccount, composioAuthConfigId, source } = args;

  // Extract identity from Composio's response shape. Three-layer chain:
  // flat-field heuristic → id_token JWT decode (OIDC) → per-toolkit whoami via
  // composio.tools.execute (Slack, Dropbox, Atlassian, …). Passing `composio`
  // + `tenantId` activates layer 3; omitting them would degrade to 1+2 only.
  const identity = await extractComposioIdentity(
    oauthState.connectorType,
    connectedAccount,
    getComposio(),
    oauthState.tenantId,
  );

  // Find-or-create connector row. Four paths:
  //   (1) An existing Composio row with the same externalAccountId (true
  //       reconnect of the same vendor account) → update in place.
  //   (2) No (1) match BUT a migration-marked row exists (legacy api_key
  //       cal_com/mailchimp/trello row that the migration script
  //       disconnected) → ADOPT that row by REPLACING its config wholesale.
  //       This preserves the connector_id so any agent bindings referencing
  //       the old row stay valid, and avoids the UX bug where the user sees
  //       both "Needs Reconnect" and "Connected" tiles for the same type.
  //   (2b) No (1)/(2) match BUT any pre-existing row exists for this
  //        (tenant, type) — i.e. the user had this connector connected via
  //        the OLD direct-OAuth flow before we flipped it to composio_managed.
  //        Same adoption treatment, so the row (and its id) carries over
  //        instead of a sibling appearing beside it.
  //   (3) Neither → fresh connect; createConnector.
  const composioConfig = {
    externalAccountId: identity.externalAccountId,
    externalAccountLabel: identity.externalAccountLabel,
    composioConnectedAccountId: connectedAccount.id,
    composioAuthConfigId,
  };

  // Precedence tier-0: reconnect target (un-claimed row) → adopt.
  const reconnectId = (oauthState.extra as { reconnectConnectorId?: string } | null)
    ?.reconnectConnectorId;
  let connector: Awaited<ReturnType<typeof getConnectorById>> = null;
  if (reconnectId) {
    const t = await getConnectorById(oauthState.tenantId, reconnectId);
    if (
      t &&
      t.type === oauthState.connectorType &&
      !(t.config as { externalAccountId?: string }).externalAccountId
    ) {
      connector = t;
    }
  }
  if (!connector) {
    connector = await findConnectorByTenantTypeAndExternalAccountId(
      oauthState.tenantId,
      oauthState.connectorType,
      identity.externalAccountId,
    );
  }

  if (connector) {
    // Path (1): existing composio row, refresh ids in case bootstrap rotated
    // auth_config or Composio rotated the connected-account id. Also
    // (re)write externalAccountId — this is what HEALS a row adopted via the
    // tier-0 reconnect branch above (selected precisely because it had NO
    // externalAccountId); without this the adopted row would never become
    // dedup-able. Idempotent for a true-reconnect match.
    const target = connector;
    connector = await updateConnectorStatus(oauthState.tenantId, target.id, 'active');
    try {
      await mergeConnectorConfig(oauthState.tenantId, target.id, {
        externalAccountId: identity.externalAccountId,
        externalAccountLabel: identity.externalAccountLabel,
        composioConnectedAccountId: connectedAccount.id,
        composioAuthConfigId,
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        // Adopted an un-claimed reconnect target, but another row already owns
        // this account → the unique (tenant, type, account) index rejected the
        // heal. Fall back to the real owner and use it instead.
        const owner = await findConnectorByTenantTypeAndExternalAccountId(
          oauthState.tenantId,
          oauthState.connectorType,
          identity.externalAccountId,
        );
        if (!owner) throw err;
        connector = await updateConnectorStatus(oauthState.tenantId, owner.id, 'active');
        await mergeConnectorConfig(oauthState.tenantId, owner.id, {
          externalAccountLabel: identity.externalAccountLabel,
          composioConnectedAccountId: connectedAccount.id,
          composioAuthConfigId,
        });
      } else {
        throw err;
      }
    }
  } else {
    const migrationMarked = await findMigrationMarkedConnector(
      oauthState.tenantId,
      oauthState.connectorType,
    );
    if (migrationMarked) {
      // Path (2): adopt the migration-marked legacy row.
      connector = await adoptMigrationMarkedConnector(
        oauthState.tenantId,
        migrationMarked.id,
        composioConfig,
      );
      logger.info(
        {
          connectorId: connector.id,
          connectorType: oauthState.connectorType,
          tenantId: oauthState.tenantId,
          source,
        },
        'connector.composio_migration_adopted',
      );
    } else {
      const legacyDirect = await findConnectorByTenantAndType(
        oauthState.tenantId,
        oauthState.connectorType,
      );
      if (legacyDirect) {
        // Path (2b): adopt the legacy direct-OAuth row. Same adopt helper as
        // (2) — replaces config wholesale, status → active. Old
        // credentialService row + Secret Manager entry are orphaned
        // intentionally: Composio holds tokens now, and revoking the legacy
        // Google refresh token on the vendor side requires the user to revoke
        // at accounts.google.com → 3rd-party apps.
        connector = await adoptMigrationMarkedConnector(
          oauthState.tenantId,
          legacyDirect.id,
          composioConfig,
        );
        logger.info(
          {
            connectorId: connector.id,
            connectorType: oauthState.connectorType,
            tenantId: oauthState.tenantId,
            previousStatus: legacyDirect.status,
            source,
          },
          'connector.composio_direct_oauth_adopted',
        );
      } else {
        // Path (3): fresh connect. Reuse-on-conflict guards the unique
        // (tenant, type, account) index against a concurrent connect that
        // created the same account row a moment earlier.
        const created = await createConnectorReusingOnAccountConflict(
          {
            tenantId: oauthState.tenantId,
            type: oauthState.connectorType,
            name: CONNECTOR_DISPLAY_NAMES[oauthState.connectorType] ?? oauthState.connectorType,
            config: composioConfig,
          },
          identity.externalAccountId,
        );
        // createConnector INSERTs status='pending' — correct for the api-key
        // flow, which creates the row and only activates once the key verifies
        // (apikey-router does exactly that). OAuth has no such second step:
        // by the time we are here the connected account is already ACTIVE in
        // Composio and pollConnectedAccountActive has confirmed it, so the row
        // is connected and must say so.
        //
        // Paths (1), (2) and (2b) all set 'active' explicitly; only this one
        // did not, so a FIRST-EVER Composio connect for a connector type
        // landed 'pending' and stayed there forever. The Connections page
        // derives its tile from connectors.status (migration 024 —
        // active=Connected, error=Reconnect), so the connector authenticated,
        // dispatched tools correctly, and rendered nowhere.
        //
        // It is easy to miss because it only bites a genuinely fresh connect:
        // every connector adopted from legacy direct OAuth took path (2b), and
        // any later reconnect takes path (1), both of which activate.
        connector = await updateConnectorStatus(oauthState.tenantId, created.id, 'active');
      }
    }
  }

  // CRITICAL: no credentialService.storeCredentials() call.
  // Composio holds the tokens — Liftoff never sees them.

  // Publish credentials_stored with composioConnectedAccountId so the
  // tenant-runtime subscriber persists it onto
  // connector_manifests.external_account_id. tenant-runtime's
  // composio-dispatcher reads it from manifest.externalAccountId and passes it
  // as composio.tools.execute({ connectedAccountId }) to disambiguate
  // multi-account tenants (allowMultiple: true at install).
  emitCredentialsStored({
    tenantId: oauthState.tenantId,
    connectorId: connector.id,
    connectorType: oauthState.connectorType,
    composioConnectedAccountId: connectedAccount.id,
  });

  // Arm the event trigger for THIS connected account.
  //
  // For a composio_managed connector, Composio's trigger system is the only
  // path by which events reach us, and a trigger is bound to the connected
  // account it was created against. A reconnect mints a new account id, so
  // without this the connector completes, goes ACTIVE, executes tool calls
  // normally — and never wakes an agent again.
  //
  // Here rather than in the reconnect path because BOTH routes end here: the
  // OAuth callback (first connect) and the stranded-connection reconciler
  // (recovery). Idempotent upsert on (connectedAccountId, slug), so calling it
  // on every completion is safe and removes any need to detect "is this a
  // reconnect", which would be one more thing to get wrong.
  //
  // Never fatal: a completed connection is one the user finished, and throwing
  // away a working credential over a trigger-registration error would send them
  // back through consent for something they cannot influence. Watch for
  // `composio_trigger_arm_failed`.
  await ensureComposioTriggerArmed({
    tenantId: oauthState.tenantId,
    connectorId: connector.id,
    connectorType: oauthState.connectorType,
    connectedAccountId: connectedAccount.id,
  });

  // Connector row is committed; ACTIVE is a terminal Composio state. Safe to
  // consume the oauth_state row now — a later /callback with the same state
  // hits the "invalid_state" branch, which is fine because the side effect is
  // already done and idempotent.
  await deleteOAuthState(state);

  logger.info(
    {
      connectorId: connector.id,
      connectorType: oauthState.connectorType,
      tenantId: oauthState.tenantId,
      accountId: oauthState.accountId,
      source,
    },
    'connector.composio_oauth_completed',
  );

  return { connectorId: connector.id };
}
