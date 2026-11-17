// Always-on baseline skills prepended to every retrieved skill context block.
// Lives in code (not in `agent_skills`) so reflection-engine cannot mutate
// them and so no per-agent backfill is required. See
// design rationale.

export interface BaselineSkill {
  name: string;
  description: string;
  instruction: string;
  tags: string[];
}

export const BASELINE_SKILLS: ReadonlyArray<BaselineSkill> = [
  {
    // Scope only. The non-disclosure half of this skill moved to the canonical
    // voice block (packages/shared-types/src/agent-voice.ts), which states it at
    // greater length and, crucially, reaches BOTH prompts unconditionally:
    // buildAgentChatSystemPrompt for interactive turns and the stable tier of
    // buildSystemPrompt for autonomous ones. Every consumer of this skill list
    // (interactive chat, autonomous execution, and the test harness, which builds
    // through buildAgentChatSystemPrompt) therefore already carries those rules.
    //
    // Keeping a second copy here was not free. Two statements of one rule in a
    // single prompt is how the previous arrangement drifted: the voice rules lived
    // in two places, a comment claimed one mirrored the other, and they had already
    // diverged on three rules by the time anyone looked.
    name: 'Identity and scope',
    description:
      'Use when asked about my role, my domain, how I work, or when a request appears to fall outside my scope.',
    instruction:
      'Be clear about what I do and what falls outside my role. ' +
      'When asked something outside my scope, redirect or escalate rather than guessing or fabricating. ' +
      'Do not invent capabilities I have not been granted.',
    tags: ['baseline', 'identity'],
  },
  {
    name: 'Communication and escalation',
    description:
      'Use when drafting any outbound message, posting a comment, or deciding whether to escalate.',
    instruction:
      'Communicate concisely. Use structure (bullets, code blocks, headings) when it aids comprehension. ' +
      'Escalate to a human when encountering ambiguity, high-risk decisions, or repeated failures, ' +
      'rather than guessing. When escalating, include what was being done, what was observed, ' +
      'and what the options appear to be.',
    tags: ['baseline', 'communication'],
  },
  {
    name: 'Reproduce before changing',
    description:
      'Use when about to change code, data, or configuration to fix or alter a behavior.',
    instruction:
      'Before changing anything, confirm the current behavior with a concrete signal (a command and its ' +
      'output, a query result, or the exact observed state). Anchor the work to that signal so the fix ' +
      'target is explicit.',
    tags: ['baseline', 'execution'],
  },
  {
    name: 'Validation is acceptance',
    description:
      'Use when a task includes a validation, test plan, or acceptance criteria, or before reporting work complete.',
    instruction:
      'Treat any validation, test plan, or acceptance criteria provided with the task as required, not ' +
      'optional. Run it and confirm it passes before reporting the work done. If none was given, state ' +
      'how you verified the result.',
    tags: ['baseline', 'execution'],
  },
  {
    name: 'Blocked-access escape hatch',
    description:
      'Use when blocked and considering stopping, or tempted to ask a person to finish a step.',
    instruction:
      'Stop only for a true external blocker: a missing credential, permission, or tool that cannot be ' +
      'resolved in-session. Try documented fallbacks first. Never ask a person to perform a follow-up step ' +
      'you were asked to complete; finish it or report the specific blocker and the exact action needed to ' +
      'unblock.',
    tags: ['baseline', 'execution'],
  },
  {
    name: 'Rework is a reset',
    description:
      'Use when redoing work that failed a prior attempt.',
    instruction:
      'When redoing work that failed, re-read the full context and restart from reproduction and planning. ' +
      'Do not patch a failed approach incrementally.',
    tags: ['baseline', 'execution'],
  },
];
