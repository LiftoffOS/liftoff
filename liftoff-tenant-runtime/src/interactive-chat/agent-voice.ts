// Re-export of the canonical voice block from @liftoffos/runtime-shared-types.
//
// The text itself lives in packages/shared-types/src/agent-voice.ts because two repos
// and one database row have to agree on it exactly. Redeclaring the string here would
// recreate the drift this change exists to remove: the previous arrangement had one
// copy baked into distilled prompts by platform-backend's distiller and a second copy
// hand-maintained in this repo's chat prompt, kept in step by a comment, and they had
// already diverged on three rules.
//
// Injected in two places, and both matter:
//   - buildAgentChatSystemPrompt (interactive chat), in place of the old hand-rolled
//     "## Writing style" section and the two no-disclosure bullets in "How to Interact".
//   - AgentExecutionService.buildSystemPrompt (autonomous), in the STABLE tier. It is
//     byte-identical on every run, so anywhere but `stable` breaks the cacheable prefix
//     on every single turn. See prompt-tiers.ts.
//
// Autonomous runs previously had NO voice rules at all: they relied on the distilled
// prompt carrying them, which the distiller was merely told to do, and nothing
// checked that it did.

export { AGENT_VOICE_BLOCK, AGENT_VOICE_BLOCK_SHA } from '@liftoffos/runtime-shared-types';
