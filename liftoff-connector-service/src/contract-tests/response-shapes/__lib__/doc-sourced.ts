import { NATIVE_HRIS_TYPES } from '../../../catalog/native-hris-types.js';

// Fixtures for these connectors come from vendor DOCS or first-real-response capture (Phase 4) —
// there is no live tenant we can re-run capture-fixtures.ts against. So they are EXEMPT from the
// live-recapture 120-day age gate, and are instead gated on conformance to their tool's
// codegen responseSchema (see native-hris-actions.test.ts). Refresh cadence = re-read vendor
// docs on an API-version bump, not a live recapture.
export const DOC_SOURCED_CONNECTORS: ReadonlySet<string> = new Set(NATIVE_HRIS_TYPES);
