// The step whose output the person reads is told that it is.
//
// The executor returns a step's RECORDED object when it declares an
// outputField, and the model's raw prose when it does not. A terminal step
// declares none, so its prose is the run's output and becomes the chat reply.
// It was instructed with the words "Produce an output." — while every other
// step got a precise contract — so it narrated: the plan restated, the cache
// check described, a line about what "the next step" would do after the last
// step, and the internal [COMPLETE] marker, all ahead of the answer.
//
// Source-scanned for the branch because the prompt is assembled several hundred
// lines inside invokeStepLLM, behind an adapter and a live tool catalog; the
// contract's own wording is asserted from the exported constant.

import { readFileSync } from 'fs';
import { join } from 'path';
import { TERMINAL_STEP_REPLY_CONTRACT, INTERACTIVE_TERMINAL_REPLY_CONTRACT } from '../service';
import { resolveStartTriggeredBy } from '../trigger-attribution';

const SERVICE = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

/** The three-way branch that decides what a step is told to produce.
 *  Anchored on the record_step_output sentence, which appears once, rather
 *  than on `step.outputField`, which appears several times in this file. */
function producesBranch(): string {
  const anchor = SERVICE.indexOf('Produce an output. Your FINAL action');
  expect(anchor).toBeGreaterThan(-1);
  return SERVICE.slice(anchor, anchor + 900);
}

describe('which step gets which contract', () => {
  it('a step that declares an outputField is still told to record it', () => {
    // Unchanged behaviour. Losing this is how every such step used to fail.
    expect(producesBranch()).toMatch(/Your FINAL action is exactly one call to/);
  });

  it('a terminal step with no outputField gets the reply contract', () => {
    expect(producesBranch()).toMatch(/:\s*step\.onSuccess[\s\S]*TERMINAL_STEP_REPLY_CONTRACT/);
  });

  it('an intermediate step with no outputField is left alone', () => {
    // Its prose feeds the next step and nobody reads it, so the reply rules
    // would be wrong there. The branch turns on onSuccess for that reason.
    expect(producesBranch()).toMatch(/step\.onSuccess\s*\n?\s*\?\s*'Produce an output\.'/);
  });
});

describe('what the terminal step is told', () => {
  it('says the output IS the message, not a report about it', () => {
    expect(TERMINAL_STEP_REPLY_CONTRACT).toMatch(/Your output IS the message this person receives/);
    expect(TERMINAL_STEP_REPLY_CONTRACT).toMatch(/nothing else is sent/);
  });

  it('forbids each thing the person actually saw', () => {
    // Every clause here is a paragraph that reached a customer.
    expect(TERMINAL_STEP_REPLY_CONTRACT).toMatch(/Do not restate the plan/);
    expect(TERMINAL_STEP_REPLY_CONTRACT).toMatch(/narrate what earlier steps did/);
    expect(TERMINAL_STEP_REPLY_CONTRACT).toMatch(/later step will do/);
    expect(TERMINAL_STEP_REPLY_CONTRACT).toMatch(/\[COMPLETE\]/);
  });

  it('explains that the earlier outputs are context, not material to recite', () => {
    // Without the reason, "do not restate" reads as a style note and loses to
    // a prompt that hands the model three step outputs and says nothing.
    expect(TERMINAL_STEP_REPLY_CONTRACT).toMatch(/working notes handed to you as context/);
    expect(TERMINAL_STEP_REPLY_CONTRACT).toMatch(/never seen them/);
  });

  it('still asks for an output at all', () => {
    // A terminal step that produces nothing is the silent-turn failure.
    expect(TERMINAL_STEP_REPLY_CONTRACT).toMatch(/^Produce an output\./);
  });
});

describe('a step that records a value is told its prose is internal', () => {
  // The other half of the same defect. The terminal step now writes a clean
  // answer, and the person still read three paragraphs above it: the plan, the
  // cache check, and a sentence about what the next step would do. Those come
  // from steps that were told precisely what to RECORD and nothing about what
  // to write, so they wrote an update for the reader.
  //
  // Fixed at the source rather than by trimming the reply, because the text is
  // accumulated by two independent writers (this runtime and the control plane)
  // and cutting either one makes the stored reply depend on whether the browser
  // stayed open — see chat-turn-durability.source.test.ts.
  it('appends the clause to the recording contract', () => {
    expect(producesBranch()).toMatch(/RECORDING_STEP_PROSE_IS_INTERNAL/);
  });

  it('says the prose is unread and only the recorded value travels', () => {
    const SVC = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');
    const decl = SVC.slice(SVC.indexOf('const RECORDING_STEP_PROSE_IS_INTERNAL'));
    expect(decl).toMatch(/Everything you write as prose is internal/);
    expect(decl).toMatch(/only the value you record is/);
    expect(decl).toMatch(/does not see this step at all/);
  });

  it('forbids each paragraph the person actually read', () => {
    // The declaration is a run of concatenated literals, so the sentences are
    // split across them. Rejoin before matching: asserting on the raw source
    // would pass or fail on where the lines happen to wrap.
    const SVC = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');
    const decl = SVC.slice(SVC.indexOf('const RECORDING_STEP_PROSE_IS_INTERNAL'), 
      SVC.indexOf('const RECORDING_STEP_PROSE_IS_INTERNAL') + 900);
    const joined = decl.replace(/'\s*\n?\s*\+\s*'/g, '');
    expect(joined).toMatch(/Do not write them an update/);
    expect(joined).toMatch(/do not describe what you are about to do/);
    expect(joined).toMatch(/do not report what you just did/);
  });
});

