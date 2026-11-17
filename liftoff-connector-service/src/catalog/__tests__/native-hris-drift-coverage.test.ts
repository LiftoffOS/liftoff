// Connector-level drift-coverage gate. Layer C in
// contract-tests/request-conformance/native-hris-request-conformance.test.ts guards the codegen
// output per generated FILE; this guards the assembled runtime surface per CONNECTOR TYPE — the
// merged NATIVE_HRIS_FUNCTIONS set that the registry actually serves at cutover, which includes the
// CURATED-only connectors (hibob/dayforce/adp/ukg_*/oracle_hcm) that have no generated file or a
// lean/large one carrying no responseSchema. Its job: guarantee that EVERY native HRIS connector
// either carries a read `responseSchema` (Phase 2 drift is live) or is explicitly queued below — so
// a connector can never silently ship with zero drift coverage. This is the "no coverage gap going
// forward" backstop.
import { NATIVE_HRIS_FUNCTIONS } from '../native-hris-functions';
import { NATIVE_HRIS_TYPES } from '../native-hris-types';
import type { ConnectorFunction } from '../../types';

// Connectors whose vendors publish NO fetchable spec AND whose success-response container shape is
// not yet confidently known (login/portal-gated docs, no public example payload). Hand-authoring a
// GUESSED responseSchema for these would risk false drift on live customer traffic, so drift for
// them waits on a Phase-4 CAPTURED sample to reveal the real top-level shape first. Capture still
// records their reads today (isNativeHrisServing is true once flipped), so this is a tracked backlog
// of schemas to backfill — not an untracked hole. Keeping the list here + test-enforced means the
// gap is explicit and cannot be silently widened.
const AWAITING_DRIFT_SCHEMA = new Set(['ukg_pro', 'ukg_ready']);

// A read tool = 'read' category and no mutating category. Excludes the `*_native_request`
// passthrough (categories: ['write']) automatically.
const isRead = (f: ConnectorFunction): boolean =>
  f.categories.includes('read') && !f.categories.some((c) => c === 'write' || c === 'destructive' || c === 'outbound');

describe('native HRIS drift coverage — every connector carries a read responseSchema or is explicitly queued', () => {
  it.each(NATIVE_HRIS_TYPES.map((t) => [t] as const))('%s', (t) => {
    const fns = NATIVE_HRIS_FUNCTIONS[t] ?? [];
    // The connector is actually wired into the native surface with at least one read (so Phase-4
    // capture has something to record even before a schema exists).
    expect(fns.length).toBeGreaterThan(0);
    const reads = fns.filter(isRead);
    expect(reads.length).toBeGreaterThan(0);

    const withSchema = reads.filter((f) => f.responseSchema);
    if (AWAITING_DRIFT_SCHEMA.has(t)) {
      // A known, capture-backfilled gap. Assert it stays a KNOWN gap: the moment a responseSchema is
      // added to one of its reads, this fails and forces the type OUT of the allowlist above — no
      // stale exemptions accumulate.
      expect(withSchema.length).toBe(0);
    } else {
      expect(withSchema.length).toBeGreaterThan(0);
    }
  });
});
