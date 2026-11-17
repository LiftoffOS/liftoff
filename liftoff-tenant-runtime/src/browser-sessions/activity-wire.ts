// The browser record's rows, mapped once: to the proto the RPCs answer, and
// to the record shapes the one prose renderer takes (@liftoffos/browser-record).
//
// Factored out of service.ts so the Browser state block (interactive-chat/
// browser-state.ts) and the `read_browser_session_activity` tool read the
// same rows through the same mappers the ListBrowserActivity and
// ListTakeoverActivity RPCs answer with, rather than each shaping a row of
// its own.

import { create } from '@bufbuild/protobuf';
import { Timestamp, TimestampSchema } from '@bufbuild/protobuf/wkt';
import {
  BrowserActivityRowSchema,
  BrowserTaskStepSchema,
  TakeoverActionSchema,
  TakeoverAction_ValueDisposition,
  TakeoverHoldSchema,
  type BrowserActivityRow,
  type TakeoverHold as ProtoTakeoverHold,
} from '@liftoffos/proto-gen/dist/liftoff/platform/v1/browser_sessions_pb.js';
import type { RecordedAction, RecordedCall, RecordedSegment, RecordedStep } from '@liftoffos/browser-record';
import type { BrowserActivityRead } from './activity-repository';
import type { TakeoverActionRead, TakeoverHoldWithSession } from './takeover-capture/repository';
import type { ValueDisposition } from './takeover-capture/action';
import type { BrowserIntervention } from './interventions';

export function dateToTimestamp(d: Date): Timestamp {
  return create(TimestampSchema, {
    seconds: BigInt(Math.floor(d.getTime() / 1000)),
    nanos: (d.getTime() % 1000) * 1_000_000,
  });
}

/** The stored disposition to the proto enum. Exhaustive: an unknown value is
 *  refused by the repository before it reaches here, never coerced. */
export function valueDispositionToProto(d: ValueDisposition): TakeoverAction_ValueDisposition {
  switch (d) {
    case 'none': return TakeoverAction_ValueDisposition.NONE;
    case 'recorded': return TakeoverAction_ValueDisposition.RECORDED;
    case 'authentication_omitted': return TakeoverAction_ValueDisposition.AUTHENTICATION_OMITTED;
    case 'payment_omitted': return TakeoverAction_ValueDisposition.PAYMENT_OMITTED;
    case 'sensitive_identity_omitted': return TakeoverAction_ValueDisposition.SENSITIVE_IDENTITY_OMITTED;
    case 'file_omitted': return TakeoverAction_ValueDisposition.FILE_OMITTED;
    case 'sensitive_text_omitted': return TakeoverAction_ValueDisposition.SENSITIVE_TEXT_OMITTED;
    case 'legacy_unavailable': return TakeoverAction_ValueDisposition.LEGACY_UNAVAILABLE;
  }
}

/** A hold's liveness and orphan state, from the joined session row: live
 *  when it has no end AND the session is open AND still taken over; an open
 *  hold that is NOT live was ended by something that bypassed the hold, and
 *  is reported with a gap and the session's close as its end. */
export function holdState(hold: TakeoverHoldWithSession): { live: boolean; orphan: boolean; endedAt: Date | null } {
  const live = hold.endedAt === null && hold.sessionClosedAt === null && hold.sessionTakeoverState === 'taken_over';
  const orphan = hold.endedAt === null && !live;
  return { live, orphan, endedAt: orphan ? hold.sessionClosedAt : hold.endedAt };
}

// ── To the proto ─────────────────────────────────────────────────────────────

export function takeoverActionToProto(a: TakeoverActionRead) {
  return create(TakeoverActionSchema, {
    kind: a.kind,
    url: a.url,
    tag: a.tag ?? '',
    role: a.role ?? '',
    name: a.name ?? '',
    inputType: a.inputType ?? '',
    at: dateToTimestamp(a.at),
    value: a.value ?? '',
    valueDisposition: valueDispositionToProto(a.valueDisposition),
    detail: a.detail ?? '',
    urlTruncated: a.urlTruncated,
    nameTruncated: a.nameTruncated,
    valueTruncated: a.valueTruncated,
    urlProtectedDataOmitted: a.urlProtectedDataOmitted,
    nameProtectedDataOmitted: a.nameProtectedDataOmitted,
    detailTruncated: a.detailTruncated,
    detailProtectedDataOmitted: a.detailProtectedDataOmitted,
  });
}

/** One hold as ListTakeoverActivity answers it, with the request it
 *  answered when there was one. */
