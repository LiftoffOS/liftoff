// What the thread says while a run is working, and what it says when a run ends
// without an answer.
//
// Without these rows a failed turn writes NOTHING. The person's own message is persisted
// the moment they send it; the failure is not. So a run that times out, throws,
// or is refused leaves a thread holding a question and no response — visually
// identical to a message that was never delivered, and indistinguishable from
// an agent still thinking.
//
// A person can wait on a thread whose turn died minutes earlier, or whose turn
// already hit its wall clock partway through a workflow, watching a blank page
// that will never change. They cannot tell whether to wait, retry, or give up,
// because nothing on the surface distinguishes those cases.
//
// These rows are STATUS, not speech. They are written with role 'assistant'
// because they render in the transcript, but nobody said them: they are kept
// out of the model's context and they do not stamp the reply clock, exactly as
// `hitl_status` and `delegation_status` are. A run that narrates its own
// progress must not thereby appear to have answered.

/** Marks a row as narration of a run's progress, so the UI renders it as
 *  status rather than as the team speaking, and so it stays out of the model's
 *  context on the next turn. */
export const RUN_PROGRESS_MESSAGE_TYPE = 'run_progress';

/** The TERMINAL row: this run stopped without an answer.
 *
 *  A distinct type from `run_progress`, and for one reason — the model has to
 *  learn that the run it announced did not finish. The failure it exists for:
 *  turn one promises "The weekly competitor sweep is starting now" for a run
 *  refused a second later; turn two, unable to see the failure and able to see
 *  its own promise, produces a detailed and entirely fictional progress report
 *  and then talks the person out of retrying.
 *
 *  It stays NARRATION, which is why the fact travels as a note on
 *  `conversationSummary` rather than as a row in the history. A failure row
 *  admitted as ordinary assistant speech would become words the model appears
 *  to have said — in rolling summaries, absorption, embeddings, recall and the
 *  reply clock. It is a fact ABOUT the conversation, not a turn in it. */
export const RUN_FAILED_MESSAGE_TYPE = 'run_failed';

/** The factual note the next turn's model is given when the PRECEDING exchange
 *  ended in a failed run.
 *
 *  Scoped to that exchange deliberately: "the most recent failure" stays the
 *  most recent one forever, so a run that succeeded three turns later would
 *  still be introduced as a failure. */
export const RUN_FAILED_SUMMARY_NOTE =
  'The previous run stopped before finishing and produced no result. '
  + 'Do not describe it as still running.';

/** Why a run stopped without producing a reply.
 *
 *  Named rather than free text because the sentence a person reads and the
 *  branch that produced it must not drift apart — and because "what should I do
 *  now" differs per case, which is the only thing the reader actually wants. */
export type RunEndedReason =
  | 'timeout'
  | 'provider_error'
  | 'interrupted'
  | 'busy'
  | 'internal';

/**
 * What a person is told when a run ends without an answer.
 *
 * Says three things, in this order: that it stopped, how far it got when that
 * is known, and what to do next. The progress clause is the one that turns an
 * apology into information — "stopped at step 8 of 16" tells a reader the work
 * was real and roughly where it ran out, which "something went wrong" does not.
 *
 * Deliberately plain about retrying. A reader who cannot tell whether their
 * request was lost will send it again anyway; saying so makes that a decision
 * rather than a guess.
 */
