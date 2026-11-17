// One shape for a memory scope, whichever shape the column happens to hold.
//
// The column has held TWO. Every type, schema and reader in both repositories
// is camelCase — `MemoryScope` here and in the tenant runtime, the router's Zod
// gate, the template catalog's `defaultMemoryScope`, `StandardToolContext` —
// and the create path wrote the default in snake_case:
//
//     JSON.stringify(input.memoryScope || { readable_layers: [...], writable_layers: [...] })
//
// `parseJsonb` returns valid JSON AS IS, so its camelCase fallback could not
// fire and the snake_case object was handed on cast as `MemoryScope`. TypeScript
// cannot see that: the cast is the whole point of the helper. The value then
// travelled verbatim through the create event into the tenant runtime's own
// `agents.memory_scope`, where `ctx.memoryScope.writableLayers` read undefined
// and the handler fell back to a hard-coded list.
//
// So an agent created through the hire flow by that writer does not have its
// memory scope enforced as configured. Only agents seeded by a different path,
// such as the system agents, carry the readable shape, and the `role` layer
// goes unwritten.
//
// Normalising on READ rather than only fixing the writer is deliberate. A
// backfill fixes the rows that exist; this fixes the rows that exist, the ones
// any other writer produces later, and the ones already sitting in the tenant
// runtime's copy that no migration here can reach.

import type { MemoryScope } from './types';

/** What an agent gets when nothing else says otherwise.
 *
 *  Deliberately excludes `role`. That layer is shared by every agent of a role,
 *  so writing to it is a grant a template makes explicitly
 *  (`defaultMemoryScope: {writableLayers: [role]}`), never something a default
 *  hands out. */
export const DEFAULT_MEMORY_SCOPE: MemoryScope = Object.freeze({
  readableLayers: Object.freeze(['global', 'individual']),
  writableLayers: Object.freeze(['individual']),
}) as MemoryScope;

/** A fresh, mutable copy. The constant is frozen and its arrays are shared, so
 *  handing it out directly would let one caller's edit reach every other. */
function defaultScope(): MemoryScope {
  return {
    readableLayers: [...(DEFAULT_MEMORY_SCOPE.readableLayers ?? [])],
    writableLayers: [...(DEFAULT_MEMORY_SCOPE.writableLayers ?? [])],
  };
}

type LayerArray = MemoryScope['readableLayers'];

function layers(value: unknown): LayerArray | undefined {
  if (!Array.isArray(value)) return undefined;
  const clean = value.filter((v): v is string => typeof v === 'string');
  return clean.length === value.length ? (clean as LayerArray) : (clean as LayerArray);
}

/**
 * Read a stored memory scope into the one shape everything downstream expects.
 *
 * Accepts either spelling per key, so a row written by the old create default
 * and a row written through the API both come out camelCase. A key present in
 * both spellings takes the camelCase one: that is the shape the type declares,
 * and the only way to have both is a partial migration mid-flight.
 *
 * Returns the default for null, a non-object, or an object naming none of the
 * keys — the same reading `parseJsonb`'s fallback intended and never delivered.
 */
export function normalizeMemoryScope(raw: unknown): MemoryScope {
  const parsed: unknown = typeof raw === 'string'
    ? (() => { try { return JSON.parse(raw) as unknown; } catch { return null; } })()
    : raw;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return defaultScope();
  }

  const o = parsed as Record<string, unknown>;
  const readable = layers(o.readableLayers) ?? layers(o.readable_layers);
  const writable = layers(o.writableLayers) ?? layers(o.writable_layers);
  const scopeKeys = layers(o.scopeKeys) ?? layers(o.scope_keys);

  // An object that names none of them is not a scope, whatever else it holds.
  if (!readable && !writable && !scopeKeys) return defaultScope();

  return {
    ...(readable ? { readableLayers: readable } : {}),
    ...(writable ? { writableLayers: writable } : {}),
    ...(scopeKeys ? { scopeKeys: scopeKeys as string[] } : {}),
  };
}
