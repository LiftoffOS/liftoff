// Asserts that src/branding/registry.ts and packages/shared-types/src/branding.ts
// stay byte-identical. The shared-types package is the npm-published source
// consumed by workforce-service and liftoff-react; the platform-backend in-tree
// copy exists so platform-backend code doesn't need the package to be built
// before it can be imported under tsc's rootDir constraint.
//
// Editing either file alone is a drift bug — they must be updated together.

import { readFileSync } from 'fs';
import { join } from 'path';

describe('branding registry single-source-of-truth', () => {
  it('src/branding/registry.ts matches packages/shared-types/src/branding.ts', () => {
    const local = readFileSync(
      join(__dirname, '..', 'registry.ts'),
      'utf-8',
    );
    const shared = readFileSync(
      join(__dirname, '..', '..', '..', 'packages', 'shared-types', 'src', 'branding.ts'),
      'utf-8',
    );
    expect(local).toBe(shared);
  });
});
