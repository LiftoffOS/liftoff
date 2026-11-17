// A transient failure with nothing said yet goes back to the queue.
//
// The behaviour has three halves that only make sense together, and the failure
// mode if any one is missing is user-visible:
//
//   * throw instead of apologising, but ONLY when nothing has streamed — a
//     mid-stream retry would re-answer a question the person can already see
//     part of, and bill for it twice;
//   * take the surface's own "working on it" marker down first — both workers
//     put one up before the turn runs, so without this each retry would leave a
//     permanent hourglass, or a typing indicator that outlives its turn, in the
//     customer's channel. That is the opposite of the invisible recovery this
//     path exists for;
//   * record the failed delivery attempt, so a turn that never lands is visible
//     in chat_delivery_obligations rather than merely absent.
//
// Pinned at the source level because the alternative is standing up the whole
// Slack/Teams adapter, an SSE turn stream and a Cloud Tasks receiver to observe
// three statements — and the thing that actually breaks is one of them being
// dropped in a later edit, which is exactly what this sees.

import { readFileSync } from 'fs';
import { resolve } from 'path';

const slack = readFileSync(
  resolve(__dirname, '..', 'slack-adapter', 'slack-chat-worker.ts'), 'utf-8',
);
const teams = readFileSync(
  resolve(__dirname, '..', 'teams-adapter', 'teams-chat-worker.ts'), 'utf-8',
);
const teamsStreamer = readFileSync(
  resolve(__dirname, '..', 'teams-adapter', 'teams-streamer.ts'), 'utf-8',
);

describe.each([
  ['slack', slack],
  ['teams', teams],
])('%s worker — retryable hand-back', (_name, src) => {
  it('only hands back when nothing has reached the person', () => {
    expect(src).toMatch(/streamedAny = true;/);
    expect(src).toMatch(/event\.retryable === true && !streamedAny/);
  });

  it('marks streamedAny on text, and on nothing else', () => {
    // A tool call or a stall notice is not the agent's answer; treating either
    // as "the person has seen something" would disable the retry for most turns.
    const markers = src.match(/streamedAny = true;/g) ?? [];
    expect(markers).toHaveLength(1);
    expect(src).toMatch(/event\.type === 'text_delta'\)\s*\{[\s\S]{0,320}?streamedAny = true;/);
  });

  it('does not apologise on the hand-back path', () => {
    // The break must come BEFORE the append, or the person sees an apology for
    // a turn that is about to be retried and answered properly.
    expect(src).toMatch(/event\.retryable === true && !streamedAny\)\s*\{[\s\S]{0,200}?break;[\s\S]{0,40}?\}\s*\n\s*streamer\.append/);
  });

  it('records the failed attempt and then fails the request', () => {
    expect(src).toMatch(
      /if \(retryableFailure\)[\s\S]{0,900}?markFailed\(tenantId, turnId, retryableFailure\)[\s\S]{0,200}?throw new Error/,
    );
  });

  it('acts outside the catch that turns errors into apologies', () => {
    // Inside it, the throw would be swallowed and the turn would settle as a
    // delivered apology — the exact bug the hand-back exists to avoid.
    const catchIdx = src.indexOf('Sorry, I encountered an error processing your message');
    const handbackIdx = src.indexOf('if (retryableFailure)');
    expect(catchIdx).toBeGreaterThan(-1);
    expect(handbackIdx).toBeGreaterThan(catchIdx);
  });
});

describe('the surface marker is taken down before handing back', () => {
  it('slack deletes the hourglass placeholder it posted', () => {
    // Step 4 posts a fresh placeholder on EVERY delivery, so a retry without
    // this leaves one behind permanently.
    expect(slack).toMatch(
      /if \(retryableFailure\)[\s\S]{0,900}?slackApiCall\('chat\.delete', botToken, \{[\s\S]{0,120}?ts: initialMsg\.ts as string,/,
    );
  });

  it('teams stops the typing indicator it armed', () => {
    // begin() arms a refresh interval that finalize() normally clears; a turn
    // that posts nothing never reaches finalize.
    expect(teams).toMatch(/if \(retryableFailure\)[\s\S]{0,600}?streamer\.abandon\(\);/);
    expect(teamsStreamer).toMatch(/abandon\(\): void \{\s*\n\s*this\.stopTyping\(\);/);
  });
});
