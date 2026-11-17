/**
 * Pure utilities for connector identifier resolution.
 * Kept in a separate file so unit tests can import without pulling in
 * the heavy SDK / Express / DB dependencies of chat-turn-handler.ts.
 */

/** Derives connector identifiers from stored integrations for manifest lookup.
 *  Prefers the type string ('github') over UUID so SQL type-matching works;
 *  falls back to UUID so the SQL subquery can resolve it via the connectors table. */
export function deriveAllowedConnectors(
  integrations: Array<{ id: string; type?: string }>,
): string[] {
  return integrations.map(i => i.type || i.id).filter(Boolean);
}
