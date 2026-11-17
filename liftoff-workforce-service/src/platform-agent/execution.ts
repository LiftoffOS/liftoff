// runPlatformAgent — generalized tool-use loop shared by CAIO (chat) and HRBP
// (Cloud Tasks fan-out). The two agents differ only in agentId, tool list,
// dispatch handler, audit-action label, usagePurpose, and triggeredBy.

import { decideTurnBound } from '@liftoffos/turn-bounds';
import { callPBLlmComplete } from '../llm/client.js';
import { log } from '../infrastructure/logging.js';
import { loadPlatformAgentConfig } from './config.js';
import { openAssistantMessage } from './assistant-message-boundary.js';
import { renderSystemPrompt } from './system-prompt-render.js';
import { writeAgentAuditLog } from './audit-log-writer.js';
import { readClosingVerdict } from './closing-verdict.js';
import {
  HrbpBlockerException,
  PlatformAgentHandoverException,
  type PlatformAgentEvent,
  type PlatformAgentExecutionInput,
  type PlatformAgentExecutionResult,
} from './types.js';

/** Rounds of tools one run may take: the runtime's order of magnitude for a
 *  run, not a number of prompts. An INPUT to the shared bound policy rather
 *  than a constant inside it — the tenant runtime passes the budget it
 *  resolved per run, and one number could not be right for both. */
const MAX_ITERATIONS = 50;
// The share of the window a prompt may reach, the conservative window for a
// model the registry has not sized, and the precedence between the three
// bounds all live in @liftoffos/turn-bounds. This loop reads what it can
// measure — the prompt the call carried and the served model's window, both
// as the relay reported them, and its own clock — and acts on the answer.
//
// The measurement is on the PROMPT the call carried (what the provider counts
// as the context, cached part included), never on a sum across calls: the same
// prompt is re-sent every round, so a sum measures how many rounds ran, not how
// much room is left. The cumulative cap this replaces (400k of re-sent prompt)
// was "N rounds of a context of size C" in disguise.
// Headroom for one assistant turn. The CAIO emits whole plan specs as tool
// arguments — a brief with five prose sections is thousands of tokens of JSON
// on its own — and at 4000 a single draft could not fit, so the response was
// cut off mid-tool-call and the turn ended having done nothing.
const MAX_TURN_OUTPUT_TOKENS = 16_000;

// A truncated turn is resumed, not abandoned. Bounded so a model that will not
// converge cannot loop forever.
const MAX_TRUNCATION_CONTINUATIONS = 3;
// ADR-041's spacing for mid-run polls. The conversational loop in
// Tenant-Runtime uses the same floor at its own boundaries.
const MID_RUN_POLL_MIN_INTERVAL_MS = 2_000;
// A message that lands after the last tool call would otherwise be claimed with
// no model turn left to answer it. The loop polls once more at the break and
// continues instead, bounded so a stream of messages cannot run the turn
// forever.
const MAX_INJECTION_CONTINUATIONS = 2;

// A reply is closed, not abandoned. When the rounds are spent, the model's
// window is nearly full, or the reply's deadline has passed, the loop used to
// leave with the last round's results appended and never read: the person
// got whatever narration preceded the last tool call. Now one more model call
// is made with no tools, framed so the model answers from what it has. The
// note is the framing; the withheld tools are the guarantee.
//
// The note tells the model what to do and names no mechanic for it to relay:
// an earlier wording ("the reading budget for one reply has been used")
// reached a person as "I ran out of reading budget". The last line it asks
// for is the verdict the caller reads to decide whether the work goes on
// after this turn; it is removed before the text is yielded (closing-verdict.ts).
const CLOSING_NOTE =
  'You must write the reply now, without calling a tool. Say what you did, what you found, and what is still '
  + 'to do, in plain words; do not mention limits, budgets or rounds. Then end with exactly one line on its own: '
  + '[continue] if work you were asked for is still to do, or [done] if it is finished.';
