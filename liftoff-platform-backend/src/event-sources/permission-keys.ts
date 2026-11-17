// Self-declared permission-key stripping.
//
// Inbound payloads authored by an external party (a GitHub webhook body, a
// custom-event body) must not be able to grant themselves authority by simply
// including keys like `permissions`, `role`, `auto_approve`, or `bypass_*`. Both
// the canonical-envelope sanitizer (envelope.ts) and any producer that publishes
// external content directly (the GitHub webhook router) strip these keys before
// the payload enters agent context. `__proto__` doubles as a prototype-pollution
// defense.

export const STRIP_KEYS_EXACT = new Set([
  'approval_required',
  'auto_approve',
  'permissions',
  'scopes',
  'policy',
  'role',
  'admin',
  'is_admin',
  '_meta',
  '__proto__',
]);

export const STRIP_KEY_PREFIXES = ['bypass_', 'override_', 'system_'];

export function shouldStripPermissionKey(key: string): boolean {
  if (STRIP_KEYS_EXACT.has(key)) return true;
  for (const prefix of STRIP_KEY_PREFIXES) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Recursively remove self-declared permission keys from a value, returning a new
 * value and whether anything was removed. Only object keys are affected; string,
 * number, and boolean leaves pass through unchanged (unlike the envelope scrubber,
 * which also rewrites string content). Arrays are mapped element-wise.
 */
export function stripPermissionKeys(v: unknown): { value: unknown; changed: boolean } {
  const state = { changed: false };
  const value = strip(v, state);
  return { value, changed: state.changed };
}

function strip(v: unknown, state: { changed: boolean }): unknown {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map((item) => strip(item, state));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
      if (shouldStripPermissionKey(key)) {
        state.changed = true;
        continue;
      }
      out[key] = strip(value, state);
    }
    return out;
  }
  return v;
}
