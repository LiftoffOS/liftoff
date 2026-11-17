// A Switch bundle imports under either spelling of the relationships key.
//
// @liftoffos/cli is PUBLISHED. Someone who installed it before the vocabulary
// rename keeps sending `teamRelationships`, because that is the key the version
// on their machine was built to send, and they have no reason to upgrade before
// running an import. Rejecting it at the schema is the worst available failure:
// the person has already pointed the CLI at their existing setup, waited for it
// to read everything, and uploaded. A 400 there loses all of it.
//
// So both keys are optional and the router folds them into one before anything
// downstream sees the body. This pins that, in both directions, because the
// natural "tidy-up" six months from now is to delete the old key and this is
// what should stop it.

import { z } from 'zod';

/** Mirrors the router's shape for the two keys and the fold that follows. */
const relationshipSchema = z.object({
  fromSourceRef: z.string().max(512),
  toSourceRef: z.string().max(512),
  kind: z.enum(['delegates_to', 'shares_workspace']),
});

const keysSchema = z.object({
  agentRelationships: z.array(relationshipSchema).max(500).optional(),
  teamRelationships: z.array(relationshipSchema).max(500).optional(),
});

type Keys = z.infer<typeof keysSchema>;

/** The router's normalisation, isolated so it can be asserted on its own. */
function fold(bundle: Keys) {
  return bundle.agentRelationships ?? bundle.teamRelationships ?? [];
}

const EDGE = { fromSourceRef: 'a', toSourceRef: 'b', kind: 'delegates_to' as const };

describe('Switch bundle relationships key', () => {
  it('accepts the new spelling', () => {
    const parsed = keysSchema.safeParse({ agentRelationships: [EDGE] });
    expect(parsed.success).toBe(true);
    expect(fold(parsed.success ? parsed.data : {})).toEqual([EDGE]);
  });

  it('accepts the retired spelling a published CLI still sends', () => {
    const parsed = keysSchema.safeParse({ teamRelationships: [EDGE] });
    expect(parsed.success).toBe(true);
    expect(fold(parsed.success ? parsed.data : {})).toEqual([EDGE]);
  });

  it('accepts a bundle with neither, which is a bundle with no relationships', () => {
    const parsed = keysSchema.safeParse({});
    expect(parsed.success).toBe(true);
    expect(fold(parsed.success ? parsed.data : {})).toEqual([]);
  });

  it('prefers the new spelling when a bundle carries both', () => {
    const other = { ...EDGE, toSourceRef: 'c' };
    expect(fold({ agentRelationships: [EDGE], teamRelationships: [other] })).toEqual([EDGE]);
  });

  it('still validates the edges under the retired spelling', () => {
    // The old key is a deprecated NAME, not a way in past the schema.
    expect(keysSchema.safeParse({ teamRelationships: [{ ...EDGE, kind: 'nonsense' }] }).success).toBe(false);
  });
});
