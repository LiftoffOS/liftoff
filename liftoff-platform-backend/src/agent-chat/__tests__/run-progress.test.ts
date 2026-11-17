// A run that ends without an answer must say so in the thread.
//
// The gap this closes: the person's message is persisted the instant they send
// it; the failure never was. A turn that timed out, threw, or was refused left
// a thread holding a question and no response — the same thing a reader sees
// when a message was never delivered, and the same thing they see while an
// agent is still thinking. A person can wait on an already-dead turn because
// those three states look identical.
//
// The error EVENT is not the fix and never was. It reaches a browser that is
// still connected; these turns run for minutes and the person has usually gone.
// The ROW is what survives.

import {
  RUN_PROGRESS_MESSAGE_TYPE,
  RUN_FAILED_MESSAGE_TYPE,
  RunProgressTracker,
  runEndedMessage,
  type RunEndedReason,
} from '../run-progress';
import {
  isConversationRow,
  narrationSqlList,
  NARRATION_MESSAGE_TYPES,
} from '../transcript-context';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('what a person is told when a run ends without an answer', () => {
  it('says it stopped, and what to do about it', () => {
    const text = runEndedMessage('timeout');
    expect(text).toMatch(/time limit/i);
    // The advice is the point. "Something went wrong" is not actionable.
    expect(text).toMatch(/narrower/i);
  });

  it('says HOW FAR it got when that is known', () => {
    // The clause that turns an apology into information: it tells the reader
    // the work was real and roughly where it ran out.
    const text = runEndedMessage('timeout', { stepNumber: 8, totalSteps: 16, step: 'sweep competitors' });
    expect(text).toContain('step 8 of 16');
    expect(text).toContain('sweep competitors');
  });

  it('omits the progress clause rather than guessing at it', () => {
    expect(runEndedMessage('timeout')).not.toMatch(/step \d/);
  });

  it('does not tell someone to retry a run that is merely queued behind another', () => {
    // AGENT_BUSY is not a failure of this turn, and telling the reader to retry
    // immediately would be advice that fails the same way.
    const text = runEndedMessage('busy');
    expect(text).toMatch(/still working on an earlier request/i);
    expect(text).toMatch(/once the current run finishes/i);
  });

  it('tells a reader their saved work survived a timeout', () => {
    // The competitive-analysis run wrote a real document two minutes in and then
    // died eight minutes later. "Nothing to show" without this clause would have
    // been actively misleading.
    expect(runEndedMessage('timeout')).toMatch(/still saved|still there/i);
    expect(runEndedMessage('provider_error')).toMatch(/still there|still saved/i);
  });

  it('gives every reason its own sentence', () => {
    const reasons: RunEndedReason[] = ['timeout', 'provider_error', 'interrupted', 'busy', 'internal'];
    const texts = reasons.map((r) => runEndedMessage(r));
    expect(new Set(texts).size).toBe(reasons.length);
    for (const t of texts) expect(t.length).toBeGreaterThan(20);
  });

  it('takes the next step from the runtime on a failure it called permanent', () => {
    // The case: the runtime sends failureClass 'validation', retryable false
    // and "That request could not be processed as written." A row that says
    // "Trying again is safe" invites a retry into a run that cannot work.
    const text = runEndedMessage('provider_error', undefined, {
      nextStep: 'That request could not be processed as written. Try rephrasing it.',
      retryable: false,
    });
    expect(text).not.toContain('Trying again is safe');
    expect(text).toContain('could not be processed as written');
  });

  it('keeps the first two clauses whatever the runtime said', () => {
    // What stopped, and how far it got, are this service's facts and stay.
    const text = runEndedMessage(
      'provider_error',
      { stepNumber: 8, totalSteps: 16, activity: '1 action in Google Docs' },
      { nextStep: 'Try rephrasing it.', retryable: false },
    );
    expect(text).toContain('stopped on an error');
    expect(text).toContain('step 8 of 16');
    expect(text).toContain('Work done before it stopped: 1 action in Google Docs.');
  });

  it('says a retry is safe when the runtime says so', () => {
    expect(runEndedMessage('provider_error', undefined, { retryable: true }))
      .toContain('Trying again is safe');
  });

  it('keeps the code-derived advice when nobody classified the failure', () => {
    // Absent is not "no". Every failure this service raises itself — a thrown
    // handler, a busy team — carries no runtime verdict, and so does an older
    // runtime revision. The code-derived sentence is the only advice there is
    // on those, and it has always been true; withholding it would take a useful
    // sentence away from every unclassified failure to fix one that is always
    // classified.
    expect(runEndedMessage('provider_error')).toContain('Trying again is safe');
    expect(runEndedMessage('internal')).toContain('Trying again is safe');
  });

  it('withholds it the moment the runtime says a retry cannot work', () => {
    // The same case, from the other direction: this is the ONE answer that
    // changes the copy, and it is the answer the mapping used to drop.
    expect(runEndedMessage('provider_error', undefined, { retryable: false }))
      .not.toContain('Trying again is safe');
    expect(runEndedMessage('internal', undefined, { retryable: false }))
      .not.toContain('Trying again is safe');
  });

  it('keeps the code-derived advice that makes no retry claim', () => {
    // These two are not retry invitations, so the runtime's silence says
    // nothing about them and they stand.
    expect(runEndedMessage('timeout')).toMatch(/narrower/i);
    expect(runEndedMessage('busy')).toMatch(/once the current run finishes/i);
  });

  it('is typed as status, not as speech', () => {
    // Written with role 'assistant' because it renders in the transcript, but
    // nobody said it. The type is what keeps it out of the model's context and
    // off the reply clock.
    expect(RUN_PROGRESS_MESSAGE_TYPE).toBe('run_progress');
    // And the terminal row has its OWN type, so the next turn can find it and
    // tell the model the run stopped. Still narration, never speech.
    expect(RUN_FAILED_MESSAGE_TYPE).toBe('run_failed');
    expect(isConversationRow({ messageType: RUN_FAILED_MESSAGE_TYPE })).toBe(false);
  });
});