export function runEndedMessage(
  reason: RunEndedReason,
  progress?: {
    step?: string | null;
    stepNumber?: number | null;
    totalSteps?: number | null;
    /** What the run actually got done before it stopped, as a noun-phrase
     *  list from RunProgressTracker. The clause that keeps a failure from
     *  reading as though nothing happened. */
    activity?: string | null;
  },
  /** What the RUNTIME said about this failure, when it said anything.
   *
   *  The control plane collapses every runtime failure onto one error code, so
   *  a sentence rebuilt from the code alone cannot tell "busy, try shortly"
   *  from "that request could not be processed as written". A validation
   *  failure was told "Trying again is safe" and the person retried 25 seconds
   *  later into a run that could not have worked. */
  outcome?: {
    /** The runtime's own user-safe sentence, relayed rather than re-derived.
     *  Set only when the runtime classified the failure; an older revision
     *  that sends no `failureClass` leaves this unset and the code-derived
     *  clause below stands. */
    nextStep?: string | null;
    /** The runtime's verdict, not a guess. Absent means it did not say. */
    retryable?: boolean;
  },
): string {
  const where = progress?.stepNumber && progress?.totalSteps
    ? ` It reached step ${progress.stepNumber} of ${progress.totalSteps}${progress.step ? ` (${progress.step})` : ''}.`
    : progress?.step
      ? ` It reached ${progress.step}.`
      : '';

  const did = progress?.activity ? ` Work done before it stopped: ${progress.activity}.` : '';

  /** The "what to do next" clause.
   *
   *  The runtime's own sentence when it classified the failure, and the
   *  code-derived one otherwise.
   *
   *  The retry question has THREE answers, not two, and collapsing them costs
   *  something either way. `retryable: false` is the runtime saying a retry
   *  cannot work — that is the defect this parameter exists for, and a
   *  code-derived clause claiming a retry is safe is suppressed outright. An
   *  ABSENT verdict is not a "no": it is every failure this service raises
   *  itself (a thrown handler, a busy team) and an older runtime revision,
   *  where the code-derived advice is the only advice there is and has always
   *  been true. Withholding it there would take a useful sentence away from
   *  every unclassified failure to fix one that is always classified. */
  const advice = (fallback: string, claimsRetryIsSafe = false): string => {
    if (outcome?.nextStep) return ` ${outcome.nextStep}`;
    if (claimsRetryIsSafe && outcome?.retryable === false) return '';
    return fallback ? ` ${fallback}` : '';
  };

  switch (reason) {
    case 'timeout':
      return 'This run hit its time limit before it finished, so there is no answer to show.'
        + where
      + did
        + ' Work already written to your documents or connected systems was still saved.'
        + advice('Asking for a narrower piece of it will usually finish.');
    case 'busy':
      return 'This team is still working on an earlier request, so this one did not start.'
        + ' Nothing was lost.'
        + advice('Send it again once the current run finishes.');
    case 'interrupted':
      return 'This run was stopped before it finished, so there is no answer to show.'
        + where + did + advice('');
    case 'provider_error':
      return 'This run stopped on an error before it could answer.'
        + where
      + did
        + ' Anything already saved to your documents or connected systems is still there.'
        + advice('Trying again is safe.', true);
    case 'internal':
    default:
      return 'This run stopped before it could answer, and the cause was on our side.'
        + where
      + did
        + advice('Trying again is safe; if it keeps happening the run needs a person to look at it.', true);
  }
}

// ── What a run is doing, while it is doing it ─────────────────────────────
//
// The terminal row above says why a run stopped. This half says what it is
// doing before it stops, because on a long run the two failures a reader
// cannot tell apart are "still working" and "already dead", and both look like
// an empty thread.
//
// Only the CONNECTION carries this today: the tool_call frames stream to an
// open browser and are never written down. A turn that runs for ten minutes
// outlives the tab, so the row is what survives.

/** Coarse kinds of work, in the order a summary reports them. Deliberately
 *  few: a reader wants to know the shape of the work, not the tool names. */
type ActivityKind = 'search' | 'read' | 'write' | 'delegate' | 'command' | 'other';

/** Tools whose whole purpose is finding something nobody has a URL for. */
const SEARCH_TOOLS = new Set([
  'web_search',
  'web_research',
  'web_deep_research',
  'web_people_search',
  'web_finance_search',
]);

/** Tools that read a page whose URL is already known. */
const READ_TOOLS = new Set(['web_fetch_advanced', 'web_fetch']);

/** Tools that run something rather than fetching or writing. */
const COMMAND_TOOLS = new Set(['shell_exec', 'bash', 'run_command', 'code_execution']);

/** The runtime's own MCP server, which is not a system anybody did work in.
 *
 *  Every tool the agent reaches through the gateway carries this segment,
 *  including the connector tools whose OWN alias sits in the segment after it.
 *  Named here rather than matched loosely because dropping the wrong leading
 *  segment would attribute a connector's work to whatever preceded it. */
const GATEWAY_SERVER_ID = 'liftoff-tool-gateway';

/** A connector's tools arrive namespaced, either as the SDK's `mcp__<server>__<tool>`
 *  or as the bare `<server>__<tool>`. The server half is an ALIAS — `${type}-${first8}`
 *  of the connector id — so the id suffix is dropped to leave the system's name.
 *
 *  The gateway's own id can sit in front of that alias, and used to be read as
 *  the system: `mcp__liftoff-tool-gateway__run_routine_now` reported work done
 *  in "Liftoff Tool Gateway", which is a piece of our plumbing rather than
 *  anywhere the person has an account. The `-[0-9a-f]{8}` alias strip is
 *  written for the connector alias, which on this path is the SECOND segment.
 *  So the gateway segment is dropped and the rest split again. */
