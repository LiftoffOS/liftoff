// The agent's tool catalog is judged on the CREDENTIAL, not on a mirrored flag.
//
// `connector_manifests.enabled` is a mirror of connection state, written by the
// connect handler (true) and the disconnect handler (false) and by nothing
// else. Both writes have been wrong, in opposite directions, and each cost
// something:
//
//   - disconnect matched on `connectorType.replace(/_/g,'-')` while connect had
//     written `<type>-<first-8-of-id>` since migration 252, so it withdrew
//     nothing, and connectors already marked disconnected kept offering
//     their tools to every agent bound to that type.
//
//   - the connect UPSERT never restored `connectors.status` on conflict, so a
//     reconnect under the same id left it reading 'disconnected'. A repair
//     migration keyed on that column would therefore read LIVE connectors as
//     dead and withdraw them.
//
// Both writes are fixed. The point of this test is that the read no longer
// depends on either being right: `connector_credentials.status` is maintained
// in both directions, keyed on connector_id, which is the one predicate in the
// disconnect handler that always matched. So a revoked credential withdraws the
// connector even if `enabled` drifts true again.
//
// The guard is NOT EXISTS rather than an inner join on status = 'active',
// deliberately: a manifest with no credential row keeps today's behaviour.
// Some predate the handler that writes one (migration 251 backfilled
// manifests), and inventing a signal where there is none is precisely the
// mistake that caused the second bug above.

import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = readFileSync(
  join(__dirname, '..', 'manifest-repository.ts'),
  'utf8',
);

/** The SQL of getManifestsForAgent, which is what the tool catalog is built
 *  from (tool-gateway/mcp-server.ts calls it per agent). */
function catalogQuery(): string {
  const body = REPO.split('async getManifestsForAgent(')[1] ?? '';
  return body.split('async ')[0];
}

describe('getManifestsForAgent', () => {
  it('excludes a connector whose credential was revoked', () => {
    const sql = catalogQuery();
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('connector_credentials cc');
    expect(sql).toContain('cc.connector_id = cm.id');
    expect(sql).toMatch(/cc\.status\s*<>\s*'active'/);
  });

  it('still honours the manifest flag, so the two are defence in depth', () => {
    // Dropping `enabled` would make an operator-disabled connector reappear.
    // The guard is additive: either signal can withdraw a connector, and
    // neither is trusted alone.
    expect(catalogQuery()).toContain('cm.enabled = true');
  });

  it('does not withdraw a manifest that simply has no credential row', () => {
    // An inner join on status = 'active' would drop those silently. The
    // difference between "explicitly revoked" and "no information" is the
    // whole lesson of the migration that withdrew seven live connectors.
    const sql = catalogQuery();
    expect(sql).not.toMatch(/JOIN\s+connector_credentials/i);
    expect(sql).not.toMatch(/cc\.status\s*=\s*'active'/);
  });
});