describe('the row is status, not a reply', () => {
  it('does not stamp the reply clock', () => {
    // A thread told "this hit its time limit" has been informed and has NOT been
    // answered. Stamping last_agent_message_at would clear the unread dot on a
    // question that is still open — the same defect hitl_status rows were
    // already excluded for.
    const repo = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'chat-repository.ts'), 'utf8',
    ) as string;
    const start = repo.indexOf('const isTeamReply');
    expect(start).toBeGreaterThan(-1);
    // To the end of the statement, so the assertion cannot pass or fail on how
    // much explanatory comment happens to sit inside the clause.
    const clause = repo.slice(start, repo.indexOf(';', start));
    expect(clause).toContain('RUN_PROGRESS_MESSAGE_TYPE');
  });

  it('is kept out of anything built FROM the conversation', () => {
    // A progress row read back as conversation would have the team replying to
    // its own status notice.
    //
    // Asserted on the PREDICATE rather than by counting inline comparisons.
    // Counting was the earlier form of this test and it went vacuous the moment
    // the comparisons moved: zero occurrences on both sides still matched.
    expect(isConversationRow({ messageType: RUN_PROGRESS_MESSAGE_TYPE })).toBe(false);
    expect(isConversationRow({ messageType: 'hitl_status' })).toBe(false);
    expect(isConversationRow({ messageType: 'delegation_status' })).toBe(false);
    expect(isConversationRow({ messageType: 'forwarded_context' })).toBe(false);
    // The person's browser events: the segment reaches the model through the
    // Browser section, and the row is the person's, not the team's.
    expect(isConversationRow({ messageType: 'browser_handback' })).toBe(false);
    expect(isConversationRow({ messageType: 'browser_point' })).toBe(false);
    // Ordinary speech, typed or not.
    expect(isConversationRow({ messageType: null })).toBe(true);
    expect(isConversationRow({})).toBe(true);
    expect(isConversationRow({ messageType: 'file_output' })).toBe(true);
  });

  it('is excluded by every reader that filters in SQL, from that same predicate', () => {
    // Two readers filter in the DATABASE rather than in TypeScript, and both
    // were written by hand. The conversation-preview one named six types and
    // never named `run_progress`, so "This run took 12 minutes. Work done: 14
    // web searches" was quoted back to a model as something the two of them
    // said. A list restated in SQL is the same defect this module exists to
    // prevent, one layer down.
    const list = narrationSqlList();
    for (const t of NARRATION_MESSAGE_TYPES) expect(list).toContain(`'${t}'`);
    expect(list).toContain(`'${RUN_FAILED_MESSAGE_TYPE}'`);
    expect(list).toContain(`'${RUN_PROGRESS_MESSAGE_TYPE}'`);

    // A reader whose exclusions are a SUPERSET keeps its own extras AND every
    // narration type, with no duplicates.
    const withExtras = narrationSqlList(['suggestion', RUN_PROGRESS_MESSAGE_TYPE]);
    expect(withExtras).toContain("'suggestion'");
    expect(withExtras.match(/'run_progress'/g)).toHaveLength(1);

    // And both real call sites are built from it rather than restating it.
    const src = (f: string) => readFileSync(join(__dirname, '..', '..', f), 'utf8');
    expect(src('chat-recall/recall-conversations.ts')).toContain('narrationSqlList()');
    expect(src('internal-api/platform-tools-router.ts')).toContain('narrationSqlList([');
  });

  it('is filtered by that ONE predicate at every reader, not by four comparisons', () => {
    // The failure this shape prevents: a fifth narration type added to some
    // readers and not others, so the model's history and the rolling summary
    // quietly disagree about what was said.
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..');
    const svc = fs.readFileSync(path.join(dir, 'chat-service.ts'), 'utf8') as string;
    // Both readers: the model's history and the rolling summary.
    expect(svc.split('.filter(isConversationRow)').length - 1).toBe(2);
    expect(svc).not.toMatch(/messageType !== HITL_STATUS_MESSAGE_TYPE/);

    // And the third reader, which had no filter at all: an observer absorbing
    // what it missed used to remember status rows as things a colleague said.
    const absorb = fs.readFileSync(path.join(dir, 'context-absorption.ts'), 'utf8') as string;
    expect(absorb).toContain('filter(isConversationRow)');
  });
});