// The half the contract above does not settle: whose instruction wins.
//
// Telling a terminal step "your output IS the message this person receives" is
// necessary and not sufficient. The step's own description is the more specific
// instruction and the model reads it that way, so a branch authored for an
// unattended run ("take no action: send no reply, post nothing") wins the
// conflict and the model writes a note about its own state instead of an
// answer: a person who answers "No" in a chat thread can read back
// "(no reply sent)" and nothing else.
describe('the step that answers a person who is waiting', () => {
  it('is attached only to a terminal step, and only when a person started the run', () => {
    const build = SERVICE.slice(
      SERVICE.indexOf('const someoneIsWaiting'),
      SERVICE.indexOf('const someoneIsWaiting') + 320,
    );
    expect(build).toMatch(/startsWith\('human:'\)/);
    expect(build).toMatch(/!step\.onSuccess && someoneIsWaiting/);
  });

  it('reads the trigger the way the rest of the estate writes it', () => {
    // resolveStartTriggeredBy emits `human:<userId>` for a person, and `cron`,
    // `event:<label>`, `agent:<id>`, `system:<what>` for everything else. A
    // prefix match on the namespace is the same shape ADR-030 uses for events.
    expect(resolveStartTriggeredBy({ agentId: 'a1', triggeredBy: 'human', triggeredByUserId: 'u1' }))
      .toMatch(/^human:/);
    for (const t of ['cron', 'event', 'agent'] as const) {
      expect(resolveStartTriggeredBy({ agentId: 'a1', triggeredBy: t })).not.toMatch(/^human:/);
    }
    // A human trigger with nobody on it is the platform acting for the agent.
    expect(resolveStartTriggeredBy({ agentId: 'a1', triggeredBy: 'human' })).not.toMatch(/^human:/);
  });

  it('lands last, after the contract it qualifies', () => {
    // The step description is read as the more specific instruction, so the
    // answer to "but the description says not to reply" has to come after both.
    const arrayTail = SERVICE.slice(
      SERVICE.indexOf(': TERMINAL_STEP_REPLY_CONTRACT,'),
      SERVICE.indexOf(': TERMINAL_STEP_REPLY_CONTRACT,') + 500,
    );
    expect(arrayTail).toMatch(/replyContract,\s*\n\s*\]\.join/);
  });

  it('keeps the do-not-act half of the step and overrides only the do-not-speak half', () => {
    expect(INTERACTIVE_TERMINAL_REPLY_CONTRACT).toMatch(/about not ACTING still holds in full/);
    expect(INTERACTIVE_TERMINAL_REPLY_CONTRACT).toMatch(/they are about the outside world/);
    expect(INTERACTIVE_TERMINAL_REPLY_CONTRACT)
      .toMatch(/None of them means staying silent to the person you are talking to/);
  });

  it('makes "nothing to do" an answer rather than a reason for silence', () => {
    expect(INTERACTIVE_TERMINAL_REPLY_CONTRACT).toMatch(/Answer even when the outcome is that nothing needed doing/);
    expect(INTERACTIVE_TERMINAL_REPLY_CONTRACT).toMatch(/tell a decision\s*\n?from a failure/);
  });

  it('asks the answer to name what was asked, not merely to exist', () => {
    // "There was nothing to do here." is a sentence and not an answer: the
    // person had to write back and restate what they had said no to.
    expect(INTERACTIVE_TERMINAL_REPLY_CONTRACT)
      .toMatch(/name what they asked for and what you decided about it/);
  });

  it('shows the agent no sentence to copy', () => {
    // The first version illustrated a good answer with a quoted phrase, and the
    // first run copied it verbatim as its entire reply. An example in a prompt
    // is a template. The platform states the obligation; the agent writes the
    // words, under the voice rules already on this prompt.
    expect(INTERACTIVE_TERMINAL_REPLY_CONTRACT).not.toMatch(/"[^"]{12,}"/);
    expect(INTERACTIVE_TERMINAL_REPLY_CONTRACT).not.toMatch(/Understood|Done\.|No problem|Sure/);
  });

  it('follows the voice rules it sits beside', () => {
    // The same prompt carries AGENT_VOICE_BLOCK. Instructions written in a
    // register the output rules forbid are a mixed signal to the model.
    expect(INTERACTIVE_TERMINAL_REPLY_CONTRACT).not.toMatch(/—/);
    expect(INTERACTIVE_TERMINAL_REPLY_CONTRACT).not.toMatch(/\b(don't|won't|can't|it's|you're)\b/i);
  });
});
