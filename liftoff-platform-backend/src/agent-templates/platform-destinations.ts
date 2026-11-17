// Destinations the platform itself provides, for when no connector does.
//
// A template names a destination in prose — "Post the summary to
// {{pick:alert-channel}}" — and with nothing connected that resolves to the
// object's fallback phrase: "your engineering channel". The sentence still
// reads like an instruction, so the agent follows it, and reports posting to a
// place that does not exist and that it has no tool to reach.
//
// The fix is not to delete the step. The notice is often the only outward sign
// a run happened, and a team with no chat connector still needs to be told. So
// the platform provides one destination that is always there, and an object
// declaring `whenUnbound: 'platform_chat'` resolves to it instead of to a
// phrase naming nothing.
//
// Kept as its own module with no imports: both the distiller and the
// placeholder resolver need it, and the distiller reaches the rest of this
// directory through lazy requires to keep the generated proto enums off its
// module-load path.

/** Declared on an object whose destination the platform can always supply. */
export type PlatformDestination = 'platform_chat';

/**
 * What the sentence reads as when a `platform_chat` destination went unpicked.
 *
 * A bare noun phrase, because it is substituted into whatever frame the
 * template wrote: "Post the summary to X", "Notify X", "flag it in X", "a
 * brief in X". Anything carrying its own preposition breaks most of them.
 */
export const PLATFORM_CHAT_PHRASE = 'your chat in Liftoff';

/** The phrase an unpicked object resolves to, or its declared fallback. */
export function unpickedPhraseFor(obj: {
  fallback?: string;
  whenUnbound?: PlatformDestination;
}): string | undefined {
  if (obj.whenUnbound === 'platform_chat') return PLATFORM_CHAT_PHRASE;
  return obj.fallback;
}