describe('every failure branch is covered, by construction', () => {
  it('persists from the WRAPPER, so a branch added tomorrow is covered by existing', () => {
    // The core yields `type: 'error'` from eight places. A rule applied at eight
    // sites is a rule that gets missed at the ninth, so the row is written in
    // the single loop every event passes through.
    const svc = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'chat-service.ts'), 'utf8',
    ) as string;
    const wrapper = svc.slice(
      svc.indexOf('export async function* runAgentChatTurn('),
      svc.indexOf('async function* runAgentChatTurnCore('),
    );
    expect(wrapper).toMatch(/event\.type === 'error'/);
    expect(wrapper).toMatch(/persistRunEnded/);
  });

  it('never lets narration itself throw', () => {
    // Making the status path able to fail would be worse than the gap it
    // closes. Asserted on the ONE function that writes these rows, which is
    // also why there is one: every caller inherits the guard.
    const svc = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'chat-service.ts'), 'utf8',
    ) as string;
    const writer = svc.slice(svc.indexOf('async function persistProgressLine('));
    const body = writer.slice(0, writer.indexOf('\n}'));
    expect(body).toMatch(/try\s*{/);
    expect(body).toMatch(/catch/);
    // And the failure row goes through it rather than writing its own.
    const ended = svc.slice(
      svc.indexOf('async function persistRunEnded('),
      svc.indexOf('async function persistProgressLine('),
    );
    expect(ended).toContain('persistProgressLine(');
    expect(ended).not.toContain('appendMessage(');
  });

  it('says nothing when there is no exchange to narrate', () => {
    // A branch that refuses BEFORE the turn and the person's message are
    // inserted (empty message, unknown team) leaves nothing on screen to attach
    // a status row to. Keyed on whether a turn id was issued rather than on a
    // list of the codes that happen to return early today -- the same reason the
    // row is written in the wrapper and not at each yield.
    const svc = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'chat-service.ts'), 'utf8',
    ) as string;
    expect(svc).toMatch(/event\.type === 'error' && turnExists/);
    expect(svc).toMatch(/turnExists = true;/);
  });
});