/** The closing note when no further continuation can be queued: the reply
 *  says what remains and that the person can ask it to go on. No verdict
 *  line is asked for, because nothing would read it. */
const CLOSING_NOTE_FINAL =
  'You must write the reply now, without calling a tool. Say what you did, what you found, and what is still '
  + 'to do, in plain words; do not mention limits, budgets or rounds. If work you were asked for is still to do, '
  + 'say that the person can ask you to go on in their next message.';
/** Why the reply is being closed. */
type ClosingReason = 'rounds' | 'context' | 'deadline';
/** Handed back for a tool call the loop did not run because a bound tripped
 *  while the model was asking for it. */
const NOT_RUN = { error: 'Not run: answer now from what you have.' } as const;

interface TextBlock { type: 'text'; text: string }
interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
interface ToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string }
/** An image on a user turn. Declared here for the same reason every other block
 *  shape is: this module names its own conversation vocabulary, and the LLM
 *  client names a structurally identical one on the other side of the call. */
interface ImageBlock { type: 'image'; mimeType: string; dataBase64: string; alt?: string }
type AnyContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock;

/**
 * Watch for a stop while a model call is in flight.
 *
 * shouldStop is checked before each call and between tool calls, which stops
 * the loop spending anything further. It cannot end the call already running,
 * and that call is where the time goes: a slow completion plus its retry chain
 * (four attempts backing off to 8s each) leaves somebody who pressed Stop
 * watching text arrive for another half minute. This polls on the same spacing
 * while the call is outstanding and cancels it.
 */
function startStopWatcher(
  shouldStop: () => Promise<boolean>,
  abortController: AbortController,
  onStopped: () => void,
): { stop: () => void } {
  let finished = false;
  const timer = setInterval(() => {
    void shouldStop()
      .then((stop) => {
        if (!stop || finished) return;
        finished = true;
        clearInterval(timer);
        onStopped();
        abortController.abort(new Error('user_stop'));
      })
      .catch(() => undefined);
  }, MID_RUN_POLL_MIN_INTERVAL_MS);
  // A poll timer must never be the reason the process stays alive.
  timer.unref?.();
  return {
    stop: () => {
      finished = true;
      clearInterval(timer);
    },
  };
}

