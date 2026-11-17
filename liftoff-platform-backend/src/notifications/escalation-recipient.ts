// internal_agents.escalation_recipient is a prefixed selector — "user:<id>",
// "role:<role>" or "agent:<id>" — per migration 256.
//
// It was not being written that way. Team-preset provisioning validated the
// value against tenant_members.account_id and stored the bare UUID, which
// matches none of the three prefixes, so every consumer fell through: one
// logged "unrecognized recipient prefix" and dropped it, the other had no else
// branch at all and quietly resolved to an empty recipient list. Any agent
// provisioned with an escalation recipient was escalating into the void, and
// reporting success while doing it.
//
// Normalising here rather than only at the writer is deliberate: rows written
// before the fix can hold bare UUIDs, and a read-side normalise fixes them
// without a data migration.

/** A bare accounts.id, which is what team-preset provisioning has been storing. */
const BARE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KNOWN_PREFIXES = ['user:', 'role:', 'agent:'] as const;

/**
 * Coerce a stored escalation_recipient into the documented selector form.
 *
 * Returns null for anything unrecognisable, so callers must decide what to do
 * rather than silently resolving to nobody — which is the failure this exists
 * to prevent.
 */
export function normalizeEscalationRecipient(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (KNOWN_PREFIXES.some((p) => value.startsWith(p))) return value;
  // The historical shape: a bare account id means that person.
  if (BARE_UUID.test(value)) return `user:${value}`;
  return null;
}

/** Where escalations go when an agent names nobody, per migration 256. */
export const DEFAULT_ESCALATION_RECIPIENT = 'role:admin';