describe('what the thread is told WHILE a run is working', () => {
  const START = 1_000_000;
  const AFTER_THRESHOLD = START + 60_000;

  it('stays quiet on a turn that answers quickly', () => {
    // The common turn answers in seconds. A status row on it is noise, and
    // noise is how people learn to stop reading status rows.
    const t = new RunProgressTracker(START);
    t.noteToolCall('web_research');
    expect(t.takeLine(START + 10_000)).toBeNull();
    expect(t.hasWritten()).toBe(false);
  });

  it('stays quiet when a long run has done nothing worth reporting', () => {
    const t = new RunProgressTracker(START);
    expect(t.takeLine(AFTER_THRESHOLD)).toBeNull();
  });

  it('says what the work actually was, not that work is happening', () => {
    // "Working..." is what a spinner already says. The counts are the part a
    // reader cannot get from the screen.
    const t = new RunProgressTracker(START);
    t.noteToolCall('web_research');
    t.noteToolCall('web_people_search');
    t.noteToolCall('web_fetch_advanced');
    expect(t.takeLine(AFTER_THRESHOLD)).toBe(
      'This run is still working. So far: 2 web searches, 1 page read.',
    );
  });

  it('does not rewrite the row to say what it already says', () => {
    const t = new RunProgressTracker(START);
    t.noteToolCall('web_research');
    expect(t.takeLine(AFTER_THRESHOLD)).not.toBeNull();
    // Interval passed, nothing new happened.
    expect(t.takeLine(AFTER_THRESHOLD + 60_000)).toBeNull();
  });

  it('holds an update back until the interval has passed', () => {
    // Bounds writes, not rows: a ten-minute run leaves one line either way,
    // but it must not spend a database write per tool call to get there.
    const t = new RunProgressTracker(START);
    t.noteToolCall('web_research');
    expect(t.takeLine(AFTER_THRESHOLD)).not.toBeNull();
    t.noteToolCall('web_research');
    expect(t.takeLine(AFTER_THRESHOLD + 1_000)).toBeNull();
    expect(t.takeLine(AFTER_THRESHOLD + 21_000)).toContain('2 web searches');
  });

  it('counts a document as written wherever it was written', () => {
    // Recognised by what the call does, so a document created through a
    // connector reads as a document rather than as one more anonymous action.
    const t = new RunProgressTracker(START);
    t.noteToolCall('mcp__googledocs-1a2b3c4d__create_document_markdown');
    expect(t.takeLine(AFTER_THRESHOLD)).toContain('1 document written');
  });

  it('names the system an action happened in, without its connector id', () => {
    // The tool namespace is an alias -- `${type}-${first8}` of the connector
    // id. A reader gets no information from the hex.
    const t = new RunProgressTracker(START);
    t.noteToolCall('mcp__github-1a2b3c4d__list_issues');
    t.noteToolCall('github-1a2b3c4d__list_pull_requests');
    expect(t.takeLine(AFTER_THRESHOLD)).toContain('2 actions in Github');
  });

  it('names the system behind the gateway, not the gateway', () => {
    // The three real shapes. `mcp__` strips, and then the SECOND segment is
    // the connector alias — the `-[0-9a-f]{8}` strip is written for that one.
    // Reading the gateway's own id as the system reported "1 action in Liftoff
    // Tool Gateway", which is a piece of our plumbing rather than anywhere the
    // person has an account.
    const bare = new RunProgressTracker(START);
    bare.noteToolCall('web_research');
    expect(bare.takeLine(AFTER_THRESHOLD)).toContain('1 web search');

    const standard = new RunProgressTracker(START);
    standard.noteToolCall('mcp__liftoff-tool-gateway__run_routine_now');
    // A platform step happened in no system at all, so none is named.
    const standardLine = standard.takeLine(AFTER_THRESHOLD)!;
    expect(standardLine).not.toMatch(/Gateway/i);
    expect(standardLine).not.toMatch(/ in /);

    const connector = new RunProgressTracker(START);
    connector.noteToolCall('mcp__liftoff-tool-gateway__google-docs-8fd9fc68__create_document_markdown');
    expect(connector.takeLine(AFTER_THRESHOLD)).toContain('1 document written');

    const connectorAction = new RunProgressTracker(START);
    connectorAction.noteToolCall('mcp__liftoff-tool-gateway__google-docs-8fd9fc68__get_document');
    expect(connectorAction.takeLine(AFTER_THRESHOLD)).toContain('1 action in Google Docs');
  });

  it('reports a hand-over as a hand-over, and never says "agent"', () => {
    const t = new RunProgressTracker(START);
    t.noteDelegation();
    const line = t.takeLine(AFTER_THRESHOLD)!;
    expect(line).toContain('1 task handed to another team');
    expect(line).not.toMatch(/agent/i);
  });

  it('turns past tense once the answer is below it', () => {
    // The row stops being a status and becomes the record of why the answer
    // took as long as it did.
    const t = new RunProgressTracker(START);
    t.noteToolCall('web_research');
    const finished = t.finishedLine(START + 9 * 60_000)!;
    expect(finished).toContain('This run took 9 minutes');
    expect(finished).toContain('Work done: 1 web search.');
    expect(finished).not.toMatch(/still working/);
  });

  it('does not explain a duration nobody noticed', () => {
    const t = new RunProgressTracker(START);
    t.noteToolCall('web_research');
    expect(t.finishedLine(START + 30_000)).toBe('Work done: 1 web search.');
  });

  it('tells a failed run what it got done', () => {
    // A failure that lists the work it completed is a different thing to read
    // from one that says nothing happened.
    const t = new RunProgressTracker(START);
    t.noteToolCall('web_research');
    t.noteToolCall('web_fetch_advanced');
    const text = runEndedMessage('timeout', { activity: t.activitySummary() });
    expect(text).toContain('Work done before it stopped: 1 web search, 1 page read.');
  });

  it('says nothing extra when a run that did nothing fails', () => {
    const t = new RunProgressTracker(START);
    expect(runEndedMessage('timeout', { activity: t.activitySummary() }))
      .toBe(runEndedMessage('timeout'));
  });

  it('does not attach work to a run that never started', () => {
    // AGENT_BUSY is the queue answering, not this run reporting.
    expect(runEndedMessage('busy', { activity: '3 web searches' })).not.toContain('3 web searches');
  });
});

