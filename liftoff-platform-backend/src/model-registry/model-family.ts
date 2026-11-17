// Which vendor family a model id belongs to, read from the id itself.
//
// Needed wherever a stored `provider` cannot be trusted to say. The four
// open-weight vendors were all stored as 'openrouter' — the gateway they are
// reached through — so the id is the only thing that distinguishes a GLM
// configuration from a Qwen one, and that is exactly what migration 450 has to
// know to move each row to the right family.
//
// The prefixes are DERIVED from the vendor record rather than listed. Every
// gateway-served id is `<publisher>/<model>`, and each vendor's own tier models
// already carry its publisher segment — so a vendor added to the record brings
// its namespace with it, and there is no second table to forget to update.

import { WORKSPACE_AI_VENDORS, type WorkspaceAiVendor } from './workspace-ai-vendors';

/** `<publisher>/` → the provider that publishes under it.
 *
 *  Built on first use, not at module load. This module and the vendor record
 *  import each other — the record needs the derivation to normalise a config,
 *  the derivation needs the record to know the publishers — and a cycle
 *  resolves with one side half-initialised. Reading WORKSPACE_AI_VENDORS at
 *  load time would read `undefined` in whichever order Node happens to pick,
 *  which is a crash at boot that a test run can easily not reproduce.
 *
 *  The registry overlay can replace a tier's model but not its publisher: an id
 *  under a different publisher is a different vendor's model, which is the one
 *  thing a tier override is not allowed to be. So building this once, whenever
 *  it is first asked for, is enough. */
let publisherToProvider: Map<string, string> | null = null;

function publishers(): ReadonlyMap<string, string> {
  if (publisherToProvider) return publisherToProvider;
  const out = new Map<string, string>();
  for (const vendor of Object.keys(WORKSPACE_AI_VENDORS) as WorkspaceAiVendor[]) {
    const spec = WORKSPACE_AI_VENDORS[vendor];
    for (const modelId of Object.values(spec.tiers)) {
      const slash = modelId.indexOf('/');
      if (slash <= 0) continue;
      out.set(modelId.slice(0, slash + 1), spec.provider);
    }
  }
  publisherToProvider = out;
  return out;
}

/**
 * The provider a model id belongs to, or undefined when the id names no
 * publisher this platform serves.
 *
 * Undefined rather than a guess. A caller deciding which family a stored
 * 'openrouter' row meant has a defined answer for the ids we publish and no
 * business inventing one for an id we do not — GLM is the right default THERE,
 * because GLM is what the gateway name resolved to, and that belongs in the
 * caller that knows it rather than here.
 */
export function providerOfModelId(modelId: string | null | undefined): string | undefined {
  if (!modelId) return undefined;
  for (const [prefix, provider] of publishers()) {
    if (modelId.startsWith(prefix)) return provider;
  }
  return undefined;
}
