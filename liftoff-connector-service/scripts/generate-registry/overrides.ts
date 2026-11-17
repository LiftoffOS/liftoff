// Registry generation — hand-fixes, merged at generation time.
//
// The ONLY legitimate place to correct a generated function. Keyed by vendor
// then function name; fields given here replace the generated ones on the
// next run. Editing a generated file directly is overwritten and forbidden.

import type { GeneratedFunction } from './normalize';

export const OVERRIDES: Record<string, Record<string, Partial<GeneratedFunction>>> = {
  tikhub: {},
  strale: {},
};
