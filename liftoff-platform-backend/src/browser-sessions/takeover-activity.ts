// The runtime's browser record, read for every host: the person's takeover
// segments and every recorded pane work call, newest first, a page at a
// time, redacted before they leave this service.
//
// Moved out of the Liftoff source-conversation route once the Chief AI
// Officer's own pane needed the same read (its `conversation__read` asks for
// the person's segments on a team-plan thread through
// `POST /api/internal/assistant-browser/takeovers`), and grown a second stream
// once the runtime became the ONE recorder of pane browser activity for every
// surface (`ListBrowserActivity`, proto 0.25.0). The merge that puts the two
// beside a host's own transcript stays in the source-conversation router;
// this module owns the streams, the redaction of a row, the budget arithmetic
// and the one-shot read.
//
// Redaction here is defence in depth. Every string the runtime returns has
// already passed its protected data policy, and the row carries the flags
// that say what changed. `redactSensitiveText` runs again on every string
// before it leaves this service; when that pass changes a supposedly safe
// string, the matching omission flag is upgraded (or a value's disposition
// becomes `sensitive_text_omitted`) rather than the text being silently
// changed, so a reader never presents an altered text as exact.

import { Code, ConnectError } from '@connectrpc/connect';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import {
  TakeoverAction_ValueDisposition,
  type BrowserActivityRow as RuntimeActivityRow,
  type BrowserTaskStep as RuntimeTaskStep,
  type TakeoverAction,
  type TakeoverHold,
} from '@liftoffos/proto-gen/dist/liftoff/platform/v1/browser_sessions_pb.js';
import { sanitizeBrowserText } from '@liftoffos/redact';
import type { RecordedSegment } from '@liftoffos/browser-record';
import { log } from '../infrastructure/logging';
import { redactSensitiveText } from '../common/redact';
import { getBrowserSessionsServiceClient } from '../connectors/tenant-runtime-service-client';

/** The tool name a takeover row carries. Not a tool the assistant has: the
 *  person drove, and this is the segment. */
export const PERSON_TAKEOVER = 'person_takeover';

/** Holds per page from the runtime; its RPC clamps to this. */
export const HOLD_PAGE_SIZE = 5;
/** Activity rows per page from the runtime; its RPC clamps to this. */
export const ACTIVITY_PAGE_SIZE = 50;
/** What a takeover read can afford on its own, when it is not sharing the
 *  source-conversation budget: counted on the SERIALIZED array. */
export const TAKEOVER_CHAR_BUDGET = 20_000;

/** The stored disposition names, as the runtime's SQL spells them. */
export type ValueDispositionOut =
  | 'none' | 'recorded' | 'authentication_omitted' | 'payment_omitted'
  | 'sensitive_identity_omitted' | 'file_omitted' | 'sensitive_text_omitted' | 'legacy_unavailable';

/** One of the person's actions, as returned. */
export interface TakeoverActionOut {
  kind: string;
  url: string;
  tag: string;
  role: string;
  name: string;
  inputType: string;
  at: string;
  value: string;
  valueDisposition: ValueDispositionOut;
  detail: string;
  urlTruncated: boolean;
  nameTruncated: boolean;
  valueTruncated: boolean;
  detailTruncated: boolean;
  urlProtectedDataOmitted: boolean;
  nameProtectedDataOmitted: boolean;
  detailProtectedDataOmitted: boolean;
}

/** One takeover segment, as returned: the record's segment shape
 *  (@liftoffos/browser-record), with `steps` the person's actions and the
 *  three fields that let it sit in the activity list beside a call. `kind`
 *  is "takeover" for a segment the person drove and "point" for one control
 *  they pointed at without taking over. */
export type TakeoverActivityOut = RecordedSegment & {
  tool: typeof PERSON_TAKEOVER;
  instruction: '';
  outcome: '';
  personTookOver: true;
  steps: TakeoverActionOut[];
  /** Set, and true, only when actions are missing from this read. */
  stepsTruncated?: true;
  kind: 'takeover' | 'point';
};

/** One step of an assistant's browser task, as returned. */
export interface AssistantStepOut {
  type: string;
  action: string;
  pageUrl: string;
  actionTruncated: boolean;
  pageUrlTruncated: boolean;
  protectedDataOmitted: boolean;
  protectedKind: string;
  pageUrlProtectedDataOmitted: boolean;
  at: string | null;
}

