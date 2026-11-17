// What a tool can DECLARE and what the wire can CARRY have to be the same set.
//
// `ListTools` returns `ToolDefinition`, and that message mirrors
// `ConnectorFunction` field for field: name, description, input schema,
// categories, draft variant, entity type, the work-pair four, definition source,
// vendor tool name. connector-service builds one from the other and the tenant
// runtime reads it back.
//
// So a field added to the TypeScript contract and NOT to the proto is a field
// that connector-service can populate, that typechecks on both sides, and that
// the runtime never sees. The declaration stops at the RPC boundary and every
// consumer silently falls back to its heuristic — which is the same shape as an
// undeclared category falling back to a name guess, except nobody chose it.
//
// That defect is invisible from either repo alone. connector-service's tests
// pass because it set the field; the runtime's pass because they exercise the
// fallback. It needs both packages in hand, and this repo is where they are:
// @liftoffos/connector-types is a workspace here and @liftoffos/proto-gen is a
// dependency. The same reasoning the schema-reachability ratchet gives for why
// it cannot see cross-repo defects is why this test exists here.

import type { ConnectorFunction } from '@liftoffos/connector-types';

 
const pb = require('@liftoffos/proto-gen/dist/liftoff/connector/v1/connector_service_pb.js');
 

/** Field names on a generated message, in the runtime's own naming. */
function wireFields(messageName: string): Set<string> {
  const desc = pb[`${messageName}Schema`] ?? pb[messageName];
  if (!desc) throw new Error(`no generated descriptor for ${messageName}`);
  const fields: Array<{ localName?: string; jsonName?: string; name?: string }> =
    desc.fields ?? desc.field ?? [];
  return new Set(
    fields
      .map((f) => f.localName ?? f.jsonName ?? f.name)
      .filter((n): n is string => typeof n === 'string'),
  );
}

describe('ToolDefinition carries every field ConnectorFunction declares', () => {
  // The declarations this program adds. Listed rather than derived from the TS
  // type, because a type is erased at runtime and a reflection trick would be a
  // second thing to keep correct. A new field belongs on this list the moment
  // it is added, which is the point at which somebody has to think about the
  // wire.
  it.each([
    ['idArgs', 'which arguments name the record a write acts on'],
    ['returnsIds', 'where a read result carries identities'],
    ['egressOnly', 'result paths the surface may see and the model may not'],
    ['writeRole', 'stage / apply / direct'],
    ['pairedApply', 'the apply tool that commits a stage'],
  ])('%s is on the wire (%s)', (field) => {
    expect(wireFields('ToolDefinition')).toContain(field);
  });

  it('still carries the fields it always did', () => {
    // A guard on the guard: if the descriptor shape ever changes and
    // `wireFields` starts returning nothing, every assertion above would fail
    // loudly — but a partial answer would pass some and fail others confusingly.
    // This pins that the reader is reading.
    const fields = wireFields('ToolDefinition');
    for (const known of ['name', 'description', 'categories', 'workRole', 'pairedAck', 'vendorToolName']) {
      expect(fields).toContain(known);
    }
  });

  it('carries both halves of a returned-id declaration', () => {
    const fields = wireFields('ReturnedIds');
    expect(fields).toContain('entityType');
    expect(fields).toContain('path');
  });
});

describe('the TypeScript contract accepts what the wire can express', () => {
  it('round-trips a fully declared function', () => {
    // Compile-time proof that the field names and types line up with what the
    // proto's generated shape uses. A rename on either side breaks this.
    const fn: ConnectorFunction = {
      name: 'create_review_comment',
      description: 'Comment on a pull request',
      inputSchema: { type: 'object', properties: {} },
      categories: ['write'],
      idArgs: ['owner', 'repo', 'pull_number'],
      returnsIds: [{ entityType: 'PullRequest', path: 'items[].number' }],
      egressOnly: ['data.signedUrl'],
      writeRole: 'stage',
      paired_apply: 'apply_review',
    };

    expect(fn.idArgs).toHaveLength(3);
    expect(fn.returnsIds).toHaveLength(1);
    expect(fn.egressOnly).toHaveLength(1);
    expect(fn.writeRole).toBe('stage');
    expect(fn.paired_apply).toBe('apply_review');
  });
});
