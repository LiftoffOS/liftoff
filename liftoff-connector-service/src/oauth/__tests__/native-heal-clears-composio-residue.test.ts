// Rebinding a connector to a NATIVE app must not leave the Composio binding
// behind.
//
// /callback has two source-flip heals for a connector an operator marked for
// forced reconnect. They are meant to mirror each other:
//
//   Composio branch  -> adoptMigrationMarkedConnector(), which REPLACES config,
//                       and says why: "the migrated row carries
//                       disconnect_reason, legacy api_key_hint, etc. that must
//                       not bleed into the new state"
//   native branch    -> mergeConnectorConfig(), which kept every one of them
//
// That asymmetry breaks a composio->native revert. Merging leaves
//
//   "composioConnectedAccountId": "ca_…"
//
// in the config, and makeConnectorTransport picks the Composio proxy on the
// mere PRESENCE of that field — so a connector freshly rebound to Liftoff's own
// Slack app goes on dispatching through Composio, to a connected account the
// migration has already deleted. Every send returns
// `404 ConnectedAccount_ResourceNotFound` while the row reads status=active.
//
// This is a source-level guard. The behaviour it protects lives in an Express
// callback with an OAuth exchange, a token write and a redirect in front of it;
// asserting on the CALL is what makes the invariant legible and what fails when
// someone reintroduces the merge.
import { readFileSync } from 'fs';
import { join } from 'path';

const routerSrc = readFileSync(join(__dirname, '..', 'router.ts'), 'utf8');

/** The native source-flip heal: `if (marked) { ... }` inside the branch that
 *  runs when no connector was found. */
function nativeHealBlock(): string {
  const anchor = routerSrc.indexOf('Source-flip heal (mirrors the Composio branch)');
  expect(anchor).toBeGreaterThan(-1);
  // Through to the fallback create that follows the heal.
  const end = routerSrc.indexOf('createConnectorReusingOnAccountConflict', anchor);
  expect(end).toBeGreaterThan(anchor);
  return routerSrc.slice(anchor, end);
}

describe('native source-flip heal', () => {
  it('replaces the config instead of merging into it', () => {
    const block = nativeHealBlock();
    expect(block).toContain('adoptMigrationMarkedConnector(');
  });

  it('does not merge — a merge is what carried the Composio binding across', () => {
    // The whole defect in one assertion: mergeConnectorConfig preserves
    // composioConnectedAccountId, and that field alone re-selects the Composio
    // transport for a connector that is no longer on Composio.
    expect(nativeHealBlock()).not.toContain('mergeConnectorConfig(');
  });

  it('keeps using the same adopt helper as the Composio branch', () => {
    // Two heals doing the same job two ways is the shape of the bug. If a
    // future change gives the native branch its own bespoke adopt, this fails
    // and the author has to say why they are diverging again.
    expect(routerSrc).toContain('adoptMigrationMarkedConnector');
    const composioAdopts = routerSrc.split('adoptMigrationMarkedConnector(').length - 1;
    expect(composioAdopts).toBeGreaterThanOrEqual(1);
  });

  it('still imports the adopt helper', () => {
    expect(routerSrc).toMatch(/adoptMigrationMarkedConnector,?\n/);
  });
});

describe('adoptMigrationMarkedConnector', () => {
  it('is documented as a full replace, which is the property relied on here', () => {
    const opsSrc = readFileSync(join(__dirname, '..', 'connector-ops.ts'), 'utf8');
    const fn = opsSrc.slice(opsSrc.indexOf('export async function adoptMigrationMarkedConnector'));
    // `config = $3::jsonb` — assignment, not `config || $3::jsonb`.
    expect(fn).toMatch(/config\s*=\s*\$3::jsonb/);
    expect(fn).not.toMatch(/config\s*=\s*config\s*\|\|/);
  });
});