/** One assistant browser call, as returned. */
export interface AssistantActivityOut {
  id: string;
  tool: string;
  instruction: string;
  outcome: string;
  personTookOver: boolean;
  steps: AssistantStepOut[] | null;
  createdAt: string;
  instructionTruncated: boolean;
  outcomeTruncated: boolean;
  instructionProtectedDataOmitted: boolean;
  outcomeProtectedDataOmitted: boolean;
  captureGap: boolean;
  gapReason: string;
  /** Steps are missing: the capture's cap, or this read's budget. */
  stepsTruncated?: true;
}

export type ActivityOut = AssistantActivityOut | TakeoverActivityOut;

/** A newest-first source that fetches its next page only when asked. */
export interface NewestFirst<T> {
  peek(): Promise<T | null>;
  pop(): Promise<T | null>;
  /** Older items remain unfetched — after the read stopped, this is what
   *  "truncated" means for this stream. */
  hasMore(): boolean;
}

export interface HoldItem {
  hold: TakeoverHold;
  startedAt: Date;
  /** A stable tie breaker between holds started in the same instant. */
  order: number;
}

/** The runtime's holds. An older runtime without the RPC answers
 *  Unimplemented; that is logged and read as no holds, so the assistant rows
 *  still cross. `newestActions` asks the runtime for each hold's newest N
 *  actions only, with the older ones counted (`actions_omitted`). */
export function holdStream(
  tenantId: string,
  threadId: string,
  opts: { newestActions?: number } = {},
): NewestFirst<HoldItem> {
  let buffer: HoldItem[] = [];
  let cursor = '';
  let more = true;
  let started = false;
  let order = 0;
  const fill = async () => {
    if (buffer.length > 0 || !more) return;
    if (started && cursor === '') { more = false; return; }
    started = true;
    let holds: TakeoverHold[] = [];
    let next = '';
    try {
      const client = await getBrowserSessionsServiceClient(tenantId);
      const res = await client.listTakeoverActivity({
        tenantContext: { tenantId },
        threadId,
        limit: HOLD_PAGE_SIZE,
        beforeCursor: cursor,
        ...(opts.newestActions ? { newestActions: opts.newestActions } : {}),
      });
      holds = res.holds;
      next = res.nextCursor;
    } catch (err) {
      if (err instanceof ConnectError && err.code === Code.Unimplemented) {
        log.info({ tenantId, threadId }, 'runtime has no ListTakeoverActivity; reading the trail without takeover holds');
        more = false;
        return;
      }
      throw err;
    }
    buffer = holds.map((hold) => ({
      hold,
      startedAt: hold.startedAt ? timestampDate(hold.startedAt) : new Date(0),
      order: order++,
    }));
    cursor = next;
    more = next !== '';
  };
  return {
    async peek() { await fill(); return buffer[0] ?? null; },
    async pop() { await fill(); return buffer.shift() ?? null; },
    hasMore: () => buffer.length > 0 || more,
  };
}

export interface ActivityItem {
  row: AssistantActivityOut;
  createdAt: Date;
  order: number;
}

/** The runtime's activity rows, redacted as they are fetched. An older
 *  runtime without the RPC answers Unimplemented; that is read as no rows.
 *  `seen` remembers every id fetched so far, so the legacy adapter can drop
 *  a row the runtime also carries. */
export interface ActivityStream extends NewestFirst<ActivityItem> {
  /** Fetch pages until the newest unfetched row is older than `until` (or
   *  the stream is exhausted), then answer whether `id` was seen. */
  hasId(id: string, until: Date): Promise<boolean>;
}

export function activityStream(tenantId: string, threadId: string): ActivityStream {
  let buffer: ActivityItem[] = [];
  let cursor = '';
  let more = true;
  let started = false;
  let order = 0;
  const seen = new Set<string>();
  let oldestFetched: Date | null = null;
  const fill = async () => {
    if (buffer.length > 0 || !more) return;
    await fetchPage();
  };
  const fetchPage = async () => {
    if (!more) return;
    if (started && cursor === '') { more = false; return; }
    started = true;
    let rows: RuntimeActivityRow[] = [];
    let next = '';
    try {
      const client = await getBrowserSessionsServiceClient(tenantId);
      const res = await client.listBrowserActivity({
        tenantContext: { tenantId },
        threadId,
        limit: ACTIVITY_PAGE_SIZE,
        beforeCursor: cursor,
      });
      rows = res.rows;
      next = res.nextCursor;
    } catch (err) {
      if (err instanceof ConnectError && err.code === Code.Unimplemented) {
        log.info({ tenantId, threadId }, 'runtime has no ListBrowserActivity; reading the trail from this service alone');
        more = false;
        return;
      }
      throw err;
    }
    const items = rows.map((row) => {
      seen.add(row.id);
      const createdAt = row.createdAt ? timestampDate(row.createdAt) : new Date(0);
      return { row: runtimeRowOut(row, createdAt), createdAt, order: order++ };
    });
    buffer = buffer.concat(items);
    const last = items[items.length - 1];
    if (last) oldestFetched = last.createdAt;
    cursor = next;
    more = next !== '';
  };
  return {
    async peek() { await fill(); return buffer[0] ?? null; },
    async pop() { await fill(); return buffer.shift() ?? null; },
    hasMore: () => buffer.length > 0 || more,
    async hasId(id, until) {
      if (seen.has(id)) return true;
      while (more && (oldestFetched === null || oldestFetched.getTime() >= until.getTime())) {
        await fetchPage();
        if (seen.has(id)) return true;
      }
      return seen.has(id);
    },
  };
}