export async function* runPlatformAgent(
  input: PlatformAgentExecutionInput,
): AsyncIterable<PlatformAgentEvent> {
  const config = await loadPlatformAgentConfig(input.agentId);
  const startedAt = Date.now();

  await writeAgentAuditLog({
    tenantId: input.tenantId,
    internalAgentId: input.agentId,
    threadId: input.threadId,
    action: `${input.auditAction}.started`,
    inputArgs: { objective: input.objective.slice(0, 500) },
    outcome: 'success',
    triggeredBy: input.triggeredBy,
  });

  // Rendered from the template and the tool list only. Both are constant for the
  // whole of a turn's tool-use loop and across the turns of a conversation,
  // which is what makes this a cacheable prefix worth marking.
  //
  // Nothing per-turn is substituted here. The CAIO's plan state used to be, and
  // it is the one value in the prompt that a tool call rewrites mid-run, so it
  // moved the prefix on precisely the turns that ran the most rounds. It now
  // rides the conversation as context, where a change costs the turn that made
  // it and nothing before it. `{{PLAN_STATE}}` still substitutes, to the empty
  // string, so a seeded template carrying the token is unaffected.
  const systemPrompt = renderSystemPrompt(config.systemPromptTemplate, {
    tools: input.tools.map((t) => ({ name: t.name, description: t.description })),
  });

  // The kickoff turn. It carries blocks rather than a bare string only when
  // there are images to carry: images lead, text follows, on the vendors' own
  // guidance and for a concrete reason — a question that arrives before the
  // picture it asks about is answered from the conversation instead of the
  // image.
  const kickoff: { role: 'user'; content: string | AnyContentBlock[] } =
    input.objectiveImages && input.objectiveImages.length > 0
      ? {
          role: 'user',
          content: [
            ...input.objectiveImages.map((img) => ({
              type: 'image' as const,
              mimeType: img.mimeType,
              dataBase64: img.dataBase64,
              ...(img.alt ? { alt: img.alt } : {}),
            })),
            { type: 'text' as const, text: input.objective },
          ],
        }
      : { role: 'user', content: input.objective };

  let conversation: Array<{ role: 'user' | 'assistant'; content: string | AnyContentBlock[] }> = [
    ...(input.priorMessages ?? []),
    kickoff,
  ];

  let iteration = 0;
  let accumulatedText = '';
  let cumulativeInputTokens = 0;
  let cumulativeOutputTokens = 0;
  const toolCallsForResult: PlatformAgentExecutionResult['toolCalls'] = [];
  let terminator: PlatformAgentExecutionResult['terminator'] = 'normal';
  let errorCode: string | undefined;
  let errorMessage: string | undefined;
  // Mid-run state (ADR-041). Both stay inert for callers that pass neither
  // shouldStop nor claimUserMessage, which is how HRBP runs are unaffected.
  let stoppedMidCall = false;
  let lastMessagePollAt = 0;
  // Set once, when the reply must go out: the next model call is the closing
  // one, with no tools. Never set for a run that has no reply to close.
  let closing: ClosingReason | null = null;
  // Set when the last call's prompt filled the guarded share of the window:
  // the round IN FLIGHT is answered "not run". The closing itself is decided
  // at the top of the next pass, from the same reading, so the precedence
  // between the three bounds is taken in one place.
  let contextFull = false;
  // The last call's reading, kept across passes so the bound at the top of the
  // loop is ONE decision over all three bounds rather than a precedence this
  // file re-implements. Undefined before the first call, and for a relay that
  // reports neither field — the window half is then inert rather than tripping
  // on a zero, which would close every reply on its first call.
  let lastContextTokens: number | undefined;
  let lastRecordedContextWindow: number | undefined;
  // The closing reply's verdict: true when the model said work it was asked
  // for is still to do, or when the reply carried no verdict at all (a bound
  // closed it, and a model that never writes the line is treated as
  // unfinished); false when it said the work is done. Undefined for a run no
  // bound closed.
  let unfinished: boolean | undefined;
  const deadlinePassed = (): boolean =>
    input.reply?.deadlineAt !== undefined && Date.now() >= input.reply.deadlineAt;
  let injectionContinuations = 0;
  let truncationContinuations = 0;
  // Set only by the `max_tokens` path below, which prefills the text so far and
  // asks the model to carry on the SAME assistant message. Every other
  // iteration starts a new one. See the boundary note in the text-block loop.
  let continuingSameMessage = false;
  const abortController = new AbortController();

  /** Claim one message waiting for this turn, framed for the model. Framing
   *  carries sender attribution and says the task continues rather than
   *  restarts. */
  const claimFramedMessage = async (): Promise<string | null> => {
    if (!input.claimUserMessage) return null;
    return await input.claimUserMessage();
  };

  toolLoop: while (true) {
    // Checked before spending another LLM call rather than after, so pressing
    // stop stops the billable work and not just the rendering.
    if (input.shouldStop && (await input.shouldStop())) {
      terminator = 'stopped';
      break toolLoop;
    }

    // The rounds and the tokens are bounded for every caller. A run with a
    // reply to deliver gets one more call past either bound — or past its
    // deadline — to write it; any other run simply ends there, as its text is
    // read by nobody.
    if (closing === null) {
      const reason: ClosingReason | null = decideTurnBound({
        iteration,
        maxIterations: MAX_ITERATIONS,
        contextTokens: lastContextTokens,
        recordedContextWindow: lastRecordedContextWindow,
        deadlinePassed: deadlinePassed(),
      }).close;
      if (reason) {
        if (!input.reply) {
          terminator = reason === 'context' ? 'context_full' : reason === 'deadline' ? 'deadline' : 'max_iterations';
          break toolLoop;
        }
        closing = reason;
        terminator = reason === 'rounds' ? 'max_iterations' : reason === 'context' ? 'context_full' : 'deadline';
        conversation = [...conversation, { role: 'user', content: input.reply.askVerdict === false ? CLOSING_NOTE_FINAL : CLOSING_NOTE }];
      }
    }

    iteration++;

    let turnStopReason = 'end_turn';
    const pendingToolUses: ToolUseBlock[] = [];
    // What the relay said about this call's prompt and the served model's
    // window, read out of the try below for the guard after it.
    let turnContextTokens: number | undefined;
    let turnContextWindow: number | undefined;
    let turnContextWindowRecorded: number | undefined;
    let turnModel: string | undefined;

    try {
      // The check above cannot reach a call that is already running, so a
      // watcher runs alongside it and cancels it (see startStopWatcher).
      const watcher = input.shouldStop
        ? startStopWatcher(input.shouldStop, abortController, () => {
            stoppedMidCall = true;
          })
        : null;
      let response;
      try {
        response = await callPBLlmComplete({
          systemPrompt,
          conversation,
          tools: closing
            ? []
            : input.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.input_schema,
              })),
          maxTokens: MAX_TURN_OUTPUT_TOKENS,
          tenantId: input.tenantId,
          tier: config.modelConfig.tier ?? 'medium',
          purpose: input.usagePurpose,
          ...(input.shouldStop ? { signal: abortController.signal } : {}),
        });
      } finally {
        watcher?.stop();
      }

      turnStopReason = response.stop_reason ?? 'end_turn';
      cumulativeInputTokens += response.usage.input_tokens;
      cumulativeOutputTokens += response.usage.output_tokens;
      turnContextTokens = response.usage.context_tokens;
      turnContextWindow = response.context_window;
      turnModel = response.model;
      lastContextTokens = response.usage.context_tokens;
      // The RECORDED window, never the fallback the relay already substituted
      // into `context_window`: the policy needs to know which it has. A relay
      // older than the field reports none, and the policy then applies the
      // same conservative fallback the control plane would have.
      lastRecordedContextWindow = response.context_window_recorded;
      turnContextWindowRecorded = response.context_window_recorded;

      // Each pass of this loop is one model response, and one model response is
      // one assistant message as the person reads it. Nothing else marks where
      // one ends and the next begins: concatenating the text of iteration N
      // straight onto iteration N+1 makes a transcript read "Drafting the plan
      // now.Approved. Both teams are being set up now:" — two replies either
      // side of a tool call, glued at the full stop.
      //
      // The separator is written into `accumulatedText` and streamed, because
      // both are read: the stream is what the person watches, and the string is
      // what chat-service persists and what a reload, a /share link and the
      // Liftoff mirror show afterwards. It is sized to what the text already
      // ends with, so a message that closed on its own newline does not open a
      // gap of four.
      //
      // The `max_tokens` continuation below is the one iteration that is NOT a
      // new message: it prefills the text so far and asks the model to finish
      // the sentence it was cut off in. That path sets `continuingSameMessage`.
      let firstTextBlockOfMessage = true;

      // The closing call's text is HELD rather than yielded block by block:
      // its last line is the verdict, model-only, and a delta that reached
      // the stream before the line was removed would show it on screen.
      // Read whole, stripped, then yielded as one piece.
      const closingTextBlocks: string[] = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          if (closing !== null) {
            closingTextBlocks.push(block.text);
            continue;
          }
          // How big the gap is, and what the next message keeps of the
          // whitespace it opened with, are decided in one place for every
          // surface that assembles a turn (assistant-message-boundary.ts).
          const opened = firstTextBlockOfMessage && !continuingSameMessage
            ? openAssistantMessage(accumulatedText, block.text)
            : { gap: '', text: block.text };
          firstTextBlockOfMessage = false;
          if (opened.gap) {
            accumulatedText += opened.gap;
            yield { type: 'text_delta', text: opened.gap };
          }
          accumulatedText += opened.text;
          yield { type: 'text_delta', text: opened.text };
        } else if (block.type === 'tool_use') {
          pendingToolUses.push(block);
        }
      }

      if (closing !== null) {
        const read = readClosingVerdict(closingTextBlocks.join(''));
        // No verdict line is read as unfinished: a bound closed the turn, and
        // the caller's cap on continuations bounds a model that never writes
        // the line. Read only when one was asked for; the final note asks for
        // none, and a missing line then means nothing.
        if (input.reply?.askVerdict !== false) unfinished = read.verdict !== 'done';
        if (read.text) {
          const opened = continuingSameMessage
            ? { gap: '', text: read.text }
            : openAssistantMessage(accumulatedText, read.text);
          if (opened.gap) {
            accumulatedText += opened.gap;
            yield { type: 'text_delta', text: opened.gap };
          }
          accumulatedText += opened.text;
          yield { type: 'text_delta', text: opened.text };
        }
      }

      // Consumed. Only the branch that sets it again resumes a message.
      continuingSameMessage = false;
    } catch (err) {
      if (stoppedMidCall) {
        // The call did not fail — it was cancelled because somebody pressed
        // Stop. That is a stop, with whatever text had already arrived.
        terminator = 'stopped';
        break toolLoop;
      }
      terminator = 'error';
      errorCode = 'PROVIDER_ERROR';
      errorMessage = (err as Error).message;
      // A closing call that failed: a bound closed the reply and the call
      // that was to write it did not return. The work is unfinished.
      if (closing !== null && input.reply?.askVerdict !== false) unfinished = true;
      yield { type: 'error', code: errorCode, message: errorMessage, ...(closing !== null ? { closingCallFailed: true } : {}) };
      break toolLoop;
    }

    // The watcher may have claimed the stop while the call was still returning.
    if (stoppedMidCall) {
      terminator = 'stopped';
      break toolLoop;
    }

    // The context guard, on the call that just returned: the prompt it carried
    // against the window of the model that served it.
    //
    // A relay that reports no PROMPT SIZE leaves the guard inert — tripping on
    // a zero would close every reply on its first call. A relay that reports
    // no recorded WINDOW no longer does: it used to, which meant an unsized
    // model ran with no guard at all, and the shared policy's conservative
    // fallback governs that case now. The two silences are different facts and
    // this is the difference.
    {
      const contextTokens = turnContextTokens;
      // The rounds and the deadline are decided at the top of the loop, where
      // the round in flight has already been run; what is asked here is the
      // per-call half, because a full window must stop the tools THIS call
      // just asked for.
      const bound = decideTurnBound({
        contextTokens,
        recordedContextWindow: turnContextWindowRecorded,
      });
      if (bound.close === 'context') {
        log.warn(
          {
            agentId: input.agentId,
            tenantId: input.tenantId,
            contextTokens,
            contextWindow: bound.window.tokens,
            // The provenance travels with the number: a ratio against the
            // conservative fallback is a different claim from one against the
            // model's own recorded window.
            contextWindowSource: bound.window.source,
            contextRatio: bound.ratio,
            relayContextWindow: turnContextWindow,
            model: turnModel,
          },
          'Platform agent call filled the guarded share of the context window',
        );
        // A run with a reply closes it (below, and at the top of the next
        // pass); any other run ends here, before the round it just asked for
        // is run.
        if (!input.reply) {
          terminator = 'context_full';
          break toolLoop;
        }
        contextFull = true;
      }
    }

    // `max_tokens` means the model was cut off mid-generation, not that it
    // finished. Treating the two as the same state is what let a turn end with
    // an empty message and no tool call: every token had gone into a tool_use
    // block that never closed, so there was nothing to execute and nothing to
    // say.
    //
    // Resume by prefilling with the text produced so far — the model continues
    // that same assistant message. Incomplete tool_use blocks are dropped
    // rather than replayed: their arguments are truncated JSON, so they cannot
    // be executed, and the model re-issues the call as it continues.
    if (turnStopReason === 'max_tokens' && truncationContinuations < MAX_TRUNCATION_CONTINUATIONS) {
      truncationContinuations++;
      log.warn(
        { agentId: input.agentId, tenantId: input.tenantId, attempt: truncationContinuations },
        'Platform agent turn hit the output ceiling — resuming the assistant message',
      );
      pendingToolUses.length = 0;
      if (accumulatedText) {
        conversation = [...conversation, { role: 'assistant', content: accumulatedText }];
        // The next pass finishes the sentence this one was cut off in, so it
        // must not open a paragraph in the middle of it.
        continuingSameMessage = true;
        continue toolLoop;
      }
      // Nothing to prefill with: the whole output ceiling went into an
      // unfinished tool call. Re-running the same turn would truncate the same
      // way, so let the normal end-of-turn path record it rather than spin.
      // Not a bound of this loop's (the rounds, the window, the deadline),
      // and not the provider's fault either: the ceiling is ours, so it is
      // recorded under its own name rather than as a provider error.
      terminator = 'output_truncated';
      errorCode = 'OUTPUT_TRUNCATED';
      errorMessage = 'the output ceiling was reached inside an unfinished tool call';
      break toolLoop;
    }

    if (turnStopReason !== 'tool_use' || pendingToolUses.length === 0) {
      // The model is done. Before ending the turn, look once more: a message
      // that landed after the last tool call has no boundary left to be
      // consumed at, and claiming it anywhere else would mark it delivered and
      // then drop it. If one is waiting, append it and run another model turn
      // so it is actually answered.
      if (input.claimUserMessage && injectionContinuations < MAX_INJECTION_CONTINUATIONS) {
        lastMessagePollAt = Date.now();
        if (input.shouldStop && (await input.shouldStop())) {
          terminator = 'stopped';
          break toolLoop;
        }
        const trailing = await claimFramedMessage();
        if (trailing) {
          injectionContinuations++;
          conversation = [
            ...conversation,
            ...(accumulatedText ? [{ role: 'assistant' as const, content: accumulatedText }] : []),
            { role: 'user', content: trailing },
          ];
          continue toolLoop;
        }
      }
      break toolLoop;
    }

    // The closing call was given no tools; a call it makes anyway is not run.
    if (closing) break toolLoop;

    const toolResultContents: ToolResultBlock[] = [];

    for (const toolUse of pendingToolUses) {
      // The deadline and the token budget are read before each call as well
      // as at the top: a round's calls can each take a minute, and the check
      // at the top alone would let a round that started just before the
      // deadline run every one of them past it. A call is answered rather
      // than dropped, because a tool_use with no result is a malformed
      // conversation, and the model then reads why it did not run.
      if (contextFull || deadlinePassed()) {
        toolResultContents.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(NOT_RUN),
        });
        continue;
      }
      // Also checked here: the model can come back with several tool calls at
      // once, and a stop pressed during a slow first one should not be made to
      // wait out the rest.
      if (input.shouldStop && (await input.shouldStop())) {
        terminator = 'stopped';
        break toolLoop;
      }

      yield { type: 'tool_call', tool: toolUse.name, input: toolUse.input };

      await writeAgentAuditLog({
        tenantId: input.tenantId,
        internalAgentId: input.agentId,
        threadId: input.threadId,
        action: `${input.auditAction}.tool_called`,
        inputArgs: { tool: toolUse.name, input: toolUse.input },
        outcome: 'success',
        triggeredBy: input.triggeredBy,
      });

      let result: { ok: boolean; data: unknown };
      try {
        result = await input.dispatchToolCall(toolUse.name, toolUse.input, input.toolContext);
      } catch (err) {
        if (err instanceof HrbpBlockerException) {
          // The tool itself recorded the blocker in hrbp_provisioning_events
          // and via audit log before throwing — terminate the agent loop
          // immediately without surfacing a synthetic tool_result.
          terminator = 'tool_blocker';
          break toolLoop;
        }
        if (err instanceof PlatformAgentHandoverException) {
          // The rest of the reply is a colleague's. Same shape as the blocker:
          // the loop ends here, with no synthetic tool_result and no closing
          // call, and the caller runs the hand-over on what was said so far.
          terminator = 'handed_over';
          break toolLoop;
        }
        result = { ok: false, data: { error: (err as Error).message } };
      }

      toolCallsForResult.push({ name: toolUse.name, input: toolUse.input, output: result.data });
      yield { type: 'tool_result', tool: toolUse.name, result: result.data };

      // THE SEAM. This one line is where every tool result this agent has ever
      // run became model context, at whatever size it happened to be. A caller
      // that can read a dataset (CAIO chat) parks an oversized one here and the
      // model gets its view; one that cannot (the HRBP fan-out) supplies no
      // parker and reads the serialization exactly as before.
      //
      // The event above and the audit trail keep `result.data` whole either
      // way: what is bounded is the context, not the record.
      const serialized = JSON.stringify(result.data);
      toolResultContents.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: input.parkToolResult
          ? await input.parkToolResult(toolUse.name, result.data, serialized)
          : serialized,
      });
    }

    if (terminator !== 'normal') break toolLoop;

    // A message typed while the turn was running is picked up HERE — after a
    // tool result, which is the only boundary where another model turn is
    // guaranteed. Claiming one at the end of an assistant message would mark it
    // delivered with nothing left to answer it.
    let injectedMessage: string | null = null;
    if (
      input.claimUserMessage
      && Date.now() - lastMessagePollAt >= MID_RUN_POLL_MIN_INTERVAL_MS
    ) {
      lastMessagePollAt = Date.now();
      injectedMessage = await claimFramedMessage();
    }

    conversation = [
      ...conversation,
      {
        role: 'assistant',
        content: [
          ...(accumulatedText ? [{ type: 'text' as const, text: accumulatedText }] : []),
          ...pendingToolUses,
        ],
      },
      { role: 'user', content: toolResultContents },
      // Its own entry, appended AFTER the tool-result entry on purpose:
      // convertConversationToPBMessages drops text from a user turn that
      // carries tool_result blocks, so folding the message into that entry
      // would deliver an empty message and lose what the person typed.
      ...(injectedMessage ? [{ role: 'user' as const, content: injectedMessage }] : []),
    ];
  }

  const result: PlatformAgentExecutionResult = {
    // A stop is a deliberate ending, not a failure: the partial text is real
    // and the caller persists it like any other reply.
    ok: terminator === 'normal' || terminator === 'tool_blocker' || terminator === 'stopped' || terminator === 'handed_over',
    text: accumulatedText,
    toolCalls: toolCallsForResult,
    inputTokens: cumulativeInputTokens,
    outputTokens: cumulativeOutputTokens,
    terminator,
    ...(unfinished !== undefined ? { unfinished } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  };

  await writeAgentAuditLog({
    tenantId: input.tenantId,
    internalAgentId: input.agentId,
    threadId: input.threadId,
    action: `${input.auditAction}.completed`,
    inputArgs: { iterations: iteration, terminator },
    outputSummary: accumulatedText.slice(0, 4000),
    outcome: terminator === 'normal' || terminator === 'stopped' || terminator === 'handed_over' ? 'success'
      : terminator === 'tool_blocker' ? 'gated' : 'error',
    ...(errorCode ? { errorCode } : {}),
    triggeredBy: input.triggeredBy,
    durationMs: Date.now() - startedAt,
  });

  yield { type: 'complete', summary: result };
}
