// The Gmail query is evaluated by Gmail, not by us.
//
// It is Gmail's search language, and it was being evaluated here by a
// hand-written subset: six operators, no negation, no booleans, and
// `default: return false` for everything else. The POLLING path meanwhile
// handed the identical string to Gmail as `q` (connector-service
// google-mail.ts:344). One string, two engines — and every divergence dropped
// customer mail silently, because an operator we did not implement looks
// exactly like an email that did not match.
//
// A binding such as
// `is:unread to:support@example.com -label:support/handled` matched NOTHING.
// `-label:` splits to the key `-label`, no case handles it, so every inbound
// support email was skipped with `gmail_query_no_match`.
//
// A first cut at delegation left the symptom unmoved: same skip, same reason,
// same customer email dropped. Two defects, one log line.
//
//   1. It read `resp.data`. ExecuteResponse's payload field is `result` —
//      tool-gateway/service.ts:1931 maps it out as `data: resp.result ?? null`,
//      which is where the wrong name came from. `resp.data` is `undefined` for
//      every call, so `items` was always `[]` and the answer was always
//      "no match", for every message, with `decided: true`. The live
//      connector answers the same query with
//      `{"success":true,"result":{"items":[{"id":"<message id>",...}]}}`
//      — the message is there, under a field nobody read.
//
//   2. It identified the message by `rfc822msgid:`. Composio's
//      GMAIL_NEW_GMAIL_MESSAGE payload carries no headers at all — it is
//      `{id, message_id, thread_id, subject, sender, to, message_text,
//      label_ids}` — so the RFC 5322 Message-ID does not exist on the event
//      being filtered. Had defect 1 been fixed alone, every event would have
//      failed open instead, and the binding would have silently filtered
//      nothing.
//
// Both are fixed by asking a simpler question: run the binding query unchanged
// and look for the message's GMAIL id in the results. That id is on the payload,
// it is the same `items[].id` the search returns, and comparing it composes no
// query text at all.
//
// Source-level: the delegation sits on the Pub/Sub dispatch path, which needs a
// live subscription, a database and a connector client to enter.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'event-trigger.ts'), 'utf8');

const delegation = SRC.slice(
  SRC.indexOf('async function gmailQueryMatchesViaGmail'),
  SRC.indexOf('interface GmailBindingForAgent'),
);

describe('the question is asked of Gmail', () => {
  it('has a body to assert against', () => {
    expect(delegation.length).toBeGreaterThan(600);
  });

  it('dispatches list_messages through the connector', () => {
    expect(delegation).toContain("functionName: 'list_messages'");
    expect(delegation).toContain('getConnectorServiceClient');
  });

  it('sends the binding query UNMODIFIED', () => {
    // No wrapping, no appended clause, nothing escaped into Gmail's grammar.
    expect(delegation).toContain('await ask(args.query)');
    expect(delegation).not.toContain('rfc822msgid:');
  });
});

describe('the response is read from the field that carries it', () => {
  // The regression that made the first delegation a no-op.
  it('reads `result`', () => {
    expect(delegation).toContain("(resp as { result?: unknown }).result");
  });

  it('does not read `data`', () => {
    expect(delegation).not.toMatch(/resp\s*as\s*\{\s*data\?/);
    expect(delegation).not.toMatch(/\)\.data\b/);
  });

  it('records why the wrong name was reachable', () => {
    // `data` is what the tool-gateway calls it downstream, so the name is not
    // obviously wrong when read in isolation — which is why it survived review.
    expect(delegation).toMatch(/`result`, NOT `data`/);
    expect(delegation).toMatch(/tool-gateway\/service\.ts/);
  });
});

