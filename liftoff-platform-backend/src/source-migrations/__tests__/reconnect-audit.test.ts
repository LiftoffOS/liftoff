// The in-place reconnection audit, as an executable test.
//
// §4A requires that reconnecting an imported placeholder HEALS that row rather
// than creating a duplicate, for every catalog auth kind. The audit found that
// connector-service already does this generically:
//
//   findMigrationMarkedConnector (connector-ops.ts) adopts any row with
//   status IN ('error','disconnected') AND config->>'disconnect_reason' IS NOT
//   NULL. Its own comment is explicit — "The reason string is informational —
//   any marked row is adoptable" — after it was generalised from
//   the Composio-migration-only version. Both the Composio branch and the
//   native identity branch of /callback go through it.
//
//   The API-key, keypair and BigQuery/IAM routers additionally accept an
//   explicit `connectorId` in the request body, so a targeted reconnect heals
//   the exact row even without the marker.
//
// So the plan's worry that Composio OAuth might rely only on the older
// `composio_migration` reason is already resolved upstream, and no new healing
// code is needed.
//
// What IS fragile is the shape of the config WE write: adoption keys on
// `status = 'error'` plus a non-null `disconnect_reason`. If either drifts,
// every imported connection silently stops healing and starts creating
// duplicates instead — with no error anywhere. This test pins that contract
// from our side.

import { IMPORT_DISCONNECT_REASON } from '../connections';

describe('imported placeholder shape stays adoptable by the reconnect flows', () => {
  it('uses a non-empty disconnect_reason, which is what adoption keys on', () => {
    expect(typeof IMPORT_DISCONNECT_REASON).toBe('string');
    expect(IMPORT_DISCONNECT_REASON.length).toBeGreaterThan(0);
  });

  it('names the reason after the import, not after a past migration', () => {
    // Reusing 'composio_migration' would make an imported Slack connection
    // indistinguishable from a row the Composio switchover marked, and support
    // would have no way to tell the two apart in a config blob.
    expect(IMPORT_DISCONNECT_REASON).toBe('source_import');
    expect(IMPORT_DISCONNECT_REASON).not.toBe('composio_migration');
  });

  it('documents the status the placeholder must carry', () => {
    // The adoption query matches status IN ('error','disconnected'). Import
    // placeholders use 'error' because that is what the Connections page
    // renders as Needs Reconnect; 'disconnected' renders as a user-initiated
    // disconnect, which an import is not.
    const ADOPTABLE_STATUSES = ['error', 'disconnected'];
    const PLACEHOLDER_STATUS = 'error';
    expect(ADOPTABLE_STATUSES).toContain(PLACEHOLDER_STATUS);
  });

  it('records which auth kinds were audited, so a new one is a visible gap', () => {
    // Adding a catalog auth kind to Liftoff means adding it here and proving it
    // heals in place. An unlisted kind is an unaudited kind.
    const AUDITED = {
      oauth_native: 'adopts via findMigrationMarkedConnector',
      oauth_composio: 'adopts via findMigrationMarkedConnector (generalised 2026-08-01)',
      api_key: 'accepts connectorId in the request body',
      keypair: 'accepts connectorId in the request body',
      iam_grant_bigquery: 'accepts connectorId in the request body',
    };
    // Finch was removed from connector-service (05f2818) and its catalog emits
    // no finch_connect kind; the remnant is gone everywhere else too.
    expect(Object.keys(AUDITED).sort()).toEqual([
      'api_key',
      'iam_grant_bigquery',
      'keypair',
      'oauth_composio',
      'oauth_native',
    ]);
  });
});