describe('narration APPENDS, so the trace survives', () => {
  // It used to be one row rewritten in place, which showed only the run's
  // latest state: every earlier update vanished as the next replaced it. Worse,
  // a rewritten row keeps its original created_at, so the final text sorted to
  // where the FIRST update had been — a run that parked after twelve minutes
  // read as "This run took 12 minutes. Work done: …" positioned ABOVE the
  // notice saying it was still going.
  it('appends each line rather than rewriting one row', () => {
    const svc = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'chat-service.ts'), 'utf8',
    ) as string;
    const writer = svc.slice(
      svc.indexOf('async function persistProgressLine('),
      svc.indexOf('async function* runAgentChatTurnCore('),
    );
    expect(writer).toContain('appendMessage(');
    expect(writer).not.toContain('updateRunProgressMessage(');
  });

  it('does not call a parked run finished', () => {
    // The parked path yields a terminal `complete` so the client stops
    // streaming. Read as an ending, that wrote a past-tense summary over a run
    // that was still working.
    const svc = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'chat-service.ts'), 'utf8',
    ) as string;
    expect(svc).toMatch(/event\.type === 'run_parked'\)[\s\S]{0,600}progress\.settle\(\)/);
  });

  it('rewrites nothing, so it can never alter something a person said', () => {
    // The in-place update this replaces needed a message_type guard in its
    // statement to avoid rewriting any row in the thread. An append needs no
    // such guard, because it touches nothing that already exists.
    const repo = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'chat-repository.ts'), 'utf8',
    ) as string;
    expect(repo).not.toContain('updateRunProgressMessage');
  });
});

describe('the outcome is the last word', () => {
  // A stale "still working" line landing ON TOP of the outcome is the exact
  // failure this file exists to prevent, and it only appears on runs slow
  // enough to reach the update interval -- which is every run that gets a row
  // at all. So the rule is the tracker's, not the caller's branch order.
  const START = 2_000_000;

  it('says nothing more once it has reported a finish', () => {
    const t = new RunProgressTracker(START);
    t.noteToolCall('web_research');
    expect(t.takeLine(START + 60_000)).not.toBeNull();
    expect(t.finishedLine(START + 120_000)).not.toBeNull();

    // More work arrives, the interval has long passed, the summary has changed:
    // every condition that would otherwise produce a line.
    t.noteToolCall('web_research');
    expect(t.takeLine(START + 300_000)).toBeNull();
  });

  it('says nothing more once the run has been settled by a failure', () => {
    const t = new RunProgressTracker(START);
    t.noteToolCall('web_research');
    expect(t.takeLine(START + 60_000)).not.toBeNull();
    t.settle();
    t.noteToolCall('web_fetch_advanced');
    expect(t.takeLine(START + 300_000)).toBeNull();
  });

  it('settles the tracker on the failure path', () => {
    const svc = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'chat-service.ts'), 'utf8',
    ) as string;
    const ended = svc.slice(
      svc.indexOf('async function persistRunEnded('),
      svc.indexOf('async function persistProgressLine('),
    );
    expect(ended).toContain('progress.settle()');
  });
});