// ── Rows as returned, redacted ────────────────────────────────────────────

/** Redact one string and say whether that changed it. */
function safe(text: string): { text: string; changed: boolean } {
  const out = redactSensitiveText(text);
  return { text: out, changed: out !== text };
}

/** The proto enum, normalised. An older runtime answers UNSPECIFIED, which
 *  is read from the action kind: a value-bearing action recorded before
 *  values were carried is `legacy_unavailable`, anything else `none`. */
export function valueDispositionOut(action: Pick<TakeoverAction, 'kind' | 'valueDisposition'>): ValueDispositionOut {
  switch (action.valueDisposition) {
    case TakeoverAction_ValueDisposition.NONE: return 'none';
    case TakeoverAction_ValueDisposition.RECORDED: return 'recorded';
    case TakeoverAction_ValueDisposition.AUTHENTICATION_OMITTED: return 'authentication_omitted';
    case TakeoverAction_ValueDisposition.PAYMENT_OMITTED: return 'payment_omitted';
    case TakeoverAction_ValueDisposition.SENSITIVE_IDENTITY_OMITTED: return 'sensitive_identity_omitted';
    case TakeoverAction_ValueDisposition.FILE_OMITTED: return 'file_omitted';
    case TakeoverAction_ValueDisposition.SENSITIVE_TEXT_OMITTED: return 'sensitive_text_omitted';
    case TakeoverAction_ValueDisposition.LEGACY_UNAVAILABLE: return 'legacy_unavailable';
    case TakeoverAction_ValueDisposition.UNSPECIFIED:
    default:
      return action.kind === 'change' || action.kind === 'enter' ? 'legacy_unavailable' : 'none';
  }
}

/** One of the person's actions: every string redacted, every flag carried,
 *  and never a value synthesised for an omitted field. */
export function takeoverActionOut(a: TakeoverAction): TakeoverActionOut {
  const url = safe(a.url);
  const name = safe(a.name);
  const detail = safe(a.detail);
  let disposition = valueDispositionOut(a);
  let value = '';
  if (disposition === 'recorded') {
    // A value the runtime kept but either pass would alter (a credential
    // shape, a card or identity number, a labelled secret, a tokenized
    // address typed into an ordinary field): it goes whole, and the
    // disposition says why. Never an altered value presented as entered.
    const v = safe(a.value);
    if (v.changed || sanitizeBrowserText(a.value).protectedDataOmitted) {
      disposition = 'sensitive_text_omitted';
    } else {
      value = v.text;
    }
  }
  return {
    kind: a.kind,
    url: url.text,
    tag: redactSensitiveText(a.tag),
    role: redactSensitiveText(a.role),
    name: name.text,
    inputType: redactSensitiveText(a.inputType),
    at: a.at ? timestampDate(a.at).toISOString() : '',
    value,
    valueDisposition: disposition,
    detail: detail.text,
    urlTruncated: a.urlTruncated,
    nameTruncated: a.nameTruncated,
    valueTruncated: disposition === 'recorded' ? a.valueTruncated : false,
    detailTruncated: a.detailTruncated,
    urlProtectedDataOmitted: a.urlProtectedDataOmitted || url.changed,
    nameProtectedDataOmitted: a.nameProtectedDataOmitted || name.changed,
    detailProtectedDataOmitted: a.detailProtectedDataOmitted || detail.changed,
  };
}

