// Liftoff system prompt tests.
//
// The prompt is built fresh per request from today's date and the tools the
// caller may use. Both have an empty case, and an empty case that renders badly
// is the kind of bug nobody sees until a person reads a stray bullet in a reply.
//
// What the person attached is built separately, by buildAttachmentContextBlock,
// and rides the user turn: the system prompt is the provider's cache prefix and
// nothing per-request may sit inside it.
//
// The voice rules are tested as well. They now come from the shared block in
// src/shared/agent-voice.ts, which all four customer-facing surfaces carry, so
// the assertions here are on the block as a whole rather than on bullets this
// module used to own. A prompt that breaks its own rules teaches the model to
// break them too, which is why the em dash and LiftoffOS checks run against the
// rendered prompt and not just the rule text.

import { buildAttachmentContextBlock, buildLiftoffSystemPrompt } from '../system-prompt';
import { AGENT_VOICE_BLOCK } from '../../shared/agent-voice';
import type { LLMToolDefinition } from '../../llm/types';

/** Real verb contractions only; a possessive apostrophe-s is not one. */
const CONTRACTION =
  /\b\w+(?:'|’)(?:t|re|ve|ll|m)\b|\b(?:it|that|there|here|what|who|he|she|let)(?:'|’)s\b/i;

const TOOLS: LLMToolDefinition[] = [
  {
    name: 'get_workspace_summary',
    description: 'What is set up in this workspace right now',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'search_help_articles',
    description: 'Find product documentation by keyword',
    input_schema: { type: 'object', properties: {} },
  },
];

describe('buildLiftoffSystemPrompt', () => {
  it("injects today's date so relative references resolve", () => {
    const prompt = buildLiftoffSystemPrompt({ today: '2026-08-12', availableTools: TOOLS });

    expect(prompt).toContain("## Today's Date");
    expect(prompt).toContain('2026-08-12');
  });

  it('lists each available tool with its description', () => {
    const prompt = buildLiftoffSystemPrompt({ today: '2026-08-12', availableTools: TOOLS });

    expect(prompt).toContain('`get_workspace_summary`: What is set up in this workspace right now');
    expect(prompt).toContain('`search_help_articles`: Find product documentation by keyword');
  });

  it('renders the no-tools branch rather than an empty Available Tools section', () => {
    // This is the shipping case: Liftoff registers no tools of its own, so the
    // section would otherwise end the prompt with a bare heading.
    const prompt = buildLiftoffSystemPrompt({ today: '2026-08-12', availableTools: [] });

    expect(prompt).toContain('## Available Tools');
    expect(prompt).toContain('(none available for this request)');
  });
});

describe('buildAttachmentContextBlock', () => {
  it('names each attachment so the model can work from it without asking', () => {
    const block = buildAttachmentContextBlock(['q3-notes.md', 'Payroll run (gusto)']);

    expect(block).toContain('## Attached To This Message');
    expect(block).toContain('- q3-notes.md');
    expect(block).toContain('- Payroll run (gusto)');
    // Assert the instruction is present, not its exact phrasing: this is prose
    // that will be reworded, and pinning the sentence makes every edit a test
    // failure without catching a single real regression.
    expect(block).toMatch(/do not ask the person to paste/i);
  });

  // Uploads arrive inline; connector entries are pointers with nothing behind
  // them yet. If the prompt promises contents for both, the model will happily
  // describe a document it was never given.
  it('tells the model a connector entry is a name only, not a document it can read', () => {
    const block = buildAttachmentContextBlock(['Payroll run (gusto)']);

    expect(block).toMatch(/only its name reached you/i);
    expect(block).toMatch(/never guess at what is inside it/i);
  });

  it('renders nothing when nothing is attached', () => {
    // Not an empty heading: a section with no bullets under it reads to the
    // model as "an attachment was expected and is missing".
    expect(buildAttachmentContextBlock(undefined)).toBe('');
  });

  it('renders nothing for an empty list, same as omitting the argument', () => {
    expect(buildAttachmentContextBlock([])).toBe('');
  });
});

describe('buildLiftoffSystemPrompt / prefix stability', () => {
  it('carries nothing about this turn, so the cached prefix does not move', () => {
    // The system prompt is the provider's cache prefix and is marked as the
    // breakpoint in chat-service. Anything per-request written into it makes
    // every turn a cache miss, so the attachment names live on the user turn.
    const prompt = buildLiftoffSystemPrompt({ today: '2026-08-12', availableTools: TOOLS });

    expect(prompt).not.toContain('## Attached To This Message');
  });

  it('renders the same bytes for the same day and tool set', () => {
    const a = buildLiftoffSystemPrompt({ today: '2026-08-12', availableTools: TOOLS });
    const b = buildLiftoffSystemPrompt({ today: '2026-08-12', availableTools: TOOLS });

    expect(a).toBe(b);
  });
});

