// A workflow step's prose is not something the agent said.
//
// invokeStepLLM relays its adapter events to the chat sink so the thread shows a
// long run working. That relay already excludes `completion`, because in the
// conversational loop it means the RUN ended while here it means one STEP did,
// and a sixteen-step run would announce it had finished sixteen times.
//
// Assistant text needed the same treatment for the same reason. A four-step run
// sent four assistant messages, every one accumulated into the reply, so a
// person who asked to open a website read the plan restated, the cache check
// explained, and a line about what the next step would do, ahead of the sentence
// that answered them.
//
// Filtered at the EMITTER on purpose: the text is accumulated independently by
// this runtime and by the control plane, so trimming it at either writer makes
// the stored reply depend on whether the browser stayed open. That property is
// held by chat-turn-durability.source.test.ts, and an earlier attempt at this
// fix broke it.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

/** The relay inside invokeStepLLM. */
function relay(): string {
  const anchor = SRC.indexOf('const stepSpeechReachesTheThread');
  expect(anchor).toBeGreaterThan(-1);
  return SRC.slice(anchor - 200, anchor + 500);
}

describe('what a step forwards to the chat', () => {
  it('still withholds completion, one step ending is not the run ending', () => {
    expect(relay()).toMatch(/event\.type !== 'completion'/);
  });

  it('treats a step as speaking only when nothing follows it', () => {
    // onSuccess, not outputField: the terminal step is the one whose message is
    // addressed to the person, and it is identified by having no successor.
    expect(relay()).toMatch(/const stepSpeechReachesTheThread = !step\.onSuccess/);
  });

  it('classifies both assistant event types as speech', () => {
    // Forwarding only the message and not the delta would stream the prose
    // live and drop it from the reply, which is the same divergence by
    // another route.
    expect(relay()).toMatch(/event\.type === 'assistant_message' \|\| event\.type === 'assistant_delta'/);
  });

  it('forwards every NON-speech event for every step', () => {
    // Tool calls and usage are what the harness builds its trace from and what
    // tells a person a long run is still alive. Withholding those would trade
    // this bug for a dead-looking screen.
    expect(relay()).toMatch(/stepSpeechReachesTheThread \|\| !isSpeech/);
  });
});
