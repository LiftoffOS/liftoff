/**
 * Chat-turn durability (static source contract).
 *
 * ADR-041 promises that a completed web turn is persisted and settled even when
 * the SSE consumer has gone away: "Client disconnect deliberately does NOT
 * abort: turns finish and persist; only an explicit stop aborts."
 *
 * The code once contradicted that in three places at once, and the result was a
 * turn that ran for minutes, succeeded, and was thrown away — the user's thread
 * kept a question with no answer, forever:
 *
 *   1. `req.on('close')` aborted the controller, and
 *   2. the terminal branch selected on `abortController.signal.aborted` BEFORE
 *      it looked at what the engine returned, so a severed stream routed a
 *      successful turn into the TIMEOUT branch, and
 *   3. the settle callback sat AFTER `await writeSSE(res, 'complete', ...)`,
 *      which rejects on a broken socket — so the backstop was skipped in
 *      precisely the case it exists for.
 *
 * The handler cannot be imported here (it pulls DB + SDK transitively), so this
 * asserts the structure directly, in the same spirit as the other
 * `*.source.test.ts` contracts in this directory.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SOURCE = readFileSync(join(__dirname, '..', 'chat-turn-handler.ts'), 'utf8');

describe('a stop travels as a fact, not as fake output', () => {
  // A turn stopped before it said anything used to send the literal string
  // "(stopped)" as its output, purely so the caller could tell a deliberate end
  // from a dead stream. That string then landed in the person's transcript as a
  // message the agent had never said.
  const ENGINE = readFileSync(
    join(__dirname, '..', '..', 'agent-execution', 'service.ts'),
    'utf8',
  );

  it('the engine never substitutes a marker for output it did not produce', () => {
    const code = ENGINE.split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toContain('(stopped)');
  });

  it('the complete frame carries `stopped` so the caller can tell', () => {
    expect(SOURCE).toMatch(/execResult\.stopped\s*\?\s*\{\s*stopped:\s*true\s*\}/);
  });
});

describe('chat-turn durability source contract', () => {
  it('client disconnect does not abort the turn', () => {
    // The `close` handler must not abort. Grab the handler body and assert it.
    const closeHandler = SOURCE.match(/req\.on\('close',\s*\(\)\s*=>\s*\{([\s\S]*?)\}\);/);
    expect(closeHandler).not.toBeNull();
    expect(closeHandler![1]).not.toContain('abortController.abort()');
  });

  it('engine outcome is checked before abort state in the terminal branch', () => {
    const successIdx = SOURCE.indexOf('} else if (execResult.success || execResult.escalated || boundClosed) {');
    const pausedIdx = SOURCE.indexOf('if (execResult.paused) {');
    const abortedIdx = SOURCE.indexOf('} else if (abortController.signal.aborted) {');

    expect(pausedIdx).toBeGreaterThan(-1);
    expect(successIdx).toBeGreaterThan(-1);
    expect(abortedIdx).toBeGreaterThan(-1);

    // A run that produced a deliverable outcome must win over abort state.
    expect(pausedIdx).toBeLessThan(abortedIdx);
    expect(successIdx).toBeLessThan(abortedIdx);
  });

  it('the settle callback is scheduled before the complete frame is written', () => {
    const settleIdx = SOURCE.indexOf('settleChatTurnViaCallback');
    const completeIdx = SOURCE.indexOf("writeSSE(res, 'complete'");

    expect(settleIdx).toBeGreaterThan(-1);
    expect(completeIdx).toBeGreaterThan(-1);
    // writeSSE rejects on a dead socket; persistence must not sit behind it.
    expect(settleIdx).toBeLessThan(completeIdx);
  });

  // A turn that writes two paragraphs and then stops for an approval has said
  // something worth keeping. PB's stream consumer is the primary path and
  // persists it, but that consumer breaks its loop when the browser goes away,
  // which is exactly what this backstop exists for on the success branch. It has
  // to cover the paused branch for the same reason.
  it('the settle callback also runs when the turn paused', () => {
    const pausedIdx = SOURCE.indexOf('if (execResult.paused) {');
    const successIdx = SOURCE.indexOf('} else if (execResult.success || execResult.escalated || boundClosed) {');
    const settleIdx = SOURCE.indexOf('settleChatTurnViaCallback');

    expect(pausedIdx).toBeGreaterThan(-1);
    expect(settleIdx).toBeGreaterThan(pausedIdx);
    expect(settleIdx).toBeLessThan(successIdx);
  });

  it('the paused settle is scheduled before its terminal frames are written', () => {
    // writeSSE rejects on a dead socket, so persistence behind that await is
    // skipped in precisely the case it exists for.
    const settleIdx = SOURCE.indexOf('settleChatTurnViaCallback');
    const hitlFrameIdx = SOURCE.indexOf("writeSSE(res, 'hitl_required'");
    const askFrameIdx = SOURCE.indexOf("writeSSE(res, 'awaiting_input'");

    expect(hitlFrameIdx).toBeGreaterThan(-1);
    expect(askFrameIdx).toBeGreaterThan(-1);
    expect(settleIdx).toBeLessThan(hitlFrameIdx);
    expect(settleIdx).toBeLessThan(askFrameIdx);
  });

  it('a failed complete frame cannot abort the success branch', () => {
    // The complete write is best-effort: wrapped so a broken socket does not
    // throw past the branch and skip the bookkeeping that follows it.
    const guarded = /try\s*\{\s*await writeSSE\(res, 'complete'[\s\S]*?\}\s*catch\s*\(/.test(SOURCE);
    expect(guarded).toBe(true);
  });

  it('the turn timeout stays below agent-service\'s Cloud Run request timeout', () => {
    // Cloud Run cutting the connection is the failure mode this whole contract
    // exists to survive; TR must reach its own timeout first so it can persist.
    //
    // Read from the CONSTANT rather than regexed out of this file. The value
    // moved into `agent-execution/constants` because the run's own ceiling has
    // to be derived from it — a run that parks after this deadline has fired
    // hands its continuation an abort to read — and a source-literal match
    // would have gone quiet the moment it moved, which is the one way this
    // assertion can fail without anybody noticing.
    const {
      CHAT_TURN_HARD_TIMEOUT_MS, AGENT_SERVICE_REQUEST_TIMEOUT_SECONDS,
    } = jest.requireActual('../../agent-execution/constants') as {
      CHAT_TURN_HARD_TIMEOUT_MS: number; AGENT_SERVICE_REQUEST_TIMEOUT_SECONDS: number;
    };
    expect(CHAT_TURN_HARD_TIMEOUT_MS / 1_000)
      .toBeLessThan(AGENT_SERVICE_REQUEST_TIMEOUT_SECONDS);
    // And this file still uses it, rather than a number of its own.
    expect(SOURCE).toContain('const HARD_TIMEOUT_MS = CHAT_TURN_HARD_TIMEOUT_MS;');
  });
});

// The same promise, broken by a different route.
//
// The contract above is about a turn surviving a DEAD STREAM. This one is about
// a turn surviving its own SILENCE.
//
// A run can review a pull request, succeed, and post a substantive review to
// GitHub with no reply ever appearing in the chat: `agent_chat_turns` holding
// only the user's row, `agent_messages` nothing, and the logs ending at
// `engine_invocation_completed` with no warning and no error.
//
// The assistant write was gated on `if (outputText)`, and so was the
// at-least-once settle backstop this file already protects — the safety net had
// the identical hole. A run that acts and finishes with nothing left to say
// therefore recorded nothing, anywhere, permanently.
describe('a successful turn never leaves the thread empty', () => {
  it('persists an assistant message unconditionally on the success branch', () => {
    // The gate that caused it: `if (outputText)` wrapped around the assistant
    // addMessage call. Its absence is the property.
    const successBranch = SOURCE.slice(
      SOURCE.indexOf('} else if (execResult.success || execResult.escalated || boundClosed) {'),
      SOURCE.indexOf('if (sdkSessionId) {'),
    );
    expect(successBranch.length).toBeGreaterThan(0);
    expect(successBranch).toMatch(/role: 'assistant'/);
    expect(successBranch).not.toMatch(/if \(outputText\)\s*\{/);
  });

  it('has a stated fallback for a turn that finished without prose', () => {
    // Saying nothing is not an option: in the thread, "no reply" and "never
    // ran" are indistinguishable to the person reading it.
    expect(SOURCE).toMatch(/COMPLETED_WITHOUT_REPLY\s*=/);
    const fallback = SOURCE.match(/COMPLETED_WITHOUT_REPLY\s*=\s*\n?\s*'([^']+)'/);
    expect(fallback).not.toBeNull();
    // Product voice: no em dashes, no contractions, never the word "agent".
    expect(fallback![1]).not.toMatch(/—/);
    expect(fallback![1]).not.toMatch(/\b\w+'(s|t|re|ll|ve|d)\b/);
    expect(fallback![1].toLowerCase()).not.toMatch(/\bagent\b/);
  });

  it('the fallback talks about the work, not about the system', () => {
    // Shipped once as "This run finished without a written reply. Its activity
    // for this turn is recorded in the run history." In a real thread that read
    // as an error report about machinery the person cannot see, for a turn where
    // nothing had gone wrong. The work is already shown above the line; the only
    // thing left to say is that it is finished.
    const fallback = SOURCE.match(/COMPLETED_WITHOUT_REPLY\s*=\s*\n?\s*'([^']+)'/)![1];

    // Internal vocabulary the reader has no reason to know.
    for (const jargon of ['run history', 'this run', 'this turn', 'activity', 'invocation', 'persisted']) {
      expect(fallback.toLowerCase()).not.toContain(jargon);
    }
    // Short enough to read as a person speaking rather than a status page.
    expect(fallback.length).toBeLessThanOrEqual(40);
  });

  it('the settle backstop is no longer gated on outputText', () => {
    // It carried the identical hole, so a closed tab plus an empty reply
    // combined into a thread that stayed silent forever.
    expect(SOURCE).not.toMatch(/if \(body\.turnId && outputText\)/);
    expect(SOURCE).toMatch(/if \(body\.turnId\)\s*\{/);
  });

  it('settles and shows the same text it persisted', () => {
    // A person with the tab open and a person who closed it must not be given
    // two different accounts of one turn.
    expect(SOURCE).toMatch(/replyText: persistedReply/);
    expect(SOURCE).toMatch(/outputText: persistedReply/);
  });

  it('does not reassign outputText inside the success branch', () => {
    // The transcript-saturation guard, the delivery-rule measurement and the
    // stop/complete bookkeeping must keep seeing what the run actually
    // produced, not a line this handler wrote. (Accumulating it while streaming
    // is fine and happens far above this branch.)
    //
    // That parenthetical was aspirational when it was written: the streaming
    // branch ASSIGNED rather than accumulated, so the turn text meant "the last
    // thing said". It accumulates now, and the saturation guard moved to
    // `lastAssistantText` — still model output rather than handler prose, which
    // is what this test is protecting, and see the turn-text contract below for
    // why that guard specifically cannot read the whole turn.
    const successBranch = SOURCE.slice(
      SOURCE.indexOf('} else if (execResult.success || execResult.escalated || boundClosed) {'),
      SOURCE.indexOf('turnOutcome = \'success\';', SOURCE.indexOf('} else if (execResult.success || execResult.escalated || boundClosed) {')),
    );
    expect(successBranch).not.toMatch(/\boutputText\s*=[^=]/);
    expect(successBranch).not.toMatch(/\blastAssistantText\s*=[^=]/);
    expect(SOURCE).toMatch(/contextExhaustedCompletion\(lastAssistantText\)/);
    expect(SOURCE).toMatch(/recordDeliveryRuleViolations\(\s*\n?\s*outputText/);
  });

  it('the PAUSED branch settles the question too, not only prior prose', () => {
    // Found by this contract being stricter than expected: the paused branch
    // carried the identical gate. It persists `assistantTurn` — which always
    // includes the question — but settled only `outputText`, so a turn that
    // paused without saying anything first left a closed tab with no question
    // in the thread and no way to know one had been asked.
    expect(SOURCE).not.toMatch(/if \(body\.turnId && outputText\)/);
    expect(SOURCE).toMatch(/replyText: assistantTurn/);
  });

  it('stops swallowing persistence failures silently', () => {
    // `.catch(() => undefined)` is what made the two possible causes — an empty
    // reply, and a persist that threw — produce byte-identical evidence.
    const successBranch = SOURCE.slice(
      SOURCE.indexOf('} else if (execResult.success || execResult.escalated || boundClosed) {'),
      SOURCE.indexOf('if (sdkSessionId) {'),
    );
    expect(successBranch).not.toMatch(/catch\(\(\) => undefined\)/);
    expect(successBranch).toMatch(/logPersistFailure\('assistant'/);
    expect(successBranch).toMatch(/logPersistFailure\('user'/);
  });

  it('the failure log names the thread, so the next one identifies itself', () => {
    const helper = SOURCE.slice(SOURCE.indexOf('function logPersistFailure'));
    expect(helper).toMatch(/logger\.warn/);
    expect(helper).toMatch(/threadId/);
    expect(helper).toMatch(/invocationId/);
    expect(helper).toMatch(/turnId/);
  });
});

// The fallback above keeps the thread from being empty. It is not how a
// finished turn is supposed to be reported.
//
// A platform-written line is wrong however it is phrased — as an explanation of
// the system, or as a terser version of the same mistake. Both are the PLATFORM
// answering a person who had asked the AGENT. The prompt is where a reply is supposed to come from.
describe('the agent is told to report back itself', () => {
  const PROMPT = readFileSync(join(__dirname, '..', 'system-prompt.ts'), 'utf8');

  it('the How to Interact section requires a reply after acting', () => {
    // The section already said "state what you will do, then act". It never said
    // to come back and say what happened, which is the whole gap.
    expect(PROMPT).toMatch(/When you have finished acting, reply/);
  });

  it('states the consequence, not just the instruction', () => {
    // A bare "always reply" is the kind of rule a model trades away under
    // pressure. Saying what it costs the person is what makes it stick.
    expect(PROMPT).toMatch(/staring at their own message/);
  });

  it('demands the answer, not a status update', () => {
    // "The blank screen is gone; the answer still is not there. Whoever asked
    // has to leave the product to find out what happened." Reporting THAT the
    // work happened is not the same as reporting WHAT it found, and a rule that
    // only asks for a reply is satisfied by "Done".
    expect(PROMPT).toMatch(/reply with the ANSWER, not with a status update/);
    expect(PROMPT).toMatch(/"Done" and "I have posted the review" are barely better/);
  });

  it('makes a link a reference rather than a substitute', () => {
    // The motivating case: the review went to a pull request, and the thread
    // said nothing about what it said.
    expect(PROMPT).toMatch(/never as a substitute/);
    expect(PROMPT).toMatch(/reading only this thread should learn what you learned/);
  });
});

// The agent gets asked before the platform speaks for it.
//
// The graph contract in platform-backend covers agents that HAVE a graph and
// have been redistilled since it shipped. That is not most of the fleet: the
// conversational branch has no graph to constrain, and existing graphs keep
// their old steps until rebuilt. For those the only coverage was a prompt
// paragraph, which is a hope. This is the guarantee.
describe('a silent success asks the agent for the answer', () => {
  const NUDGE = readFileSync(join(__dirname, '..', 'closing-reply.ts'), 'utf8');

  it('is tried before the platform fallback: on a silent success, and on an escalated turn that gathered something', () => {
    // The silent-success nudge keeps its gate. The last resort — a turn that
    // ended escalated after at least one successful tool call — is asked
    // whether or not the turn had prose, from the turn's own tool results,
    // and its answer is APPENDED rather than substituted.
    expect(SOURCE).toMatch(/if \(execResult\.escalated && meaningfulToolResults\.length > 0\) \{/);
    expect(SOURCE).toMatch(/\} else if \(!outputText\) \{/);
    // What the turn SAID is the whole of it: every assistant message, then the
    // closing reply.
    expect(SOURCE).toMatch(/const spoken = \[outputText, closingReply\]\s*\.filter\(Boolean\)\s*\.reduce\(\(acc, part\) => appendAssistantMessage\(acc, part\), ''\);/);
    // The hand-over correction rides in the same join: a claimed Chief AI
    // Officer hand-over the turn never made is registered or corrected before
    // the text is settled (colleague-handover-claim.ts). The ledger correction
    // REPLACES that text rather than joining it — a reply that denies what the
    // run recorded must not be delivered beside its own correction
    // (ledger-contradiction.ts).
    expect(SOURCE).toMatch(/const said = \[ledgerCorrected \?\? spoken, handover\.correction\]\s*\.filter\(Boolean\)\s*\.reduce\(\(acc, part\) => appendAssistantMessage\(acc, part\), ''\);/);
    expect(SOURCE).toMatch(/said \|\| COMPLETED_WITHOUT_REPLY/);
  });

  it('withholds tools, which is the whole safety argument', () => {
    // verify-on-stop nudges a run to keep WORKING. This wants it to stop and
    // SPEAK. A nudge that can call tools can act twice, and a turn that already
    // posted a review deciding to post another is worse than a blank thread.
    expect(NUDGE).not.toMatch(/\btools\s*:/);
    expect(NUDGE).toMatch(/No `tools`/);
  });

  it('asks for the answer rather than a status update', () => {
    expect(NUDGE).toMatch(/with the ANSWER rather than a status update/);
    expect(NUDGE).toMatch(/so they do not have to go/);
  });

  it('does not tell the person it was prompted', () => {
    // The reply has to read as the agent finishing its thought, not as the
    // platform having poked it.
    expect(NUDGE).toMatch(/mention that you were prompted/);
  });

  it('returns null rather than throwing, so a failed nudge is not a failed turn', () => {
    expect(NUDGE).toMatch(/Promise<string \| null>/);
    expect(NUDGE).toMatch(/catch \(err\)/);
    expect(NUDGE).toMatch(/return null/);
  });

  it('is bounded in time and in how much transcript it sends', () => {
    // The person is already waiting, and a chat transcript can carry customer
    // content that has no reason to be re-sent wholesale.
    expect(NUDGE).toMatch(/NUDGE_TIMEOUT_MS\s*=/);
    expect(NUDGE).toMatch(/DIGEST_MAX_CHARS\s*=/);
    expect(NUDGE).toMatch(/slice\(-DIGEST_MAX_CHARS\)/);
  });

  it('makes one attempt, not a retry loop', () => {
    // Retrying a model that just declined to speak buys latency on a turn the
    // person is already waiting on.
    const fn = NUDGE.slice(NUDGE.indexOf('export async function requestClosingReply'));
    expect(fn).not.toMatch(/\bfor \(|\bwhile \(/);
    expect((fn.match(/llmClient\.complete\(/g) ?? []).length).toBe(1);
  });

  it('does not import the chat handler back, which would be a cycle', () => {
    expect(NUDGE).not.toMatch(/from '\.\/chat-turn-handler'/);
  });
});

// A turn is not one message. The engine emits one `assistant_message` per model
// response, so a turn that speaks, calls a tool and speaks again produces
// several — the CAIO share that prompted this said "Drafting the plan now." and
// then "Approved. Both teams are being set up now:".
//
// `outputText` used to be ASSIGNED on each of those rather than appended, which
// silently made the turn text mean "the last thing said". It is not a display
// value: it becomes the persisted `messages` row (replayed to the model on the
// next turn of the thread via loadThreadHistory), the settle callback's
// replyText (the sole writer of the person's transcript when the SSE consumer
// has gone away), and the `complete` frame's outputText.
describe('the turn text is the whole turn', () => {
  it('accumulates each assistant message instead of overwriting', () => {
    const branch = SOURCE.slice(
      SOURCE.indexOf("case 'assistant_message': {"),
      SOURCE.indexOf("case 'tool_call_started':"),
    );
    expect(branch).toContain('appendAssistantMessage(outputText, text)');
    expect(branch).not.toMatch(/\boutputText\s*=\s*text\b/);
  });

  it('keeps the newest message separately rather than deriving it back', () => {
    // Deriving "the last message" by splitting the turn text would depend on
    // the separator surviving whatever the model wrote, which is exactly the
    // ambiguity the two variables exist to avoid.
    expect(SOURCE).toMatch(/let lastAssistantText = ''/);
    expect(SOURCE).toContain('lastAssistantText = text');
  });

  it('gives the saturation guard the last message, not the whole turn', () => {
    // contextExhaustedCompletion bails above MAX_CAPITULATION_CHARS (600) by
    // design. Handing it a multi-message turn pushes a real capitulation past
    // that cap, so the guard stops firing exactly when it is needed and the
    // saturated session gets persisted for the next turn to die on.
    expect(SOURCE).toContain('contextExhaustedCompletion(lastAssistantText)');
    expect(SOURCE).not.toContain('contextExhaustedCompletion(outputText)');
  });

  it('settles and persists the whole turn, not the last message', () => {
    // Both writers of the person's transcript must agree: platform-backend
    // accumulates the text deltas, so a settle carrying only the final message
    // would store a different reply for the same turn depending on whether the
    // browser stayed open.
    expect(SOURCE).toMatch(/const spoken = \[outputText, closingReply\]\s*\.filter\(Boolean\)\s*\.reduce\(\(acc, part\) => appendAssistantMessage\(acc, part\), ''\);/);
    expect(SOURCE).toMatch(/const said = \[ledgerCorrected \?\? spoken, handover\.correction\]/);
    expect(SOURCE).not.toMatch(/const said = lastAssistantText/);
    expect(SOURCE).not.toMatch(/const spoken = lastAssistantText/);
    expect(SOURCE).toContain('replyText: persistedReply');
    expect(SOURCE).toMatch(/role: 'assistant', content: persistedReply/);
  });
});

// The same promise again, broken by a third route: a run that ENDED by handing
// the work to a person.
//
// A turn that ends `escalated` can write nothing anywhere, so the person
// retries into the same silence.
//
// Cause: this handler selected its terminal branch from the raw `paused` /
// `success` booleans rather than from the terminal state. Most escalation sites
// return `success: true` and landed in the durability branch reported as an
// ordinary finished turn; three return `success: false` and fell through to the
// failure branch, which writes an error frame and persists nothing.
describe('an escalated turn never leaves the thread empty', () => {
  it('routes escalated into the branch that persists, ahead of success', () => {
    // Reading `escalated` here is what puts both halves of one run class on the
    // same path. terminal-state.ts checks it before `success` for this reason.
    expect(SOURCE).toContain('} else if (execResult.success || execResult.escalated || boundClosed) {');
  });

  it('states the handoff instead of letting the thread just stop', () => {
    expect(SOURCE).toMatch(/HANDED_TO_A_PERSON\s*=/);
    const copy = SOURCE.match(/HANDED_TO_A_PERSON\s*=\s*\n?\s*'([^']+)'/);
    expect(copy).not.toBeNull();
    // Product voice, same rules the fallback above is held to.
    expect(copy![1]).not.toMatch(/—/);
    expect(copy![1]).not.toMatch(/\b\w+'(s|t|re|ll|ve|d)\b/);
    expect(copy![1].toLowerCase()).not.toMatch(/\bagent\b/);
    // Internal vocabulary the reader has no reason to know.
    for (const jargon of ['escalat', 'run', 'invocation', 'terminal', 'persisted']) {
      expect(copy![1].toLowerCase()).not.toContain(jargon);
    }
  });

  it('keeps what the run said in front of the handoff, and never gates on it', () => {
    // A pause with no prose settles the question alone; an escalation with no
    // prose has to settle the statement alone, for the identical reason. Gating
    // on `outputText` is the hole both other branches already had to close.
    expect(SOURCE).toMatch(
      /const persistedReply = customerFacingEscalation\s*\n?\s*\?\s*\(said \? `\$\{said\}\\n\\n\$\{HANDED_TO_A_PERSON\}` : HANDED_TO_A_PERSON\)/,
    );
  });

  // `escalated` says a record was written; only a row of kind 'escalation'
  // reached a person. The sentence, the wire flag and the settled text are
  // all driven by ONE boolean read off the record, so a system_internal end
  // never tells a thread the work was passed to someone.
  it('claims the handoff only when the record proves a person received one', () => {
    expect(SOURCE).toMatch(/const customerFacingEscalation = execResult\.escalated === true\s*\n?\s*&& \(await escalationKindById\(tenantId, execResult\.escalationId\)/);
    expect(SOURCE).toMatch(/=== 'escalation';/);
    // Something is always persisted: the closing reply WITH the statement that
    // the run did not finish, or that statement standing alone.
    expect(SOURCE).toMatch(/RUN_DID_NOT_FINISH\s*=\s*\n?\s*'This run did not finish\.'/);
    // APPENDED, not substituted — the same shape as the customer-facing line,
    // and for the reason the test above it states: gating on what the run said
    // is the hole the other two branches already had to close. This branch kept
    // it, so a run that escalated AND spoke published only its prose. One that
    // died early could tell a person "This week's report already ran."
    expect(SOURCE).toMatch(
      /: execResult\.escalated\s*\n?\s*\? \(said \? `\$\{said\}\\n\\n\$\{RUN_DID_NOT_FINISH\}` : RUN_DID_NOT_FINISH\)/,
    );
    // And the fact travels on the wire, because the control plane rebuilds the
    // message from its own accumulator and would strip a sentence appended to
    // `outputText` — the trap the handoff flag beside it exists for.
    expect(SOURCE).toMatch(/execResult\.escalated && !customerFacingEscalation \? \{ didNotFinish: true \}/);
    const copy = SOURCE.match(/RUN_DID_NOT_FINISH\s*=\s*\n?\s*'([^']+)'/)![1];
    expect(copy).not.toMatch(/—/);
    expect(copy).not.toMatch(/\b\w+'(s|t|re|ll|ve|d)\b/);
    expect(copy.toLowerCase()).not.toMatch(/\bagent\b/);
  });

  // Persisting it here was never enough to make a person see it.
  //
  // The control plane builds the thread's message from its own stream
  // accumulator and reads `outputText` only when the turn streamed nothing
  // (`accumulatedText || event.outputText`). Every turn that speaks while it
  // works would therefore deliver the reply with the handoff sentence stripped:
  // present in the rows here and absent from what the person reads.
  it('states the handoff on the wire as a fact, not only in the persisted copy', () => {
    const frame = SOURCE.slice(
      SOURCE.indexOf("await writeSSE(res, 'complete', {"),
      SOURCE.indexOf("await writeSSE(res, 'complete', {") + 3000,
    );
    // Off the same record-proven boolean as the persisted copy.
    expect(frame).toContain('...(customerFacingEscalation ? { escalated: true } : {}),');
  });

  it('carries it beside the other terminal fact rather than as prose', () => {
    const frame = SOURCE.slice(
      SOURCE.indexOf("await writeSSE(res, 'complete', {"),
      SOURCE.indexOf("await writeSSE(res, 'complete', {") + 3000,
    );
    expect(frame).toContain('...(execResult.stopped ? { stopped: true } : {}),');
    // The sentence itself stays out of the frame: two services keeping one
    // string in step is a drift surface, and the wording shown is the control
    // plane's to own. Comments are stripped first — the one above this line in
    // the handler quotes the sentence to explain why it is not sent.
    const code = frame.replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain('escalated: true');
    expect(code).not.toContain('Passed to a person');
  });
});

describe('the settle callback says which reply it is settling', () => {
  // The control plane holds a settled reply to its attachment claims — a
  // reply that reaches the thread through the backstop is the only copy the
  // person reads — but only the turn's FINAL reply. The paused branch settles
  // the partial a turn wrote before it stopped for an approval or a question,
  // and that text stops mid-work, often on the very tool that will produce the
  // card; a correction on it would be false the moment the run resumes. So
  // the success branch marks its settle `final`, the paused branch does not,
  // and the invocation id rides along so the control plane's log lines can
  // cite the run.
  const successIdx = SOURCE.indexOf('} else if (execResult.success || execResult.escalated || boundClosed) {');
  const pausedIdx = SOURCE.indexOf('if (execResult.paused) {');
  const failedIdx = SOURCE.indexOf('const lastResortEligible =');
  const settleCalls = [...SOURCE.matchAll(/settleChatTurnViaCallback\(\{[\s\S]*?\}\);/g)];

  it('has exactly one settle on each of the three branches', () => {
    // Paused, finished, and the last resort on a failed turn — which settles
    // the closing prose the person would otherwise never read, FINAL like
    // the finished branch's, before the error frame goes exactly as today.
    expect(settleCalls).toHaveLength(3);
    const [paused, final, failed] = settleCalls;
    expect(paused.index).toBeGreaterThan(pausedIdx);
    expect(paused.index).toBeLessThan(successIdx);
    expect(final.index).toBeGreaterThan(successIdx);
    expect(final.index).toBeLessThan(failedIdx);
    expect(failed.index).toBeGreaterThan(failedIdx);
  });

  it('marks the success branch settle final, with the invocation id', () => {
    const final = settleCalls[1][0].replace(/^\s*\/\/.*$/gm, '');
    expect(final).toMatch(/^\s*final: true,\s*$/m);
    expect(final).toMatch(/^\s*invocationId,\s*$/m);
  });

  it('marks the failed-turn settle final too, and sends the error frame after it', () => {
    const failed = settleCalls[2][0].replace(/^\s*\/\/.*$/gm, '');
    expect(failed).toMatch(/^\s*final: true,\s*$/m);
    expect(failed).toMatch(/^\s*replyText: failedTurnReply,\s*$/m);
    // The same composition the finished branch uses for `said`: what the turn
    // streamed before it failed, then the closing prose.
    expect(SOURCE).toMatch(/const failedTurnReply = \[outputText, closingProse\]\s*\.filter\(Boolean\)\s*\.reduce\(\(acc, part\) => appendAssistantMessage\(acc, part\), ''\);/);
    const errorFrame = SOURCE.indexOf("code: 'EXEC_ERROR'");
    expect(settleCalls[2].index).toBeLessThan(errorFrame);
  });

  it('never marks the paused branch settle final', () => {
    const paused = settleCalls[0][0].replace(/^\s*\/\/.*$/gm, '');
    expect(paused).not.toContain('final');
  });
});