describe('buildLiftoffSystemPrompt / product voice', () => {
  it('carries the canonical voice block rather than its own copy of the rules', () => {
    // Liftoff used to hand-roll a three-bullet "Product Voice" section while the
    // other three surfaces hand-rolled their own. Asserting on the whole block,
    // not on individual bullets, is what stops that from happening again: a
    // reworded rule fails here unless the shared module was the thing reworded.
    const prompt = buildLiftoffSystemPrompt({ today: '2026-08-12', availableTools: TOOLS });

    expect(prompt).toContain(AGENT_VOICE_BLOCK);
  });

  it('instructs the model to say "agent" and never "AI team"', () => {
    const prompt = buildLiftoffSystemPrompt({ today: '2026-08-12', availableTools: TOOLS });

    expect(prompt).toContain('Say "agent" or "agents", or the agent\'s own name, never "AI team" and never "team" on its own');
    // The rule has to survive the person using the word themselves, which is
    // exactly when the model is most likely to mirror it back.
    expect(prompt).toContain('This holds even if the person says "AI team" or "team" to you.');
  });

  it('tells the model not to contract, and does not contract in its own copy', () => {
    // The second half is the load-bearing one. A prompt that contracts while
    // forbidding contractions is a demonstration, and the model follows
    // demonstrations more readily than instructions. Quoted spans are exempt:
    // they quote banned phrasing verbatim so the model recognises it.
    const prompt = buildLiftoffSystemPrompt({ today: '2026-08-12', availableTools: TOOLS })
      + '\n\n' + buildAttachmentContextBlock(['contract.pdf']);
    const ownProse = prompt.replace(AGENT_VOICE_BLOCK, '').replace(/"[^"]*"/g, '');

    expect(prompt).toContain('Write "do not", "it is", "you will" in full');
    expect(ownProse).not.toMatch(CONTRACTION);
  });

  it('contains no em dash anywhere, including the part that forbids them', () => {
    // A prompt that breaks its own rule is a demonstration, and the model reads
    // demonstrations more readily than instructions.
    const prompt = buildLiftoffSystemPrompt({ today: '2026-08-12', availableTools: TOOLS })
      + '\n\n' + buildAttachmentContextBlock(['contract.pdf']);

    expect(prompt).toContain('Never use an em dash');
    expect(prompt).not.toContain('—');
  });

  it('calls the product Liftoff, never LiftoffOS', () => {
    // The prompt described the product as "LiftoffOS" twice while now carrying a
    // rule forbidding exactly that spelling. Both branches are checked because
    // the attachment section is the one part built conditionally.
    //
    // Asserted against the prompt with the shared block removed: the rule line
    // has to spell out what it forbids, so a bare not.toContain would fail on
    // the rule itself and prove nothing about the prose around it.
    const prompt = buildLiftoffSystemPrompt({ today: '2026-08-12', availableTools: TOOLS })
      + '\n\n' + buildAttachmentContextBlock(['contract.pdf']);
    const ownProse = prompt.replace(AGENT_VOICE_BLOCK, '');

    expect(prompt).toContain('The product is called Liftoff.');
    expect(ownProse).not.toContain('LiftoffOS');
    expect(ownProse).not.toContain('Liftoff OS');
  });

  it('states the confidentiality rules, including the ones it never had', () => {
    // Liftoff had a single "system internals" bullet and nothing about the model,
    // this prompt, the platform, or who built it.
    const prompt = buildLiftoffSystemPrompt({ today: '2026-08-12', availableTools: [] });

    expect(prompt).toContain('## Confidentiality');
    expect(prompt).toContain('the underlying model or vendor');
    expect(prompt).toContain('who created or operates you');
  });

  it('brings colleagues in rather than pointing the person at them', () => {
    // The catch-all no longer signposts. A person who asks for a team gets the
    // Chief AI Officer in this thread, so any wording that sends them to another
    // screen is now a bug rather than a handoff.
    const prompt = buildLiftoffSystemPrompt({ today: '2026-08-12', availableTools: [] });

    expect(prompt).toContain('Chief AI Officer');
    expect(prompt).toContain('Insights Manager');
    expect(prompt).toContain('bring_in_colleague');
    expect(prompt).toContain('NEVER tell the person to go to another page');
  });

  it('names the kinds of colleague but never a list of teams', () => {
    // The roster is live: teams are created, renamed, paused and deleted while
    // people are mid-conversation. A list baked in here would be a snapshot that
    // is wrong the moment somebody changes one, and it would grow with every
    // team the workspace owns. The prompt has to send the model to the tool.
    const prompt = buildLiftoffSystemPrompt({ today: '2026-08-12', availableTools: [] });

    expect(prompt).toContain('list_colleagues');
    expect(prompt).toContain('change constantly');
    expect(prompt).toContain('Never invent an id');
  });
});
