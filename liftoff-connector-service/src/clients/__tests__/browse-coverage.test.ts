// Every connector a customer can actually connect and be asked to pick a
// destination in must be enumerable by SOMETHING.
//
// This is the invariant the browse route was rebuilt around. It used to switch
// on five hardcoded type sets, so a connector absent from them answered
// 200-with-empty — the picker said "no channels found", the customer went
// looking through a workspace that was fine, and the gap was ours and silent. A
// required destination then blocked the hire with nothing on screen.
//
// Coverage now comes from three tiers, in order of specificity:
//
//   1. a bespoke client            (getClientFactory)
//   2. a Composio poll spec        (getPollSpec, driving the generic poller)
//   3. a Composio toolkit          (discover the toolkit's own list operation)
//
// Tier 3 is why this test can demand total coverage rather than tracking a
// shrinking list of exceptions: any composio_managed connector in the catalog is
// served without new code. If someone adds a connectable destination connector
// that none of the three can reach, this fails HERE rather than in front of a
// customer as an empty list.

import '../index.js';
import { getClientFactory } from '../adapter.js';
import { getPollSpec } from '../../polling/composio-poll-spec.js';
import { CONNECTORS } from '../../catalog/connectors.js';

/** Capabilities where a template can name a place the team writes into or reads
 *  from, i.e. where a person is asked to pick something. */
const DESTINATION_CAPABILITIES = new Set([
  'team_chat', 'data_table', 'documents', 'cloud_storage',
  'project_management', 'knowledge_base', 'crm', 'support',
  'calendar', 'email_marketing', 'e_signature', 'accounting',
]);

function isBrowseable(type: string): boolean {
  if (getClientFactory(type)) return true;
  if (getPollSpec(type)) return true;
  const def = CONNECTORS[type];
  return def?.mcp?.kind === 'composio_managed' && !!def.mcp.toolkitSlug;
}

function destinationConnectors(): string[] {
  return Object.entries(CONNECTORS)
    .filter(([, def]) =>
      // 'coming_soon' connectors cannot be connected, so there is no account to
      // enumerate and no picker to disappoint. Only what a customer can reach.
      def.status === 'available'
      && (def.capabilities ?? []).some(c => DESTINATION_CAPABILITIES.has(c.capability)),
    )
    .map(([type]) => type);
}

describe('browse coverage', () => {
  it('has connectors to check (the filter is not vacuously empty)', () => {
    // Without this, a change to the catalog shape could silently reduce the
    // suite below to asserting nothing at all.
    expect(destinationConnectors().length).toBeGreaterThan(40);
  });

  it('can enumerate every connectable destination connector', () => {
    const unserved = destinationConnectors().filter(t => !isBrowseable(t));
    expect(unserved).toEqual([]);
  });

  it('the three tiers each carry real load', () => {
    // If a tier ever drops to zero it has been disconnected — most likely by a
    // registration import being dropped or a lookup changing shape — and the
    // other tiers would quietly absorb the traffic until one could not.
    const all = Object.keys(CONNECTORS);
    const tier1 = all.filter(t => getClientFactory(t));
    const tier2 = all.filter(t => !getClientFactory(t) && getPollSpec(t));
    const tier3 = all.filter(t =>
      !getClientFactory(t) && !getPollSpec(t)
      && CONNECTORS[t]?.mcp?.kind === 'composio_managed' && !!CONNECTORS[t].mcp!.toolkitSlug);

    expect(tier1.length).toBeGreaterThan(50);
    expect(tier2.length).toBeGreaterThan(10);
    expect(tier3.length).toBeGreaterThan(20);
  });
});