describe('a run that finishes as soon as it starts working', () => {
  it('does not write its first progress line after its own reply', () => {
    // The narrow case the settle-on-complete rule closes: past the silence
    // threshold, first tool call and the answer arriving together. Without it
    // the thread would end "This run is still working" underneath a finished
    // reply.
    const t = new RunProgressTracker(3_000_000);
    t.noteToolCall('web_research');
    t.finishedLine(3_000_000 + 60_000);       // completion, nothing written yet
    expect(t.takeLine(3_000_000 + 60_001)).toBeNull();
  });

  it('leaves no row at all when none was ever written', () => {
    const svc = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'chat-service.ts'), 'utf8',
    ) as string;
    // The finish is only PERSISTED when a status row already exists: a turn
    // that answered without one stays clean.
    expect(svc).toMatch(/if \(finished && progress\.hasWritten\(\)\)/);
  });
});

describe('a run that reports steps and nothing else', () => {
  // A workflow's step loop dispatches tools itself rather than through the
  // adapter, so it emits NO tool calls -- a tracker that counted only tool
  // calls would say nothing, and a person would watch an empty thread while
  // the run worked.
  const START = 4_000_000;

  it('narrates from the step position alone', () => {
    const t = new RunProgressTracker(START);
    t.noteStep(9, 16);
    expect(t.takeLine(START + 60_000)).toBe('This run is still working. Step 9 of 16.');
  });

  it('says both when it has both', () => {
    const t = new RunProgressTracker(START);
    t.noteStep(4, 16);
    t.noteToolCall('web_research');
    expect(t.takeLine(START + 60_000))
      .toBe('This run is still working. Step 4 of 16. So far: 1 web search.');
  });

  it('advances as the run advances', () => {
    const t = new RunProgressTracker(START);
    t.noteStep(2, 16);
    expect(t.takeLine(START + 60_000)).toContain('Step 2 of 16');
    t.noteStep(3, 16);
    expect(t.takeLine(START + 81_000)).toContain('Step 3 of 16');
  });

  it('still says nothing when a run has reported nothing at all', () => {
    const t = new RunProgressTracker(START);
    expect(t.takeLine(START + 60_000)).toBeNull();
  });

  it('ignores a position that is not one', () => {
    const t = new RunProgressTracker(START);
    t.noteStep(0, 0);
    expect(t.takeLine(START + 60_000)).toBeNull();
  });

  it('hands the position to the sentence a person reads when it fails', () => {
    // runEndedMessage has carried a stepNumber/totalSteps argument since the
    // day it was written and nothing ever passed one.
    const t = new RunProgressTracker(START);
    t.noteStep(8, 16);
    const text = runEndedMessage('timeout', { ...t.position()!, activity: t.activitySummary() });
    expect(text).toContain('step 8 of 16');
  });

  it('is passed on the failure path, not just available', () => {
    const svc = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'chat-service.ts'), 'utf8',
    ) as string;
    const ended = svc.slice(
      svc.indexOf('async function persistRunEnded('),
      svc.indexOf('async function persistProgressLine('),
    );
    expect(ended).toContain('progress.position()');
  });

  it('is fed from the event the runtime actually sends', () => {
    const svc = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'chat-service.ts'), 'utf8',
    ) as string;
    expect(svc).toMatch(/event\.type === 'workflow_step'\) progress\.noteStep/);
  });
});