export function takeoverRowOut(item: HoldItem): TakeoverActivityOut {
  const { hold } = item;
  return {
    tool: PERSON_TAKEOVER,
    instruction: '',
    outcome: '',
    personTookOver: true,
    steps: hold.actions.map(takeoverActionOut),
    live: hold.live,
    captureGap: hold.captureGap,
    gapReason: hold.gapReason,
    startedAt: item.startedAt.toISOString(),
    endedAt: hold.endedAt ? timestampDate(hold.endedAt).toISOString() : null,
    // Older actions the runtime left out of this read (newest_actions) are
    // missing steps, the same as the capture's cap.
    ...(hold.actionsOmitted > 0 ? { stepsTruncated: true as const } : {}),
    kind: hold.kind === 'point' ? 'point' : 'takeover',
  };
}

/** One step of an assistant's task: redacted, flags upgraded when the pass
 *  changed a string. */
export function taskStepOut(step: RuntimeTaskStep): AssistantStepOut {
  const action = safe(step.action);
  const pageUrl = safe(step.pageUrl);
  return {
    type: step.type,
    action: action.text,
    pageUrl: pageUrl.text,
    actionTruncated: step.actionTruncated,
    pageUrlTruncated: step.pageUrlTruncated,
    protectedDataOmitted: step.protectedDataOmitted || action.changed,
    protectedKind: step.protectedKind || (action.changed ? 'sensitive_text' : ''),
    pageUrlProtectedDataOmitted: step.pageUrlProtectedDataOmitted || pageUrl.changed,
    at: step.at ? timestampDate(step.at).toISOString() : null,
  };
}

/** One runtime activity row, redacted as the assistant rows are. */
export function runtimeRowOut(row: RuntimeActivityRow, createdAt: Date): AssistantActivityOut {
  const instruction = safe(row.instruction);
  const outcome = safe(row.outcome);
  return {
    id: row.id,
    tool: row.tool,
    instruction: instruction.text,
    outcome: outcome.text,
    personTookOver: row.personTookOver,
    steps: row.hasSteps ? row.steps.map(taskStepOut) : null,
    createdAt: createdAt.toISOString(),
    instructionTruncated: row.instructionTruncated,
    outcomeTruncated: row.outcomeTruncated,
    instructionProtectedDataOmitted: row.instructionProtectedDataOmitted || instruction.changed,
    outcomeProtectedDataOmitted: row.outcomeProtectedDataOmitted || outcome.changed,
    captureGap: row.captureGap,
    gapReason: row.gapReason,
    ...(row.stepsTruncated ? { stepsTruncated: true as const } : {}),
  };
}

/** The serialized cost of one row inside the array: its JSON plus the comma. */
export function costOf(row: ActivityOut): number {
  return JSON.stringify(row).length + 1;
}

/**
 * Fit a row into what is left of the budget.
 *
 * Whole if it fits. Otherwise, keep its NEWEST steps that fit and mark it
 * `stepsTruncated`. If even its non-step fields do not fit, nothing: the
 * caller stops. Applies to both kinds of row, the first one included.
 */
export function fitRow<T extends { steps: unknown[] | null; stepsTruncated?: true }>(
  row: T,
  remaining: number,
): { row: T; truncated: boolean } | null {
  if (costOf(row as unknown as ActivityOut) <= remaining) return { row, truncated: false };
  const steps = row.steps ?? [];
  const bare = { ...row, steps: row.steps === null ? null : [], stepsTruncated: true as const };
  if (costOf(bare as unknown as ActivityOut) > remaining) return null;
  // Newest steps first: walk back from the end until one no longer fits.
  const kept: unknown[] = [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const candidate = { ...bare, steps: [steps[i], ...kept] };
    if (costOf(candidate as unknown as ActivityOut) > remaining) break;
    kept.unshift(steps[i]);
  }
  return { row: { ...bare, steps: kept } as T, truncated: true };
}

/**
 * The person's takeover segments on a thread, newest first from the runtime,
 * returned oldest first and kept under `budget` serialized characters with
 * the same newest-steps-first truncation the source-conversation read uses.
 */
export async function readTakeoverActivity(
  tenantId: string,
  threadId: string,
  budget: number = TAKEOVER_CHAR_BUDGET,
): Promise<{ takeovers: TakeoverActivityOut[]; truncated: boolean }> {
  const holds = holdStream(tenantId, threadId);
  const takeovers: TakeoverActivityOut[] = [];
  let truncated = false;
  // The array's own brackets are paid up front; each row pays its comma.
  let spent = 2;
  for (;;) {
    const item = await holds.pop();
    if (!item) break;
    const fitted = fitRow(takeoverRowOut(item), budget - spent);
    if (!fitted) {
      truncated = true;
      break;
    }
    if (fitted.truncated) truncated = true;
    spent += costOf(fitted.row);
    takeovers.unshift(fitted.row);
  }
  if (holds.hasMore()) truncated = true;
  return { takeovers, truncated };
}