export function holdToProto(hold: TakeoverHoldWithSession, intervention: BrowserIntervention | null = null): ProtoTakeoverHold {
  const { live, orphan, endedAt } = holdState(hold);
  return create(TakeoverHoldSchema, {
    id: hold.id,
    kind: hold.kind,
    startedAt: dateToTimestamp(hold.startedAt),
    endedAt: endedAt ? dateToTimestamp(endedAt) : undefined,
    endReason: hold.endReason ?? '',
    live,
    captureGap: orphan ? true : hold.captureGap,
    gapReason: orphan ? (hold.gapReason ?? 'lost_owner') : (hold.gapReason ?? ''),
    actions: hold.actions.map(takeoverActionToProto),
    actionsOmitted: hold.actionsOmitted,
    interventionReason: intervention?.reason ?? '',
    interventionRequestedAt: intervention ? dateToTimestamp(intervention.requestedAt) : undefined,
  });
}

export function activityRowToProto(row: BrowserActivityRead): BrowserActivityRow {
  return create(BrowserActivityRowSchema, {
    id: row.id,
    tool: row.tool,
    instruction: row.instruction,
    outcome: row.outcome,
    personTookOver: row.personTookOver,
    hasSteps: row.steps !== null,
    steps: (row.steps ?? []).map((step) => create(BrowserTaskStepSchema, {
      type: step.type,
      action: step.action,
      pageUrl: step.pageUrl,
      actionTruncated: step.actionTruncated,
      pageUrlTruncated: step.pageUrlTruncated,
      protectedDataOmitted: step.protectedDataOmitted,
      protectedKind: step.protectedKind,
      pageUrlProtectedDataOmitted: step.pageUrlProtectedDataOmitted,
      ...(step.at && !Number.isNaN(new Date(step.at).getTime()) ? { at: dateToTimestamp(new Date(step.at)) } : {}),
    })),
    createdAt: dateToTimestamp(row.createdAt),
    instructionTruncated: row.instructionTruncated,
    outcomeTruncated: row.outcomeTruncated,
    captureGap: row.captureGap,
    gapReason: row.gapReason,
    stepsTruncated: row.stepsTruncated,
    instructionProtectedDataOmitted: row.instructionProtectedDataOmitted,
    outcomeProtectedDataOmitted: row.outcomeProtectedDataOmitted,
  });
}

// ── To the record shapes the renderer takes ──────────────────────────────────

export function takeoverActionToRecord(a: TakeoverActionRead): RecordedAction {
  return {
    kind: a.kind,
    url: a.url,
    tag: a.tag ?? '',
    role: a.role ?? '',
    name: a.name ?? '',
    inputType: a.inputType ?? '',
    at: a.at.toISOString(),
    value: a.valueDisposition === 'recorded' ? (a.value ?? '') : '',
    valueDisposition: a.valueDisposition,
    detail: a.detail ?? '',
    urlTruncated: a.urlTruncated,
    nameTruncated: a.nameTruncated,
    valueTruncated: a.valueDisposition === 'recorded' ? a.valueTruncated : false,
    detailTruncated: a.detailTruncated,
    urlProtectedDataOmitted: a.urlProtectedDataOmitted,
    nameProtectedDataOmitted: a.nameProtectedDataOmitted,
    detailProtectedDataOmitted: a.detailProtectedDataOmitted,
  };
}

/** One hold as a segment of the record. Actions omitted by a `newestActions`
 *  read mark the segment truncated. */
export function holdToRecord(hold: TakeoverHoldWithSession): RecordedSegment {
  const { live, orphan, endedAt } = holdState(hold);
  return {
    tool: 'person_takeover',
    kind: hold.kind,
    steps: hold.actions.map(takeoverActionToRecord),
    live,
    captureGap: orphan ? true : hold.captureGap,
    gapReason: orphan ? (hold.gapReason ?? 'lost_owner') : (hold.gapReason ?? ''),
    startedAt: hold.startedAt.toISOString(),
    endedAt: endedAt ? endedAt.toISOString() : null,
    ...(hold.actionsOmitted > 0 ? { stepsTruncated: true } : {}),
  };
}

export function activityRowToRecord(row: BrowserActivityRead): RecordedCall {
  const steps: RecordedStep[] | null = row.steps === null ? null : row.steps.map((step) => ({
    type: step.type,
    action: step.action,
    pageUrl: step.pageUrl,
    actionTruncated: step.actionTruncated,
    pageUrlTruncated: step.pageUrlTruncated,
    protectedDataOmitted: step.protectedDataOmitted,
    protectedKind: step.protectedKind,
    pageUrlProtectedDataOmitted: step.pageUrlProtectedDataOmitted,
    at: step.at,
  }));
  return {
    id: row.id,
    tool: row.tool,
    instruction: row.instruction,
    outcome: row.outcome,
    personTookOver: row.personTookOver,
    steps,
    createdAt: row.createdAt.toISOString(),
    instructionTruncated: row.instructionTruncated,
    outcomeTruncated: row.outcomeTruncated,
    instructionProtectedDataOmitted: row.instructionProtectedDataOmitted,
    outcomeProtectedDataOmitted: row.outcomeProtectedDataOmitted,
    captureGap: row.captureGap,
    gapReason: row.gapReason,
    ...(row.stepsTruncated ? { stepsTruncated: true as const } : {}),
  };
}
