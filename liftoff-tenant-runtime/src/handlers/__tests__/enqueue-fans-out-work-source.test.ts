// The companion work-source fan-out must exist on the path a Cloud Tasks
// deployment uses.
//
// It was built on `/scheduled-invoke`: resolve the routine's work source, then
// run the graph once per item with a real `input.message`. With
// `USE_CLOUD_TASKS_EXECUTION=true` that endpoint is not called: Cloud Scheduler
// points at `/scheduled-enqueue`, which enqueued ONE task carrying no inputData
// — so every companion routine ran its graph with nothing to read.
//
// A graph that resolves `{{input.message.*}}` — every per-record reactive graph —
// then failed before step 1:
//
//   [UNKNOWN_INPUT_FIELD] toolInputTemplate reads {{input.message.threadId}},
//   but a cron fire carries no input at all
//
// Every cron fire of a support agent fails that way. A few in one hour trip the
// consecutive-failure guard, the agent auto-pauses, and a paused agent is
// deregistered from its event trigger — so inbound customer mail stops being
// answered as well. The routine can be configured correctly and the graph be
// correct, and the two still be joined by a code path nobody ran.
//
// Asserted at source level: the endpoint needs OIDC, Cloud Tasks and a database
// to enter, and the property that matters is that BOTH paths do this — which is
// exactly what a mock of one of them cannot show.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'scheduled-invoke-handler.ts'), 'utf8');
const RECEIVER = readFileSync(join(__dirname, '..', 'cloud-tasks-handler.ts'), 'utf8');
const TASKS = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'cloud-tasks.ts'), 'utf8');

const enqueue = SRC.slice(SRC.indexOf("router.post('/scheduled-enqueue'"));

describe('the enqueue path resolves the work source', () => {
  it('has a body to assert against', () => {
    expect(enqueue.length).toBeGreaterThan(1000);
  });

  it('reads the routine\'s declared work source', () => {
    expect(enqueue).toContain('companion?.workSource');
    expect(enqueue).toContain('resolveCompanionWorkItems');
  });

  it('builds the SAME envelope the event path builds', () => {
    // One envelope contract with two producers. A second shape would drift, and
    // `{{input.message.*}}` would mean different things depending on how the run
    // was started.
    expect(enqueue).toContain('buildEventMessageEnvelope');
  });

  it('marks the run as event-shaped so graph validation accepts it', () => {
    expect(enqueue).toContain('inputSource: workSource.source');
  });

  it('gives each item its own task identity', () => {
    // Task names are built from (agent, scheduleKey, contextRef). Without a
    // per-item contextRef the whole fan-out dedups down to a single task.
    expect(enqueue).toContain('contextRef: `item-${i}`');
  });

  it('treats an unresolvable listing as a failure, not as "no work"', () => {
    // Reporting success for a listing that could not run is the fabricated
    // success INV-TR-004 forbids.
    expect(enqueue).toContain('companion work source failed');
  });

  it('enqueues nothing when there is no work', () => {
    expect(enqueue).toContain('companionWorkItems: 0');
  });

  it('records why this exists on THIS endpoint', () => {
    expect(enqueue).toMatch(/production does not use that endpoint/i);
    expect(enqueue).toMatch(/UNKNOWN_INPUT_FIELD/);
  });
});

describe('the queue carries the marker end to end', () => {
  it('the enqueue helper forwards inputSource', () => {
    expect(TASKS).toContain('inputSource?: string;');
    expect(TASKS).toContain('...(opts.inputSource ? { inputSource: opts.inputSource } : {}),');
  });

  it('the receiver accepts it and hands it to executeTask', () => {
    expect(RECEIVER).toContain('inputSource?: string;');
    expect(RECEIVER).toContain('inputSource: payload.inputSource,');
  });

  it('the receiver still forwards the input itself', () => {
    // inputSource without inputData validates an event contract for a run that
    // has no event — the inverse defect.
    expect(RECEIVER).toContain('inputData: payload.inputData,');
  });
});

describe('the legacy path still does it too', () => {
  it('scheduled-invoke keeps its own fan-out', () => {
    // Not deleted as part of this fix: the endpoint is still reachable, and
    // leaving it enqueueing input-less runs would keep the defect alive behind
    // a flag flip.
    const invoke = SRC.slice(
      SRC.indexOf("router.post('/scheduled-invoke'"),
      SRC.indexOf("router.post('/scheduled-enqueue'"),
    );
    expect(invoke).toContain('resolveCompanionWorkItems');
    expect(invoke).toContain('buildEventMessageEnvelope');
    expect(invoke).toContain('inputSource: workSource.source');
  });
});

describe('a fanned-out run carries the same trigger identity as the event path', () => {
  // Graph validation needs `inputSource`; the HITL gate needs a `trigger`. It
  // builds its in-place target only when `trigger.kind === 'connector_event'`,
  // and the carve-out opens `if (!target) return false`.
  //
  // Sending one without the other produces a run that validates and executes
  // correctly and then asks permission to mark the very thread it just answered
  // as read — an approval no oversight control asked for, on the agent's own
  // ordinary close-out step.
  it('enqueues a trigger alongside the input', () => {
    expect(enqueue).toContain('trigger: connectorEventTrigger(workSource.source');
  });

  it('uses the same helper the event path uses', () => {
    // Not a hand-built literal: the helper derives contentTrust from the
    // source, so mail from an external author is untrusted_inbound on both
    // paths rather than only on one.
    expect(SRC).toContain("import { connectorEventTrigger } from '../agent-lifecycle/types';");
  });

  it('sends it only for a fanned-out item, like inputSource', () => {
    // A plain companion fire has no per-record identity to claim.
    const block = enqueue.slice(enqueue.indexOf('trigger: connectorEventTrigger'));
    expect(enqueue).toContain('...(inputData && workSource?.source');
    expect(block.length).toBeGreaterThan(0);
  });
});