function splitNamespacedTool(toolName: string): { system: string | null; tool: string } {
  const withoutPrefix = toolName.startsWith('mcp__') ? toolName.slice(5) : toolName;
  const withoutGateway = withoutPrefix.startsWith(`${GATEWAY_SERVER_ID}__`)
    ? withoutPrefix.slice(GATEWAY_SERVER_ID.length + 2)
    : withoutPrefix;
  const sep = withoutGateway.indexOf('__');
  if (sep <= 0) return { system: null, tool: withoutGateway };
  const rawSystem = withoutGateway.slice(0, sep).replace(/-[0-9a-f]{8}$/i, '');
  return { system: rawSystem || null, tool: withoutGateway.slice(sep + 2) };
}

/** Title-case a connector alias for display: `google_docs` becomes `Google Docs`. */
function displaySystem(system: string): string {
  return system
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function classify(toolName: string): { kind: ActivityKind; system: string | null } {
  const { system, tool } = splitNamespacedTool(toolName);
  if (SEARCH_TOOLS.has(tool)) return { kind: 'search', system: null };
  if (READ_TOOLS.has(tool)) return { kind: 'read', system: null };
  if (COMMAND_TOOLS.has(tool)) return { kind: 'command', system: null };
  // A write is recognised by what it does, not by which system it does it in,
  // so a document created through a connector counts as a document written
  // rather than as one more anonymous action.
  if (/(^|_)(create|write|append|update|upload|insert)(_|$)/.test(tool)
    && /(document|doc|file|sheet|page|record)/.test(tool)) {
    return { kind: 'write', system: null };
  }
  if (system) return { kind: 'other', system };
  return { kind: 'other', system: null };
}

function plural(n: number, singular: string, many: string): string {
  return `${n} ${n === 1 ? singular : many}`;
}

/** Track what a run has done, and decide when the thread should be told.
 *
 *  Counts rather than a transcript: a run makes tens of calls, and a reader
 *  scrolling a thread wants the shape of the work in one line, not a log. The
 *  same counts serve the live line, the finished line and the failure row, so
 *  the three can never describe the same run differently.
 */
export class RunProgressTracker {
  private readonly startedAt: number;
  private readonly counts = new Map<ActivityKind, number>();
  private readonly systems = new Map<string, number>();
  /** Call ids already counted, so a repeated frame does not count twice. */
  private readonly countedCallIds = new Set<string>();
  private lastWrittenAt = 0;
  private lastLine: string | null = null;
  private settled = false;
  private step: { index: number; total: number } | null = null;

  constructor(now: number = Date.now()) {
    this.startedAt = now;
  }

  noteToolCall(toolName: string, callId?: string): void {
    // ONE CALL IS ONE CALL, however many frames carry it.
    //
    // This counted frames. A run that made six write attempts was reported as
    // "12 documents written" while exactly one document existed, and the panel
    // also claimed "26 actions in Google Docs" against two reads in the ledger.
    // A person reading that cannot tell a busy run from a broken one, and it
    // made every run look worse than it was.
    //
    // Deduplicated on the engine's own call id rather than by finding whatever
    // delivers a frame twice: a replayed stream, a reconnect, a seam that
    // reports a call more than once — any of them inflates a per-frame count,
    // and the id tells a duplicate from a second call in every case. A frame
    // with no id is still counted, so an engine that supplies none is no worse
    // off than before.
    if (callId !== undefined) {
      if (this.countedCallIds.has(callId)) return;
      this.countedCallIds.add(callId);
    }
    const { kind, system } = classify(toolName);
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
    if (system) {
      const label = displaySystem(system);
      this.systems.set(label, (this.systems.get(label) ?? 0) + 1);
    }
  }

  /** Where a long run has got to.
   *
   *  Counts alone cannot narrate a workflow run: its step loop dispatches tools
   *  itself rather than through the adapter, so it reports no tool calls at all.
   *  The position is also the one fact that turns an apology into information
   *  when such a run ends without an answer. */
  noteStep(index: number, total: number): void {
    if (index > 0 && total > 0) this.step = { index, total };
  }

  /** The run's position, for the sentence a person reads if it ends badly. */
  position(): { stepNumber: number; totalSteps: number } | null {
    return this.step ? { stepNumber: this.step.index, totalSteps: this.step.total } : null;
  }

  noteDelegation(): void {
    this.counts.set('delegate', (this.counts.get('delegate') ?? 0) + 1);
  }

  /** The work so far as a noun-phrase list, or null when nothing has happened
   *  yet. One phrasing, reused by every frame that reports on this run. */
  activitySummary(): string | null {
    const parts: string[] = [];
    const n = (k: ActivityKind) => this.counts.get(k) ?? 0;
    if (n('search')) parts.push(plural(n('search'), 'web search', 'web searches'));
    if (n('read')) parts.push(plural(n('read'), 'page read', 'pages read'));
    if (n('write')) parts.push(plural(n('write'), 'document written', 'documents written'));
    if (n('delegate')) {
      parts.push(plural(n('delegate'), 'task handed to another team', 'tasks handed to other teams'));
    }
    if (n('command')) parts.push(plural(n('command'), 'command run', 'commands run'));
    for (const [system, count] of this.systems) {
      parts.push(`${plural(count, 'action', 'actions')} in ${system}`);
    }
    // Anonymous calls are reported only when they are all there is, so a run
    // that did recognisable work is not padded with a meaningless count.
    const anonymous = n('other') - [...this.systems.values()].reduce((a, b) => a + b, 0);
    if (anonymous > 0 && parts.length === 0) {
      parts.push(plural(anonymous, 'step', 'steps'));
    }
    return parts.length > 0 ? parts.join(', ') : null;
  }

  /** Whole minutes elapsed, or null below a minute — a run that took seconds
   *  does not need its duration explained. */
  private minutes(now: number): number | null {
    const mins = Math.floor((now - this.startedAt) / 60_000);
    return mins >= 1 ? mins : null;
  }

  /**
   * The progress line to persist now, or null when the thread should stay
   * quiet: nothing has happened, the run is still young enough that silence is
   * normal, the last write was recent, or the line would say what it already
   * says.
   *
   * Returning the line MARKS it written, so a caller cannot persist twice or
   * report progress it did not store.
   */
  takeLine(now: number = Date.now()): string | null {
    // Cheap guards first. This runs on every event a turn produces, which on a
    // streaming turn means once per token delta, so the summary is not built
    // until the clocks say a row could actually be written.
    if (this.settled) return null;
    if (now - this.startedAt < FIRST_PROGRESS_AFTER_MS) return null;
    if (now - this.lastWrittenAt < PROGRESS_UPDATE_EVERY_MS) return null;
    const summary = this.activitySummary();
    const where = this.step ? ` Step ${this.step.index} of ${this.step.total}.` : '';
    // Either half is worth saying on its own: a workflow run has a position and
    // no tool counts, a conversational one has counts and no position.
    if (!summary && !where) return null;
    const line = `This run is still working.${where}`
      + (summary ? ` So far: ${summary}.` : '');
    if (line === this.lastLine) return null;
    this.lastWrittenAt = now;
    this.lastLine = line;
    return line;
  }

  /** True once a progress row exists for this run, so the terminal row can
   *  replace it rather than adding a second status line beneath it. */
  hasWritten(): boolean {
    return this.lastLine !== null;
  }

  /** Stop narrating: this run has produced its last row.
   *
   *  The rule lives here rather than in the order the caller happens to write
   *  its branches, because a stale "still working" line landing on top of the
   *  outcome is exactly the failure this whole file exists to prevent, and it
   *  is invisible until a run is slow enough to reach the update interval.
   *
   *  Settling is FINAL, and every row-producing method honours it. It was
   *  written in one place and read in another for a while: `run_parked`
   *  settled the tracker precisely to suppress the past-tense row, and
   *  `finishedLine` set the flag without ever reading it — so the terminal
   *  frame that follows a park wrote "This run took 12 minutes. Work done: …"
   *  over a run that went on working for another five. Three comments stated
   *  the intent (the park branch, the yield above it, and this one) and no
   *  line of code carried it. */
  settle(): void {
    this.settled = true;
  }

  /** True once this run has had its last word, whatever gave it. */
  isSettled(): boolean {
    return this.settled;
  }

  /** What the progress row becomes once the run has answered. Past tense,
   *  because the reply is right below it: the row stops being a status and
   *  becomes the record of why the answer took as long as it did.
   *
   *  Null once settled. A settled tracker has already said its last thing, and
   *  on the one path that settles early — a run handed to the background —
   *  there is no reply below this row at all, so past tense is a false claim
   *  about work that is still in flight. */
  finishedLine(now: number = Date.now()): string | null {
    if (this.settled) return null;
    this.settle();
    const summary = this.activitySummary();
    if (!summary) return null;
    // Deliberately no step position here: the answer is below it, so where the
    // run got to is no longer the interesting part.
    const mins = this.minutes(now);
    const took = mins ? `This run took ${plural(mins, 'minute', 'minutes')}. ` : '';
    return `${took}Work done: ${summary}.`;
  }
}

/** A run answers in seconds far more often than it does not, and a status row
 *  on a fast turn is noise. Nothing is written until silence has lasted long
 *  enough to be worth explaining. */
const FIRST_PROGRESS_AFTER_MS = 45_000;

/** One row is UPDATED in place rather than appended to, so the interval bounds
 *  writes, not rows: a ten-minute run leaves one line, not thirty. */
const PROGRESS_UPDATE_EVERY_MS = 20_000;
