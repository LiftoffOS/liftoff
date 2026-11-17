// Which family a model id belongs to, read from the id itself.
//
// Needed wherever a stored `provider` cannot be trusted to say. The four
// open-weight families were all stored as 'openrouter' — the gateway they are
// reached through — so for every configuration written before the control
// plane's migration 450, the model id is the ONLY thing that distinguishes a
// Qwen agent from a GLM one.
//
// It is not only history. A gateway-served id names its publisher, and that is
// a more reliable statement about what a call IS than a provider field that a
// caller may have written from an older vocabulary.

import { OPEN_WEIGHTS_ENGINE, VENDORS } from './vendors';
import type { ResolvedProvider } from './types';

/** `<publisher>/` → the family that publishes under it.
 *
 *  Hand-written, and the only such list here, because a publisher segment is a
 *  fact about the vendor's naming rather than something this record already
 *  holds: `VENDORS` carries no model ids, so there is nothing to derive it
 *  from. Kept honest by a test that resolves every tier model each provider
 *  publishes back to that provider.
 *
 *  Grok is absent deliberately. Its ids are NATIVE (`grok-4.6`) because it is
 *  reached on api.x.ai, so it has no publisher segment to match — and its
 *  OpenRouter slug (`x-ai/`) is a form no configuration here writes any more. */
const PUBLISHER_FAMILY: ReadonlyArray<readonly [string, ResolvedProvider]> = [
  ['z-ai/', 'glm'],
  ['qwen/', 'qwen'],
  ['deepseek/', 'deepseek'],
  ['moonshotai/', 'kimi'],
  ['minimax/', 'minimax'],
];

/** What the gateway's name used to resolve to.
 *
 *  GLM, because the single OpenRouter tier map published GLM models — so a
 *  configuration that said 'openrouter' and pinned nothing ran GLM, and moving
 *  it anywhere else would change which model that agent runs. */
export const GATEWAY_DEFAULT_FAMILY: ResolvedProvider = 'glm';

/** The family a model id belongs to, or undefined when it names no publisher
 *  this runtime serves.
 *
 *  Undefined rather than a guess: a caller that knows it is resolving a stored
 *  gateway name has a defined fallback (`GATEWAY_DEFAULT_FAMILY`), and one that
 *  does not has no business being handed one. */
export function familyOfModelId(modelId: string | null | undefined): ResolvedProvider | undefined {
  if (!modelId) return undefined;
  for (const [prefix, family] of PUBLISHER_FAMILY) {
    if (modelId.startsWith(prefix)) return family;
  }
  return undefined;
}

/** A family reached through the OpenRouter gateway.
 *
 *  Derived from the vendor record at the TYPE level as well as at runtime: a
 *  family is gateway-served exactly when it runs on the gateway's SHARED engine
 *  record — one transport, one key, one flag — and nothing has to restate
 *  which five those are. Written out, that list said 'openrouter' where it
 *  meant GLM.
 *
 *  The record's IDENTITY, not its engine id. It used to be the id: a family
 *  was gateway-served when its default engine was the gateway's wire engine.
 *  That stopped being a distinguishing fact the day Grok moved onto opencode
 *  from its own account — the same engine id, a different transport — and an
 *  id-keyed derivation would have read every family as gateway-served or none. */
export type GatewayFamily = {
  [K in keyof typeof VENDORS]:
    (typeof VENDORS)[K]['engine'] extends typeof OPEN_WEIGHTS_ENGINE ? K : never;
}[keyof typeof VENDORS];

export const GATEWAY_SERVED_FAMILIES: readonly GatewayFamily[] = (
  Object.keys(VENDORS) as ResolvedProvider[]
).filter((p) => VENDORS[p].engine === OPEN_WEIGHTS_ENGINE) as GatewayFamily[];

/** Whether a run on this provider goes through the OpenRouter gateway. */
export function isGatewayServed(provider: ResolvedProvider): provider is GatewayFamily {
  return (GATEWAY_SERVED_FAMILIES as readonly string[]).includes(provider);
}
