// Ratchet: every capability the catalog declares must reach the
// GetCapabilities RPC.
//
// THE DEFECT THIS EXISTS FOR. `getCapabilityGroups()` resolves each catalog
// capability key through `ProtoCapabilityByKey` and does:
//
//     const proto = ProtoCapabilityByKey[key];
//     if (proto === undefined) continue;   // ← silent
//
// so a key with no proto enum value is dropped with no error, no log, and no
// failing test. When the catalog declares keys the proto enum lacks, whole
// capability groups are invisible to every caller of that RPC — e.g.
// `email_communication` (Gmail, Outlook Mail, Missive), `cloud_storage`
// (Drive, OneDrive, Dropbox, Box, SharePoint), `team_chat` (Slack, Teams,
// Discord). Any connector tagged ONLY with a missing key surfaces nowhere, and
// nothing else compares the two lists.
//
// WHY A TEST AND NOT JUST THE FIX. ProtoCapabilityByKey is now derived from the
// enum, so THAT half can no longer drift. The other half still can: the catalog
// lives here and the enum lives in liftoff-proto, so tagging a connector with a
// brand-new capability string silently reintroduces the gap. That is the case
// this test fails on, and the fix is a proto change (add the value to
// ConnectorCapability in liftoff/connector/v1/types.proto, publish proto-gen,
// bump it here) — NOT deleting the capability from the connector.

import { CONNECTOR_CAPABILITIES, ProtoCapabilityByKey } from '../connector-capabilities.js';
import { getCapabilityGroups } from '../capabilities.js';

describe('capability ↔ proto enum parity', () => {
  it('every catalog capability key has a proto enum value', () => {
    const missing = Object.keys(CONNECTOR_CAPABILITIES)
      .filter((key) => ProtoCapabilityByKey[key] === undefined)
      .sort();

    expect(missing).toEqual([]);
  });

  it('getCapabilityGroups() surfaces every catalog capability — none dropped', () => {
    const declared = new Set(Object.keys(CONNECTOR_CAPABILITIES));
    const surfaced = new Set(getCapabilityGroups().map((g) => g.capabilityKey));
    const dropped = [...declared].filter((k) => !surfaced.has(k)).sort();

    expect(dropped).toEqual([]);
    expect(surfaced.size).toBe(declared.size);
  });

  it('every surfaced group carries at least one provider', () => {
    // A capability group with no providers is a tile that resolves to nothing.
    const empty = getCapabilityGroups()
      .filter((g) => g.providers.length === 0)
      .map((g) => g.capabilityKey)
      .sort();

    expect(empty).toEqual([]);
  });

  it('the derived map matches the enum exactly (no hand-editing crept back in)', () => {
    // Guards the derivation itself: if someone replaces the Object.fromEntries
    // with a literal, this catches the moment it falls behind the enum.
    const enumKeys = Object.entries(
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('@liftoffos/proto-gen/liftoff/connector/v1/types_pb.js').ConnectorCapability as Record<string, unknown>,
    )
      .filter(([name, value]) => typeof value === 'number' && name !== 'UNSPECIFIED')
      .map(([name]) => name.toLowerCase())
      .sort();

    expect(Object.keys(ProtoCapabilityByKey).sort()).toEqual(enumKeys);
  });
});