describe('a settled run has had its last word', () => {
  // The defect: `run_parked` settles the tracker precisely to suppress the
  // past-tense row, because a parked run is still working somewhere else. The
  // terminal `complete` frame for the CHAT TURN arrives immediately after it
  // and called `finishedLine()`, which set `settled` without ever reading it.
  //
  // What a person saw: progress rows, then "This is taking longer than one
  // chat turn. It is continuing in the background", then "This run took 12
  // minutes. Work done: ..." — and then the actual answer five minutes later.
  // The run was announced as finished twice, with different work in each.
  const minute = 60_000;

  const working = (now: number) => {
    const t = new RunProgressTracker(now);
    t.noteToolCall('web_research');
    t.noteToolCall('web_fetch_advanced');
    return t;
  };

  it('writes no finished line after a park', () => {
    const t = working(0);
    t.settle();                                   // what `run_parked` does
    expect(t.finishedLine(12 * minute)).toBeNull();   // what `complete` asked for
  });

  it('still writes one on the ordinary path, where a reply follows it', () => {
    const t = working(0);
    expect(t.finishedLine(12 * minute)).toContain('This run took 12 minutes');
  });

  it('never writes two finished lines for one run', () => {
    // Two terminal frames for one turn is a real shape: the park path yields
    // `run_parked` then `complete`, and a retry of the stream can repeat it.
    const t = working(0);
    expect(t.finishedLine(minute)).not.toBeNull();
    expect(t.finishedLine(2 * minute)).toBeNull();
  });

  it('keeps the progress line suppressed too, as it always did', () => {
    const t = working(0);
    t.settle();
    expect(t.takeLine(5 * minute)).toBeNull();
  });

  it('reports settlement, so a caller can tell a park from an answer', () => {
    const t = working(0);
    expect(t.isSettled()).toBe(false);
    t.settle();
    expect(t.isSettled()).toBe(true);
  });

  it('still reports what the run got done, for the failure row', () => {
    // A settled tracker must keep answering `activitySummary` — the row that
    // says a run stopped is built from it, and suppressing that would turn an
    // informative failure back into "something went wrong".
    const t = working(0);
    t.settle();
    expect(t.activitySummary()).toContain('web search');
  });
});

describe('one call is one call, however many frames carry it', () => {
  // The panel counted FRAMES. A run that made six write attempts was reported
  // as "12 documents written" while exactly one document existed, and the same
  // panel claimed "26 actions in Google Docs" against two reads in the ledger.
  // A person reading that cannot tell a busy run from a broken one.
  //
  // Deduplicated on the engine's own call id rather than by chasing whatever
  // delivers a frame twice — a replayed stream, a reconnect, a seam that
  // reports at two points. Any of those inflates a per-frame count; the id
  // tells a duplicate from a second call in all of them.
  it('counts a repeated frame once', () => {
    const t = new RunProgressTracker(0);
    t.noteToolCall('google-docs__create_document_markdown', 'call-1');
    t.noteToolCall('google-docs__create_document_markdown', 'call-1');
    expect(t.activitySummary()).toBe('1 document written');
  });

  it('counts two DIFFERENT calls of the same tool twice', () => {
    const t = new RunProgressTracker(0);
    t.noteToolCall('google-docs__create_document_markdown', 'call-1');
    t.noteToolCall('google-docs__create_document_markdown', 'call-2');
    expect(t.activitySummary()).toBe('2 documents written');
  });

  it('does not collapse a run with no call ids, so an engine supplying none is no worse off', () => {
    const t = new RunProgressTracker(0);
    t.noteToolCall('google-docs__create_document_markdown');
    t.noteToolCall('google-docs__create_document_markdown');
    expect(t.activitySummary()).toBe('2 documents written');
  });

  it('deduplicates the system tally too, not only the kind', () => {
    // "actions in Google Docs" is a separate counter off the same event, and it
    // was inflated in the same way.
    const t = new RunProgressTracker(0);
    t.noteToolCall('google-docs__get_document', 'c1');
    t.noteToolCall('google-docs__get_document', 'c1');
    t.noteToolCall('google-docs__get_document', 'c2');
    expect(t.activitySummary()).toContain('2 actions in Google Docs');
  });

  it('keeps ids apart across tools', () => {
    // Two engines can reuse an id space; a collision must not hide a call.
    const t = new RunProgressTracker(0);
    t.noteToolCall('web_research', 'c1');
    t.noteToolCall('google-docs__create_document_markdown', 'c1');
    const summary = t.activitySummary()!;
    expect(summary).toContain('1 web search');
    // The second call shares the id, so it is treated as already counted. That
    // is the deliberate trade: an id collision loses a count, a missing dedupe
    // invents one, and inventing is what reached a person.
    expect(summary).not.toContain('document written');
  });
});
