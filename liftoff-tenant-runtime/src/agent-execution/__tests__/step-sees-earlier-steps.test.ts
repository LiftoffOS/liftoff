// A step must be able to see the steps its description names.
//
// A prompt that carries only an `llm_reason` step's IMMEDIATE predecessor's
// output is not enough. The distiller routinely authors descriptions that name
// steps further back, because that is how the work decomposes: fetch the
// record, gather context, then judge over both. A support triage step can open
//
//   "Using the full thread from s1 and the sender's prior messages from s2,
//    categorize this email ... counted from the s1 message history"
//
// and s1 is two hops away, so it would not be in the prompt. The step would be
// told to reason over a value it cannot see.
//
// If s1 reads the customer's thread successfully, s2's sender lookup fails, and
// s3 is handed only s2's empty result, s3 reports precisely what it has —
//
//   "no body text, and no sender address. Cannot determine issue content —
//    sender identity and message body were both null in the workflow input"
//
// — routes itself to escalation, and a human is asked to read an email the
// agent had already fetched a step earlier. Later steps never run, because
// routing has already given up.
//
// The registry holds the value the whole time: `stepOutputs[<id>]` is written
// for every step that produces one, which is why `{{steps.<id>.<field>}}`
// templates and `$.steps.<id>` conditions can read it. Only such a prompt
// cannot.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

/** The reasoning-step method, from its declaration to the prompt's join. */
const invokeStepLLM = SRC.slice(
  SRC.indexOf('  private async invokeStepLLM('),
  SRC.indexOf("    ].join('\n');", SRC.indexOf('  private async invokeStepLLM(')),
);

const stepPrompt = invokeStepLLM.slice(invokeStepLLM.indexOf('const systemPrompt = [\n      `You are executing step'));

describe('the step prompt carries earlier steps', () => {
  it('renders the section built from the accumulated registry', () => {
    expect(invokeStepLLM).toContain("Object.keys(stepOutputs ?? {})");
    expect(invokeStepLLM).toContain('renderEarlierOutputs(');
    expect(stepPrompt).toContain('earlierSection.text');
  });

  it('does not repeat the predecessor, which has its own fuller rendering — excluded by id, never by value', () => {
    // The prior step is shown above with the offload path for a value too large
    // to inline. Printing it twice would spend the budget on a duplicate. An
    // exclusion by value mistook any earlier step whose value happened to equal
    // the predecessor's for the predecessor itself.
    expect(invokeStepLLM).toContain('id !== priorStepId');
    expect(invokeStepLLM).not.toContain('v !== stepOutput');
  });

  it('drops steps that produced nothing rather than printing undefined', () => {
    expect(invokeStepLLM).toContain('stepOutputs?.[id] !== undefined');
  });

  it('is bounded by its own ceiling, and never by the positional cut', () => {
    // The section's bound is the ceiling on its rendered text. The
    // deterministic bound stays for the two genuinely unbounded scalars in this
    // prompt and is not applied to the section: its answer to a small overflow
    // was to cut every string in the section to 200 characters.
    expect(invokeStepLLM).toContain('ceiling: EARLIER_OUTPUTS_BUDGET');
    expect(stepPrompt).not.toContain('Earlier step outputs (by step id): ${truncateForPrompt(');
    expect(stepPrompt).toContain('truncateForPrompt(runObjective, WORKFLOW_INPUT_BUDGET)');
    expect(stepPrompt).toContain('truncateForPrompt(inputData ?? {}, WORKFLOW_INPUT_BUDGET)');
  });

  it('emits nothing at all when there are no earlier steps', () => {
    // The first step of a graph must not gain an empty section.
    expect(invokeStepLLM).toContain('earlierEntries.length === 0\n      ? null');
    expect(stepPrompt).toContain('...(earlierSection ? [earlierSection.text] : [])');
  });

  it('selects before it materialises, and only for what the plan admitted', () => {
    const planAt = invokeStepLLM.indexOf('planEarlierOutputs(');
    const prepareAt = invokeStepLLM.indexOf('await prepareView(');
    expect(planAt).toBeGreaterThan(-1);
    expect(prepareAt).toBeGreaterThan(planAt);
    expect(invokeStepLLM).toContain('for (const id of plan.full) {');
    expect(invokeStepLLM).toContain('if (entry.chars <= STEP_OUTPUT_BUDGET) continue;');
  });

  it('fails closed for a complete-required earlier result this step names that did not fit and could not be parked', () => {
    expect(invokeStepLLM).toContain('entry.mustBeWhole && !view.offloaded && referenced.includes(id)');
    expect(invokeStepLLM).toContain('needs the complete result of ${entry.producedBy} (step "${id}")');
  });

  it('measures the section', () => {
    expect(invokeStepLLM).toContain('recordEarlierOutputsSection(step.stepId, {');
    expect(invokeStepLLM).toContain('objectiveChars: resolvedObjective.length');
  });

  it('still carries everything it carried before', () => {
    expect(stepPrompt).toContain('Step objective:');
    expect(stepPrompt).toContain('Request being served:');
    expect(stepPrompt).toContain("Prior step's output:");
    expect(stepPrompt).toContain('Workflow input:');
    expect(stepPrompt).toContain('AGENT_VOICE_BLOCK');
  });
});

