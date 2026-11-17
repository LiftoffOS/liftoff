// A rebuilt ExecutionContext must still know what woke the run.
//
// `triggerTarget` is assembled ONLY when `trigger.kind === 'connector_event'`,
// and the entire in-place carve-out opens with `if (!target) return false`. So a
// context rebuilt without the trigger turns every acknowledgement into an
// approval request: the agent replies to the customer, then has to ask
// permission to mark that same thread as read.
//
// It is a LOOP, not a single stumble. The run pauses, a human approves, the
// resume rebuilds without the trigger, and the very next in-place action pauses
// again — so approving is not progress.
//
// The reply is sent, and `mark_as_read` on the SAME thread (the thread s1
// fetched from `{{input.message.threadId}}`) raises an approval seconds later
// with reason external_content_write. Driving `isInPlaceReply` directly with
// that call returns true under every combination of workRole and categories
// when the target is present, and false only when it is missing.
//
// Same defect as the bindings this rebuild already learned to carry, whose
// comment sits directly above these lines: state that the run depends on, left
// behind at the pause.
//
// `trustLevel` and `inputData` travel with it. trustLevel decides whether the
// external-content invariant applies at all; inputData is both what the
// normalized `message` envelope is read from and what `{{input.*}}` resolves
// against, so a step reading `{{input.message.threadId}}` after a resume would
// otherwise render nothing.
//
// ── The other half: the resume caller has no trigger ─────────────────────
//
// Carrying it off `context` alone wires only one end. The only production
// caller of a resume primitive is the Cloud Tasks handler, which builds a
// `minimalContext` out of the task body — tenantId, agentId, invocationId — and
// has no trigger to pass, because the body is written by the decision path
// (approval router, clarification answer, delegation fan-in), which knows the
// DECISION and not the connector event. So every read above would resolve to
// `undefined` while the code and its comment both looked correct.
//
// The trigger cannot be reconstructed at resume time. The pause is the last
// moment both facts are in hand, so it is persisted there and the rebuild falls
// back to it. Three of the four rebuilds resume from a persisted pause and must
// have that fallback; `wake-poll-` is called in-process by `resumeFromWake` with
// a live context and has no payload to fall back to.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

/** Rebuilds that reconstitute a run from a PERSISTED pause row. Their caller
 *  cannot supply the trigger, so the payload is the only source. */
const PAYLOAD_BACKED = ['resume-clarification-', 'resume-deleg-', 'resume-hitl-'];
/** Called in-process with a live context; no pause payload exists here. */
const IN_PROCESS = ['wake-poll-'];
const REBUILDS = [...PAYLOAD_BACKED, ...IN_PROCESS];

/** The context construction that follows a given traceId stamp. */
function rebuildBlock(prefix: string): string {
  const at = SRC.indexOf(`traceId: \`${prefix}`);
  expect(at).toBeGreaterThan(-1);
  const block = SRC.slice(at, at + 6000);
  const end = block.indexOf('};');
  return end > 0 ? block.slice(0, end) : block;
}

