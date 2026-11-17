// Re-export of the canonical voice block from @liftoffos/shared-types.
//
// The text itself lives in packages/shared-types/src/agent-voice.ts because two
// repos and one database row have to agree on it exactly, and that package is this
// estate's mechanism for a contract that crosses a repo boundary. Redeclaring the
// string here would recreate the drift this whole change exists to remove.
//
// This file exists so callers inside src/ import from a path that matches every
// other shared helper, and so there is one place to look when tracing where the
// rules come from.
//
// Consumers: src/liftoff/system-prompt.ts, src/insights/tools/system-prompt.ts, and
// migration 509 (which embeds the same text into the Chief AI Officer's seeded row,
// pinned by scripts/__tests__/caio-prompt-voice-sync.test.ts).

export { AGENT_VOICE_BLOCK, AGENT_VOICE_BLOCK_SHA } from '@liftoffos/shared-types';
