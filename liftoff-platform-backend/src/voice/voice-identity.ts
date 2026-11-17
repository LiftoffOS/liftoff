// Which voice a team member speaks with.
//
// An agent's voice is part of how someone recognises it, so it has to be stable:
// the same team member must sound the same tomorrow, and two team members in one
// thread must not sound identical. It also has to survive a vendor change, since
// the speaking lane is a config edit away from moving.
//
// So the agent stores no voice at all. It has a SLOT — a number derived from its
// id — and each vendor publishes an ordered pool that the slot indexes into.
// Switching vendor keeps every team member's position in the ordering, so the
// cast changes voices together rather than being reshuffled at random.
//
// Deriving the slot rather than storing it also means a new agent has a voice the
// moment it exists, with no column, no migration, and no backfill.

import type { VoiceVendorKey } from './vendors';

/**
 * Curated, ordered voice pools.
 *
 * Curated rather than "whatever the API lists": the full Chirp 3: HD set for
 * en-US is 30 voices and they are not equally good at reading a work reply
 * aloud. Order is deliberate — consecutive slots alternate perceived gender, so
 * the second agent to speak in a thread sounds clearly distinct from the first
 * rather than merely different.
 *
 * Verified against the live voices API 2026-08-06.
 */
const VOICE_POOLS: Partial<Record<VoiceVendorKey, readonly string[]>> = {
  google: [
    'en-US-Chirp3-HD-Kore',
    'en-US-Chirp3-HD-Charon',
    'en-US-Chirp3-HD-Aoede',
    'en-US-Chirp3-HD-Puck',
    'en-US-Chirp3-HD-Leda',
    'en-US-Chirp3-HD-Orus',
    'en-US-Chirp3-HD-Zephyr',
    'en-US-Chirp3-HD-Fenrir',
    'en-US-Chirp3-HD-Callirrhoe',
    'en-US-Chirp3-HD-Iapetus',
    'en-US-Chirp3-HD-Despina',
    'en-US-Chirp3-HD-Umbriel',
  ],
  // gpt-4o-mini-tts accepts all thirteen built-in voices, including the four
  // (ballad, verse, marin, cedar) that the tts-1 models reject. The pool matches
  // the configured model, so a model change is also a pool review.
  //
  // Ordered like the Google pool so a vendor switch keeps each team member's
  // position, which is the whole reason a slot indexes a pool rather than a
  // voice being stored on the agent.
  openai: [
    'nova',
    'onyx',
    'shimmer',
    'echo',
    'coral',
    'fable',
    'sage',
    'ash',
    'ballad',
    'verse',
    'marin',
    'cedar',
  ],
};

/**
 * The voice platform surfaces speak with.
 *
 * The Chief AI Officer chat and workspace insights are the platform talking, not
 * a team member, and they should not borrow a colleague's voice. Held outside
 * the pool so no agent is ever assigned it.
 */
const PLATFORM_VOICES: Partial<Record<VoiceVendorKey, string>> = {
  google: 'en-US-Chirp3-HD-Achernar',
  openai: 'alloy',
};

/**
 * A stable slot for an agent id.
 *
 * FNV-1a, chosen because it is deterministic across processes and releases.
 * `Math.random`, insertion order, or anything derived from a hash of the object
 * would give an agent a different voice after a restart.
 */
export function voiceSlotFor(agentId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < agentId.length; i++) {
    hash ^= agentId.charCodeAt(i);
    // The FNV prime, by shift-add so the arithmetic stays in 32 bits.
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The voice a given speaker uses on a given vendor.
 *
 * `agentId` absent means a platform surface is speaking.
 *
 * Throws when the vendor publishes no pool, matching how the lane registry
 * refuses a vendor with no adapter: a wrong-but-plausible voice is worse than a
 * loud failure, because nobody would report it as a bug.
 */
export function voiceFor(vendor: VoiceVendorKey, agentId: string | undefined): string {
  if (!agentId) {
    const platform = PLATFORM_VOICES[vendor];
    if (!platform) throw new Error(`Vendor '${vendor}' publishes no platform voice`);
    return platform;
  }

  const pool = VOICE_POOLS[vendor];
  if (!pool || pool.length === 0) {
    throw new Error(`Vendor '${vendor}' publishes no voice pool`);
  }
  return pool[voiceSlotFor(agentId) % pool.length] as string;
}
