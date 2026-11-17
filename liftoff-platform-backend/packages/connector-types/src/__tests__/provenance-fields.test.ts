// The provenance / egress / staged-write fields, and the one property that
// makes them worth having: this contract and the WIRE agree.
//
// `ListTools` carries ConnectorFunction field for field. A field that exists
// here and not in `liftoff/connector/v1/connector_service.proto` is a field
// connector-service can populate, TypeScript will happily typecheck, and the
// tenant runtime will never see — the declaration stops at the RPC boundary and
// every consumer silently falls back to its heuristic. That failure is invisible
// from either side alone: connector-service's tests pass because it set the
// field, and the runtime's pass because they exercise the fallback.
//
// The wire half of that property is asserted in
// src/connectors/__tests__/tool-definition-wire-parity.test.ts, which is where
// both this package and @liftoffos/proto-gen are installed together. This file
// pins the shape a tool can declare.

import type { ConnectorFunction } from '../tool-schema';

describe('the declaration a tool can carry', () => {
  it('accepts the two halves of record provenance', () => {
    // A write says which arguments name the record; a read says where its
    // result carries identities. Separate fields because they are separate
    // facts, and most tools have one or the other.
    const write: ConnectorFunction = {
      name: 'create_review_comment',
      description: 'Comment on a pull request',
      inputSchema: { type: 'object', properties: {} },
      categories: ['write'],
      idArgs: ['owner', 'repo', 'pull_number'],
    };
    const read: ConnectorFunction = {
      name: 'list_pull_requests',
      description: 'List pull requests',
      inputSchema: { type: 'object', properties: {} },
      categories: ['read'],
      returnsIds: [{ entityType: 'PullRequest', path: 'items[].number' }],
    };

    expect(write.idArgs).toEqual(['owner', 'repo', 'pull_number']);
    expect(read.returnsIds?.[0]).toEqual({ entityType: 'PullRequest', path: 'items[].number' });
  });

  it('accepts host-only result paths', () => {
    const fn: ConnectorFunction = {
      name: 'create_download_link',
      description: 'Mint a signed download URL',
      inputSchema: { type: 'object', properties: {} },
      categories: ['read'],
      egressOnly: ['data.signedUrl'],
    };

    expect(fn.egressOnly).toEqual(['data.signedUrl']);
  });

  it('accepts a staged-write pair, and defaults to neither half', () => {
    const stage: ConnectorFunction = {
      name: 'stage_price_update',
      description: 'Prepare a price change',
      inputSchema: { type: 'object', properties: {} },
      categories: ['write'],
      writeRole: 'stage',
      paired_apply: 'apply_price_update',
    };
    const ordinary: ConnectorFunction = {
      name: 'send_message',
      description: 'Send a message',
      inputSchema: { type: 'object', properties: {} },
      categories: ['write', 'outbound'],
    };

    expect(stage.writeRole).toBe('stage');
    expect(stage.paired_apply).toBe('apply_price_update');
    // Absent, not 'direct'. Every tool that does not opt in reads as undefined,
    // so a consumer cannot tell "declared direct" from "never considered" — and
    // it does not need to, because both mean the same thing here.
    expect(ordinary.writeRole).toBeUndefined();
  });
});
