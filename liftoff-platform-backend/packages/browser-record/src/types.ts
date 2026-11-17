// The browser record's wire shapes, as they exist on every host.
//
// A takeover segment (a hold and its actions), a point (a zero-length hold
// with one action), and an assistant call (a recorded pane work call and,
// for a browser task, the loop's steps) are read by the tenant runtime, by
// platform-backend and by workforce-service, and rendered by one set of
// functions (prose.ts, state-block.ts). The shapes here are what those
// renderers take. Each host keeps its own type where the type lives and pins
// assignability to these with one `satisfies` line in its own test, so a
// field added on one side and not the other fails there rather than in a
// renderer at run time.
//
// Every string is observed, untrusted data: it was written by a web page (a
// control's name, a title, an address) or by a person (a value). Nothing
// here is an instruction to a model, and every renderer says so where its
// output opens.

/** How an entered value was handled. The runtime's SQL and the proto both
 *  spell these; a producer that builds an action uses this union, and a
 *  consumer that reads one accepts any string and treats an unknown value
 *  as omitted. */
export type ValueDisposition =
  | 'none'
  | 'recorded'
  | 'authentication_omitted'
  | 'payment_omitted'
  | 'sensitive_identity_omitted'
  | 'file_omitted'
  | 'sensitive_text_omitted'
  | 'legacy_unavailable';

/** One thing the person did while driving, or the one control a point
 *  named: a navigation, an interaction with a control, or a non-textual
 *  interaction with the page. Every text field is bounded and has passed
 *  the protected data policy; the flags say what that pass changed. */
export interface RecordedAction {
  /** "navigate" | "click" | "submit" | "change" | "enter" | "key" | "scroll"
   *  | "drag" | "contextmenu" | "hover" | "point". */
  kind: string;
  url: string;
  tag: string;
  role: string;
  name: string;
  inputType: string;
  /** ISO 8601, or empty when the runtime did not report a time. */
  at: string;
  /** The value entered when valueDisposition is "recorded"; empty otherwise. */
  value: string;
  /** A ValueDisposition; declared as string because a consumer reads what
   *  the wire carries and an older producer may spell one it does not know. */
  valueDisposition: string;
  /** A bounded non-textual interaction: a key chord, a scroll position, a
   *  drag's source, click coordinates. Never entered text. */
  detail: string;
  urlTruncated: boolean;
  nameTruncated: boolean;
  valueTruncated: boolean;
  detailTruncated: boolean;
  urlProtectedDataOmitted: boolean;
  nameProtectedDataOmitted: boolean;
  detailProtectedDataOmitted: boolean;
}

/** One segment the person drove the browser themselves (kind "takeover", the
 *  default), or one point they made without taking over (kind "point": a
 *  zero-length hold with exactly one action of kind "point"). */
export interface RecordedSegment {
  tool: 'person_takeover';
  steps: RecordedAction[];
  /** The person is still driving. */
  live: boolean;
  /** Part of this segment was NOT observed; gapReason says why. */
  captureGap: boolean;
  gapReason: string;
  startedAt: string;
  endedAt: string | null;
  /** Actions are missing from this read: the capture's cap, or the read's
   *  own budget. */
  stepsTruncated?: boolean;
  /** Empty or absent reads as "takeover". */
  kind?: 'takeover' | 'point';
}

/** One step of an assistant's browser task, as the runtime projected it. */
export interface RecordedStep {
  type: string;
  action: string;
  pageUrl: string;
  actionTruncated: boolean;
  pageUrlTruncated: boolean;
  protectedDataOmitted: boolean;
  protectedKind: string;
  pageUrlProtectedDataOmitted: boolean;
  /** ISO 8601 when the loop reported a time; null otherwise. */
  at: string | null;
}

/** One recorded pane work call: a navigation, a browser task, a page read,
 *  a control read, an action on a control, a save or a download, whoever
 *  made it. `id` is optional because a host that projects its own trail
 *  entry to this shape has no activity id to give it. */
export interface RecordedCall {
  id?: string;
  tool: string;
  instruction: string;
  outcome: string;
  personTookOver: boolean;
  /** The loop's steps for a browser task; null when the tool has no step
   *  sequence. */
  steps: RecordedStep[] | null;
  createdAt: string;
  instructionTruncated: boolean;
  outcomeTruncated: boolean;
  instructionProtectedDataOmitted: boolean;
  outcomeProtectedDataOmitted: boolean;
  captureGap: boolean;
  gapReason: string;
  /** Steps are missing: the capture's cap, or a read's budget. */
  stepsTruncated?: true;
}
