// Canonical native-HRIS type sets — the single source of truth for "which connectors are
// served by a first-party HRIS client", used by the registry (tool loading), the offline
// verification tests, and the runtime drift/gate/capture hooks.
import { isNativeHrisConnector } from './source-overrides.js';

// Every connector backed by a native first-party HRIS client — i.e. every HRIS connector.
// Kept in sync with NATIVE_HRIS_CLIENT_TYPES in source-overrides.ts (a test asserts match).
export const NATIVE_HRIS_TYPES = [
  'workday', 'oracle_hcm', 'namely', 'sap_successfactors',
  'deel', 'factorial', 'hibob', 'personio', 'ukg_pro', 'ukg_ready', 'dayforce',
  'adp_run', 'adp_workforce_now',
  'gusto', 'rippling', 'bamboohr', 'warp',
] as const;
export type NativeHrisType = (typeof NATIVE_HRIS_TYPES)[number];

// Verification scope for the OFFLINE tests (request-conformance / fixtures / auth). Currently
// the full native set; kept as a distinct name so callers read as "verification scope" and the
// two can diverge later without touching test call sites.
export const NATIVE_HRIS_VERIFY_TYPES: readonly string[] = [...NATIVE_HRIS_TYPES];

const VERIFY = new Set(NATIVE_HRIS_VERIFY_TYPES);

/** True for any connector backed by a native first-party HRIS client — the offline verification
 *  scope (currently identical to NATIVE_HRIS_TYPES; the registry consumes the array directly). */
export function isNativeHrisVerifyType(t: string): boolean { return VERIFY.has(t); }

// Runtime-serving check: is this connector dispatched by a native first-party client?
// True for every HRIS connector. The runtime hooks (Phase 2 drift + Phase 4 capture) key on this.
export function isNativeHrisServing(t: string): boolean {
  return isNativeHrisConnector(t);
}
