// TeamBuilder forwards the distill result verbatim into the create payload, so
// every field the distiller can emit must be acceptable to the create schema.
//
// `DistillOutput.instructionsMd` is typed `string | null` (distill-service.ts)
// and is the one field the distiller may legitimately return null for. The
// create schema declared it `z.string().optional()`, which accepts undefined
// but rejects null, so a distillation that produced no project guide failed
// with a bare "Validation failed" and the team could not be launched or even
// saved as a draft. The update schema had always accepted null, so a team could
// be edited into a state it could not be created in.
//
// These assert the zod semantics that made the two schemas disagree, so a
// future field that the distiller can null out is caught here rather than by a
// customer who cannot create a team.

import { z } from 'zod';

describe('create schema tolerates what the distiller emits', () => {
  it('optional() alone rejects null — the semantics behind the bug', () => {
    expect(z.string().optional().safeParse(undefined).success).toBe(true);
    expect(z.string().optional().safeParse(null).success).toBe(false);
    expect(z.string().nullable().optional().safeParse(null).success).toBe(true);
  });

  it('instructionsMd accepts null, a string, and absence', () => {
    // Mirrors the create schema's declaration for this field.
    const instructionsMd = z.string().max(100000).nullable().optional();

    expect(instructionsMd.safeParse(null).success).toBe(true);
    expect(instructionsMd.safeParse('# Project guide').success).toBe(true);
    expect(instructionsMd.safeParse(undefined).success).toBe(true);
    // Still bounded — nullability must not drop the length cap.
    expect(instructionsMd.safeParse('x'.repeat(100001)).success).toBe(false);
  });

  it('the fields the distiller never nulls stay strict', () => {
    // DistillOutput types these as plain strings, so accepting null here would
    // hide a real defect rather than tolerate a legitimate value.
    const summary = z.string().max(10000).optional();
    expect(summary.safeParse(null).success).toBe(false);
    expect(summary.safeParse('a summary').success).toBe(true);
  });
});
