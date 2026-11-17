// The schema a consumer PUBLISHES for an overlaid tool: the contract the
// agent is held to, which is not the vendor's.
//
// A vendor schema describes what Composio's tool accepts. The overlay's
// translateInput sits between the agent and that tool, supplying some
// arguments itself and mapping the rest, so the arguments an agent must send
// are the vendor's minus what the overlay supplies — and the descriptions the
// vendor left blank are the ones the model most needs. Publishing the vendor
// schema verbatim advertised `user_id` as required on every Gmail tool while
// the overlay wrote 'me' over whatever arrived, and the distiller, validating
// against the published schema, rejected calls the runtime would have
// dispatched. One derivation, owned here, so every consumer publishes the same
// contract and the package's own tests can hold the translators to it.

import type { ComposioToolOverlay, ComposioVendorSchema } from './types';

export type PublishedInputSchema = ComposioVendorSchema['inputSchema'];

export function agentFacingInputSchema(
  vendor: PublishedInputSchema,
  overlay: Pick<ComposioToolOverlay, 'overlayOwnedArgs' | 'defaultedArgs' | 'argDescriptions'>,
): PublishedInputSchema {
  const owned = new Set(overlay.overlayOwnedArgs ?? []);
  const defaulted = new Set(overlay.defaultedArgs ?? []);
  const descriptions = overlay.argDescriptions ?? {};

  const properties: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(vendor.properties ?? {})) {
    if (owned.has(name)) continue;
    const description = descriptions[name];
    properties[name] = description && def && typeof def === 'object'
      ? { ...(def as Record<string, unknown>), description }
      : def;
  }

  const required = (vendor.required ?? []).filter((name) => !owned.has(name) && !defaulted.has(name));

  return {
    ...vendor,
    properties,
    ...(vendor.required !== undefined ? { required } : {}),
  };
}