describe('the registry is actually handed over', () => {
  it('invokeStepLLM accepts it, with the predecessor\'s id and the run\'s view memo', () => {
    expect(SRC).toContain('stepOutputs?: Record<string, unknown>,');
    expect(SRC).toContain('priorStepId: string | null = null,');
    expect(SRC).toContain('stepOutputViews: Map<string, PreparedView> = new Map(),\n');
    // The one parameter after the memo is the wake re-entry: the paused turn's
    // transcript and the continuation turn, supplied once by the loop.
    // After the wake re-entry comes the per-turn narrowing of the catalog (a
    // capability step's web-only fallback turn, the salvage turn's deadline),
    // then the salvage notes the earlier-outputs section renders, and nothing
    // else.
    expect(SRC).toContain('resume?: { transcript: ConversationMessage[]; continuationTurn: string },\n');
    expect(SRC).toContain('turnOpts: {\n      toolAllowlist?: ReadonlySet<string>;');
    // ...then the loop's current item, and nothing else. A looped reasoning
    // step is the same step run once per element, so `item` is the ONLY thing
    // that differs between its iterations.
    expect(SRC).toContain('salvageNotes: Record<string, SalvageNote> = {},\n');
    expect(SRC).toContain('loopItem?: unknown,\n  ): Promise<{ output: unknown }> {');
  });

  it('every caller passes all three', () => {
    // Wired at one end is the failure mode this whole session kept finding: the
    // parameter existing while every call site omits it would leave the prompt
    // exactly as empty as before, and nothing would fail. Three callers: the
    // llm_reason step, and the capability step's two turns.
    const calls = SRC.split('objective, stepOutputProducedBy, stepOutputs, stepOutputOwnerId, stepOutputViews,\n').length - 1;
    expect(calls).toBe(3);
    expect(SRC).not.toContain('objective, stepOutputProducedBy, stepOutputs);');
  });

  it('the predecessor\'s id is the owner of the value, which advances only on a registration', () => {
    // `previousStepId` is cursor bookkeeping: it is advanced to the current
    // step before the step runs, and a step recovery advanced past without
    // producing its output is the previous step while `stepOutput` still holds
    // an EARLIER step's value. The owner advances with the registry write —
    // at the loop head, and in the one branch that registers its placeholder
    // directly — so it names the step the value came from.
    expect(SRC).toContain('stepOutputs[previousStepId] = stepOutput;\n        stepOutputOwnerId = previousStepId;');
    expect(SRC).toContain('if (stepOutputs) stepOutputs[step.stepId] = stepOutput;\n        stepOutputOwnerId = step.stepId;');
    const calls = SRC.split('objective, stepOutputProducedBy, stepOutputs, stepOutputOwnerId, stepOutputViews,\n').length - 1;
    expect(calls).toBe(3);
  });

  it('the view memo is created beside the registry and lives for the loop invocation only', () => {
    expect(SRC).toContain('const stepOutputViews = new Map<string, PreparedView>();');
    // Not persisted: the resume state carries the raw registry alone. The four
    // `stepOutputViews:` in the file are the parameter declaration, the
    // step-salvage seam's argument that hands the same memo on, and the two
    // halves of `executeLoopStep`'s `reasoning` bag — its type and its default
    // — which pass that same memo to a LOOPED reasoning step. A looped step
    // runs the same `invokeStepLLM` as an unlooped one and must see the same
    // materialised views, or the fifth competitor pays to compress what the
    // first already did.
    expect(SRC.split('stepOutputViews:').length - 1).toBe(4);
    const resumeState = SRC.slice(SRC.indexOf('export interface HybridResumeState'), SRC.indexOf('export interface HybridResumeState') + 12_000);
    expect(resumeState).not.toContain('stepOutputViews');
  });
});

describe('the registry it reads is still written for every step', () => {
  it('records each step output under its own id', () => {
    expect(SRC).toContain('stepOutputs[previousStepId] = stepOutput;');
  });

  it('still withholds the entry for a step that produced nothing', () => {
    // Unchanged and load-bearing: writing it would file the predecessor's value
    // under this step's id, and `$.steps.<id>` would read a wrong answer.
    expect(SRC).toContain('!unsatisfiedSteps.has(previousStepId)');
  });
});
