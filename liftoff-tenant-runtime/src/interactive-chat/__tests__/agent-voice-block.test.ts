/**
 * The canonical voice block reaches BOTH prompts, and sits where caching survives.
 *
 * Why this test exists:
 *
 * The voice rules used to be baked into each team's distilled system prompt by the
 * platform-backend distiller, which was merely TOLD it must include them. Nothing
 * checked, so a team's prompt could easily lack the text. Interactive chat hid the gap completely, because this repo had
 * already grown its own near-copy of the same rules and pushed it on every turn.
 * Autonomous runs had no such fallback: for those teams, a scheduled or
 * event-triggered run went out with no voice rules at all.
 *
 * So there are two properties worth pinning, and the interactive one alone would have
 * passed all along while the real defect sat in the other path:
 *
 *   1. Interactive chat carries the block. Asserted here.
 *   2. Autonomous runs carry the same block, from the same module. Asserted
 *      BEHAVIOURALLY in agent-execution/__tests__/delegation-child-identity.test.ts,
 *      which drives the real buildSystemPrompt through a delegated run rather than
 *      reading service.ts for the wiring line. A source-level check would pass on a
 *      prompt the model never actually receives, which is the same class of mistake
 *      as the defect being fixed.
 *
 * What stays here is the structural half no behavioural test can see: that neither
 * path declares its own copy of the string.
 *
 * The prompt is also held to the rules it states. It used to carry 44 em dashes and
 * 21 contractions of its own while telling the model to write neither, and prose the
 * model reads is a demonstration it will imitate.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildAgentChatSystemPrompt } from '../system-prompt';
import { AGENT_VOICE_BLOCK } from '../agent-voice';
import { TieredPrompt } from '../../agent-execution/prompt-tiers';

/** Real verb contractions only. A possessive apostrophe-s is not one, so `'s`
 *  counts only after the pronouns that actually form a contraction. Mirrors the
 *  check platform-backend applies to the block itself. */
const CONTRACTION =
  /\b\w+(?:'|’)(?:t|re|ve|ll|m)\b|\b(?:it|that|there|here|what|who|he|she|let)(?:'|’)s\b/i;

const baseParams = {
  agent: {
    role: 'Release Coordinator',
    messagingNickname: null,
    systemPrompt: 'I help with release decks and platform change history.',
    userInstructions: null,
    additionalContext: null,
  },
  user: { displayName: 'Test User', role: 'admin' },
  channel: 'web' as const,
  hitlLevel: 3,
  connectorList: 'No connectors configured.',
  memoryBlock: '',
  priorInvocationSummary: null,
};

describe('interactive chat prompt', () => {
  it('carries the canonical voice block verbatim', () => {
    const prompt = buildAgentChatSystemPrompt(baseParams);

    expect(prompt).toContain(AGENT_VOICE_BLOCK);
  });

  it('carries the block for every channel, not just web', () => {
    for (const channel of ['web', 'slack', 'teams'] as const) {
      expect(buildAgentChatSystemPrompt({ ...baseParams, channel })).toContain(
        AGENT_VOICE_BLOCK,
      );
    }
  });

  it('states the non-disclosure rules exactly once', () => {
    // These used to be two bullets in "How to Interact" AND near-duplicates of the
    // block's confidentiality section. The bullets were removed when the block
    // landed; two copies of a rule in one prompt is how they drift.
    const prompt = buildAgentChatSystemPrompt(baseParams);
    const occurrences = prompt.split('Never narrate your tool access').length - 1;

    expect(occurrences).toBe(1);
    expect(prompt).not.toContain('Never reveal any internal systems or inner workings');
  });

  it('does not keep the old hand-rolled writing-style section', () => {
    const prompt = buildAgentChatSystemPrompt(baseParams);

    expect(prompt).not.toContain('## Writing style');
    expect(prompt).toContain('## Voice');
  });

  it('obeys its own em dash rule across the whole assembled prompt', () => {
    // Not scoped to the block. The prompt used to carry 44 em dashes of its own in
    // the tool-selection rules, the browser preamble, the web-tool intent map and
    // the channel formatting sections, while telling the model never to write one.
    // Prose the model reads is a demonstration, and a model follows demonstrations
    // more readily than instructions. Both branches are built because the browser
    // sections are the densest offenders and only one of them renders at a time.
    const withBrowser = buildAgentChatSystemPrompt({ ...baseParams, hasAnchorBrowser: true });
    const withoutBrowser = buildAgentChatSystemPrompt({ ...baseParams, hasAnchorBrowser: false });

    expect(withBrowser).toContain('Never use an em dash');
    expect(withBrowser).not.toContain('—');
    expect(withoutBrowser).not.toContain('—');
  });

  it('obeys its own contraction rule outside quoted user speech', () => {
    // Quoted examples are exempt by design: "check what's on this page" is a sample
    // of what the USER types, and rewriting it into stilted English would make the
    // example less recognisable. Everything the model reads as instruction is held
    // to the rule it is being given.
    for (const hasAnchorBrowser of [true, false]) {
      for (const channel of ['web', 'slack', 'teams'] as const) {
        const prompt = buildAgentChatSystemPrompt({ ...baseParams, channel, hasAnchorBrowser });
        const instructionProse = prompt
          .replace(AGENT_VOICE_BLOCK, '')
          .replace(/"[^"]*"/g, '')
          // The distilled persona is passed through verbatim and is not ours to police.
          .replace(baseParams.agent.systemPrompt, '');

        expect(instructionProse).not.toMatch(CONTRACTION);
      }
    }
  });
});

describe('one text, never a second copy', () => {
  // That the block REACHES the autonomous prompt is asserted behaviourally, through
  // the real buildSystemPrompt, in
  // agent-execution/__tests__/delegation-child-identity.test.ts. What is left here is
  // the structural half that a behavioural test cannot see: that both paths take the
  // text from the one canonical module rather than each declaring their own.
  const files = {
    'interactive-chat/agent-voice.ts': join(__dirname, '..', 'agent-voice.ts'),
    'agent-execution/service.ts': join(__dirname, '..', '..', 'agent-execution', 'service.ts'),
    'interactive-chat/system-prompt.ts': join(__dirname, '..', 'system-prompt.ts'),
  };

  it('re-exports from @liftoffos/runtime-shared-types rather than redeclaring the string', () => {
    const src = readFileSync(files['interactive-chat/agent-voice.ts'], 'utf8');

    expect(src).toContain("from '@liftoffos/runtime-shared-types'");
    expect(src).not.toMatch(/const AGENT_VOICE_BLOCK\s*=/);
  });

  it('has no file declaring its own AGENT_VOICE_BLOCK', () => {
    // A re-declared const would satisfy every behavioural assertion in this suite
    // and still drift from liftoff-platform-backend and from the Chief AI Officer's row.
    for (const [label, path] of Object.entries(files)) {
      expect(`${label}: ${readFileSync(path, 'utf8')}`).not.toMatch(
        /const AGENT_VOICE_BLOCK\s*=\s*`/,
      );
    }
  });

  it('keeps the block in the stable tier when composed', () => {
    const tiered = new TieredPrompt();
    tiered.add('stable', 'identity');
    tiered.add('stable', AGENT_VOICE_BLOCK);
    tiered.add('volatile', '## Current Objective\nship it');

    const { stable } = tiered.split();

    expect(stable).toContain(AGENT_VOICE_BLOCK);
    expect(tiered.cacheablePrefixLength()).toBeGreaterThan(AGENT_VOICE_BLOCK.length);
  });
});