describe('identity is the Gmail message id', () => {
  it('takes the id from the same envelope the workflow templates read', () => {
    expect(delegation).toContain('buildEventMessageEnvelope(');
    expect(delegation).toContain("'google_mail',");
  });

  it('matches by comparing ids, not by counting results', () => {
    // `items.length > 0` would report a match whenever ANY mail matched the
    // binding, including mail that is not this event.
    expect(delegation).toContain('filtered.includes(msgId)');
    expect(delegation).not.toContain('items.length > 0');
  });

  it('caps both questions with the parameter the vendor actually reads', () => {
    // `max_results` is accepted and silently ignored — asked the live connector
    // for 3 and for 7, got 50 both times. A cap that does not apply reads as a
    // bound the comparison relies on, and is not one.
    expect(delegation).toContain('maxResults: GMAIL_MATCH_PAGE');
    expect(delegation).not.toMatch(/max_results\s*:/);
    // One `ask` used for both, so the caps cannot drift apart.
    expect(delegation.match(/functionName: 'list_messages'/g) ?? []).toHaveLength(1);
  });

  it('rests the no-match verdict on equal caps, and says why', () => {
    // Newest-N-overall ∩ matching ⊆ newest-N-matching, so a message present in
    // the control and absent from the filtered page was excluded by the query.
    expect(delegation).toMatch(/Equal caps/);
    expect(delegation).toMatch(/newest N MATCHING messages/);
  });

  it('records that Composio sends no RFC 5322 Message-ID', () => {
    const doc = SRC.slice(
      SRC.indexOf(' * Does this message match the binding'),
      SRC.indexOf('async function gmailQueryMatchesViaGmail'),
    );
    expect(doc).toMatch(/carries no headers at all/);
    expect(doc).toMatch(/GMAIL MESSAGE ID/);
  });
});

describe('it fails open, and says so', () => {
  it('returns undecided rather than false when the event has no id', () => {
    expect(delegation).toContain("matched: true, decided: false, reason: 'no_gmail_message_id'");
  });

  it('returns undecided when the message is not searchable yet', () => {
    // Gmail's index trails delivery, and we are called seconds after arrival.
    // Without this, indexing lag reads as "did not match" and drops the mail.
    expect(delegation).toContain("reason: 'message_not_yet_searchable'");
    expect(delegation).toContain("await ask('')");
  });

  it('returns undecided rather than false when Gmail errors', () => {
    const c = delegation.slice(delegation.indexOf('} catch (err) {'));
    expect(c).toContain('matched: true, decided: false');
  });

  it('says no on exactly one path, and only against a complete result set', () => {
    // Only Gmail gets to say "no" — every other exit proceeds.
    const noes = delegation.match(/matched: false/g) ?? [];
    expect(noes).toHaveLength(1);
    const decided = delegation.slice(delegation.indexOf("const control = await ask('')"));
    expect(decided).toContain("matched: false, decided: true, reason: 'not_in_query_results'");
  });
});

describe('the parser it replaced is gone', () => {
  // Left in place it read as live code: exported, covered by ~200 lines of
  // passing tests, and sitting directly above the delegation. The obvious
  // "improvement" is to wire it back as a fallback for when Gmail is
  // unreachable — which would reinstate the original bug on exactly the path
  // where it cannot be observed.
  it('has no definition left to call', () => {
    expect(SRC).not.toContain('function gmailEventMatches');
    expect(SRC).not.toContain('function normalizeGmailMessage');
    expect(SRC).not.toContain('function getNativeHeader');
  });
});

describe('the dispatch site', () => {
  const ANCHOR = 'const gmailBinding = await getAgentConnectorBinding<';
  const site = SRC.slice(SRC.indexOf(ANCHOR), SRC.indexOf(ANCHOR) + 2800);

  it('logs an undecidable predicate at ERROR and proceeds', () => {
    expect(site).toMatch(/logger\.error\('gmailQuery could not be evaluated/);
    expect(site).toMatch(/processing the event anyway/);
  });

  it('does not file a non-skip under the skip metric', () => {
    // That metric is the one number answering "how much mail are we dropping".
    const undecided = site.slice(site.indexOf('if (!verdict.decided)'), site.indexOf('} else if (!verdict.matched)'));
    // The CALL, not the word — the comment beside it names the function.
    expect(undecided).not.toMatch(/recordTriggerSkip\(/);
    expect(undecided).toContain('Deliberately NOT recordTriggerSkip');
  });

  it('still skips — and records it — when Gmail says it does not match', () => {
    expect(site).toContain("recordTriggerSkip('connector_event', 'gmail_query_no_match')");
  });

  it('logs the evidence, not just the conclusion', () => {
    // A check that answered "no" to every message for a day logged exactly the
    // same line as one working correctly. The query alone was not enough to
    // tell them apart.
    const skip = site.slice(site.indexOf('} else if (!verdict.matched)'));
    expect(skip).toContain('reason: verdict.reason');
    expect(skip).toContain('matchedCount: verdict.observed');
  });

  it('proceeds when the binding carries no connector to ask', () => {
    expect(site).toContain("reason: 'no_connector_binding_id'");
  });
});
