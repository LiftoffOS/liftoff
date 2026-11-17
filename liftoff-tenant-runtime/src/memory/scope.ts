// One shape for a memory scope, whichever shape the column happens to hold.
//
// `agents.memory_scope` here is a verbatim copy of the control plane's column:
// the create event carries `memoryScope` and `events/subscriber.ts` stringifies
// it straight in. The control plane's create path wrote that default in
// snake_case for years while every reader on both sides is camelCase — the
// `MemoryScope` types, `StandardToolContext.memoryScope`, the API schema — so
// `ctx.memoryScope.writableLayers` read undefined and the handlers fell back to
// hard-coded lists. Memory scoping was therefore never enforced as configured
// for any agent created through the hire flow.
//
// The control plane now writes and normalises camelCase, and a migration
// rewrites its rows. Neither reaches the copy already sitting in THIS database:
// it is refreshed only when an agent is next republished. So the read is
// normalised here as well, and an agent that has not been touched since works
// from today rather than from whenever it is next edited.

import type { MemoryLayer } from './types';

/** What an agent gets when its scope says nothing.
 *
 *  ONE list, because there were three and they disagreed about the layer that
 *  mattered: `memory_save` fell back to ['individual','conversation'], the
 *  second write path to ['individual'], and `memory_retrieve` to
 *  ['global','role','individual','conversation']. So an unscoped agent could
 *  READ `role` and not WRITE it — which is exactly how a graph that saved a
 *  weekly snapshot to `role` and read it back looked half-working: the write was
 *  refused every run, the read returned nothing, and neither said so.
 *
 *  `role` is excluded from both. It is shared by every agent of a role, so
 *  writing to it is a grant a template makes explicitly, never a default. */
export interface NormalizedMemoryScope {
  readableLayers?: MemoryLayer[];
  writableLayers?: MemoryLayer[];
  scopeKeys?: string[];
}

/** The four layers that exist. A stored scope naming anything else is naming
 *  nothing, and passing that on would let a typo read as a grant. */
const KNOWN_LAYERS: readonly MemoryLayer[] = ['global', 'role', 'individual', 'conversation'];

export const DEFAULT_MEMORY_SCOPE: Required<Pick<NormalizedMemoryScope, 'readableLayers' | 'writableLayers'>> = {
  readableLayers: ['global', 'individual', 'conversation'],
  writableLayers: ['individual', 'conversation'],
};

function memoryLayers(value: unknown): MemoryLayer[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is MemoryLayer =>
    typeof v === 'string' && KNOWN_LAYERS.includes(v as MemoryLayer));
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === 'string');
}

/**
 * Read a stored memory scope into the one shape every handler expects.
 *
 * Accepts either spelling per key. A key present in both takes the camelCase
 * one: that is the shape the type declares, and the only way to hold both is a
 * partial migration mid-flight.
 *
 * Returns `{}` — not the default — for a value that names no keys. The
 * handlers apply DEFAULT_MEMORY_SCOPE themselves, and an empty object is how
 * they have always been told "nothing was configured".
 */
export function normalizeMemoryScope(raw: unknown): NormalizedMemoryScope {
  const parsed: unknown = typeof raw === 'string'
    ? (() => { try { return JSON.parse(raw) as unknown; } catch { return null; } })()
    : raw;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const o = parsed as Record<string, unknown>;
  const readable = memoryLayers(o.readableLayers) ?? memoryLayers(o.readable_layers);
  const writable = memoryLayers(o.writableLayers) ?? memoryLayers(o.writable_layers);
  const scopeKeys = strings(o.scopeKeys) ?? strings(o.scope_keys);

  return {
    ...(readable ? { readableLayers: readable } : {}),
    ...(writable ? { writableLayers: writable } : {}),
    ...(scopeKeys ? { scopeKeys } : {}),
  };
}
