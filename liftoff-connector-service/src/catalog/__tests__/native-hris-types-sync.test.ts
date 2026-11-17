// Invariant: NATIVE_HRIS_TYPES (native-hris-types.ts) and the leaf membership set in
// isNativeHrisConnector (source-overrides.ts) must stay in sync. They're two copies to
// avoid an import cycle, so this guards against drift.
import { NATIVE_HRIS_TYPES } from '../native-hris-types.js';
import { isNativeHrisConnector } from '../source-overrides.js';

describe('native HRIS type sets stay in sync', () => {
  it('every NATIVE_HRIS_TYPES entry is a native HRIS connector', () => {
    for (const t of NATIVE_HRIS_TYPES) {
      expect(isNativeHrisConnector(t)).toBe(true);
    }
  });

  it('non-HRIS connectors are not native HRIS', () => {
    for (const t of ['slack', 'salesforce', 'stripe', 'zenefits', 'unknown_x']) {
      expect(isNativeHrisConnector(t)).toBe(false);
    }
  });
});