describe('every rebuild carries the trigger', () => {
  it.each(REBUILDS)('%s', (prefix) => {
    const ctx = rebuildBlock(prefix);
    expect(ctx).toContain('trigger: context.trigger');
    expect(ctx).toContain('trustLevel: context.trustLevel');
    expect(ctx).toContain('inputData: context.inputData');
  });

  it('finds every rebuild the file actually has', () => {
    // A new resume path added without these fields reintroduces the loop, and
    // it would be invisible: the run still works, it just asks permission for
    // something it was already granted.
    // Anchored to the start of a line: the field name appears in prose in the
    // comments above, and counting those turns this ratchet into noise.
    const declared = SRC.match(/const rebuiltContext: ExecutionContext = \{/g) ?? [];
    const carried = SRC.match(/^\s+trigger: context\.trigger/gm) ?? [];
    expect(carried.length).toBeGreaterThanOrEqual(declared.length);
    expect(carried).toHaveLength(REBUILDS.length);
  });

  it('still carries the bindings, which the same rebuild lost before', () => {
    // Every context rebuilt FROM AN EXISTING ExecutionContext must carry both.
    // Counted against `context.tenantId` specifically: the other two callers
    // build from bare args (`companion-work-source-`) or start a run outright,
    // and neither has a prior trigger to inherit — one of them sets
    // `inputData: undefined` on purpose.
    const fromContext = SRC.match(/bindingsByType: await this\.buildBindingsByTypeFor\(context\.tenantId,/g) ?? [];
    const carried = SRC.match(/^\s+trigger: context\.trigger/gm) ?? [];
    expect(fromContext).toHaveLength(REBUILDS.length);
    expect(carried).toHaveLength(fromContext.length);
  });
});

describe('a rebuild from a persisted pause falls back to the payload', () => {
  it.each(PAYLOAD_BACKED)('%s', (prefix) => {
    // `context` alone is `undefined` here for every production caller. Reading
    // it without the fallback is the defect this file was written for, one
    // level up: the field is present, the value never is.
    const ctx = rebuildBlock(prefix);
    expect(ctx).toContain('trigger: context.trigger ?? payload.trigger');
    expect(ctx).toContain('trustLevel: context.trustLevel ?? payload.trustLevel');
    expect(ctx).toContain('inputData: context.inputData ?? payload.inputData');
  });

  it('does not claim a fallback the in-process rebuild has no source for', () => {
    // `runWakePollCheck` takes a live context from `resumeFromWake`. Adding a
    // `payload.` read there would name a variable that is not in scope; the
    // point of separating the lists is that this stays a deliberate difference
    // rather than an oversight someone patches by hand.
    for (const prefix of IN_PROCESS) {
      expect(rebuildBlock(prefix)).not.toContain('?? payload.trigger');
    }
  });
});

describe('the pause writes what the resume reads', () => {
  // A fallback to a field nothing ever sets is inert. Both halves, or neither.
  // Every writer of a pause row, whatever the pause kind: a wake or wait-set
  // row that carries none of this cannot be rebuilt from the task body any
  // more than a HITL row can.
  const BUILDERS = [
    'createHitlPause', 'createDelegationPause', 'createClarificationPause',
    'createWakePause', 'createWaitSetPause',
  ];

  it.each(BUILDERS)('%s stamps the trigger onto its payload', (builder) => {
    const at = SRC.search(new RegExp(`(?:public|private) async ${builder}\\(`));
    expect(at).toBeGreaterThan(-1);
    // The stamp sits with the other payload provenance, before the INSERT.
    expect(SRC.slice(at, at + 6000)).toContain('carryTriggerOntoPause(');
  });

  it('routes every pause builder through the one helper', () => {
    // Three inline copies is how `checkHitlGate`'s two call sites drifted, and
    // how this exact field went missing at the site that runs.
    const calls = SRC.match(/carryTriggerOntoPause\(/g) ?? [];
    // One declaration + one call per builder.
    expect(calls).toHaveLength(BUILDERS.length + 1);
  });

  it('never overwrites a value the caller set deliberately', () => {
    // The fan-out passes a per-item `inputData` that is narrower than the
    // context's; clobbering it would hand the resumed half the wrong item.
    const at = SRC.indexOf('function carryTriggerOntoPause(');
    expect(at).toBeGreaterThan(-1);
    const body = SRC.slice(at, SRC.indexOf('\n}', at));
    expect(body).toContain('pauseState.trigger ??= context.trigger;');
    expect(body).toContain('pauseState.trustLevel ??= context.trustLevel;');
    expect(body).toContain('pauseState.inputData ??= context.inputData;');
  });

  it('normalizes the run ids rather than merging them', () => {
    // A blank already on the payload must not survive a real id on the
    // context, so these two are assigned from the first present candidate.
    const at = SRC.indexOf('function carryTriggerOntoPause(');
    const body = SRC.slice(at, SRC.indexOf('\n}', at));
    expect(body).toContain('pauseState.workflowId = firstPresentId(pauseState.workflowId, context.workflowId);');
    expect(body).toContain('pauseState.taskId = firstPresentId(pauseState.taskId, context.taskId);');
  });

  it('stamps the originating account, without which an own-account capability cannot run on resume', () => {
    const at = SRC.indexOf('function carryTriggerOntoPause(');
    const body = SRC.slice(at, SRC.indexOf('\n}', at));
    expect(body).toContain('pauseState.messageSenderAccountId ??= context.messageSenderAccountId || undefined;');
  });
});

describe('the carve-out this protects', () => {
  const inPlace = readFileSync(join(__dirname, '..', '..', 'hitl-enforcement', 'in-place-reply.ts'), 'utf8');

  it('still refuses outright when there is no target', () => {
    // The behaviour is correct and must not be softened to paper over a missing
    // trigger — a carve-out that guesses is a hole. The fix belongs at the
    // rebuild, which is where the information was dropped.
    expect(inPlace).toMatch(/if \(!target\) return false;/);
  });

  it('still requires the ack to name the record that woke the run', () => {
    expect(inPlace).toContain('calledThread === triggerThread');
  });
});
