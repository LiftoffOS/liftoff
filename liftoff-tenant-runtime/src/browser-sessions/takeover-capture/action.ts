// What one recorded action is, and the bounds it crosses the binding under.
//
// The recorder runs inside the session's page, in an isolated world, and hands
// each action to Node through a CDP binding as a JSON string. Node trusts none
// of it: the payload is parsed against a STRICT schema (an unknown key is a
// rejection, not a passenger), every string is capped, and the kind is one of
// ten. Anything else is dropped and logged. The caps are the same ones the
// recorder applies in the page, so a well-behaved recorder never trips them;
// they exist for the day something else reaches the binding.
//
// Since 424 an action carries the value the person entered, unless the
// control was classified as protected, in which case `valueDisposition` says
// which class was omitted and `value` is empty. The value read happens ONLY
// after `classifyProtectedControl` answered recordable; a file input never
// reads `.value` or `.files`. `detail` is a bounded non-textual interaction
// (a key chord, a scroll position, a drag's source, click coordinates) and
// never entered text.

import { z } from 'zod';

/** The eleven things a person can do that the trail records. `point` (432)
 *  is made in Node from a point the person made in the live view without
 *  taking over; it never arrives through the binding. */
export const TAKEOVER_ACTION_KINDS = [
  'navigate', 'click', 'submit', 'change', 'enter', 'key', 'scroll', 'drag', 'contextmenu', 'hover', 'point',
] as const;
export type TakeoverActionKind = (typeof TAKEOVER_ACTION_KINDS)[number];

/** The kinds the binding may deliver; `navigate` and `point` are made in Node. */
export const BINDING_ACTION_KINDS = [
  'click', 'submit', 'change', 'enter', 'key', 'scroll', 'drag', 'contextmenu', 'hover',
] as const;

/** How an entered value was handled. The SQL column stores these lowercase
 *  names; the proto carries the prefixed enum; the mapper between them is
 *  exhaustive and refuses an unknown value rather than coercing it. */
export const VALUE_DISPOSITIONS = [
  'none', 'recorded', 'authentication_omitted', 'payment_omitted',
  'sensitive_identity_omitted', 'file_omitted', 'sensitive_text_omitted', 'legacy_unavailable',
] as const;
export type ValueDisposition = (typeof VALUE_DISPOSITIONS)[number];

/** The dispositions the recorder in the page may report. `legacy_unavailable`
 *  is written only by migration 424 over rows from before it. */
export const BINDING_VALUE_DISPOSITIONS = [
  'none', 'recorded', 'authentication_omitted', 'payment_omitted',
  'sensitive_identity_omitted', 'file_omitted', 'sensitive_text_omitted',
] as const;

/** Field caps, shared by the recorder in the page and the schema here. */
export const ACTION_FIELD_CAPS = {
  url: 2048,
  tag: 32,
  role: 64,
  inputType: 32,
  name: 200,
  value: 2000,
  detail: 400,
} as const;

/** Actions kept per hold. The 501st is refused and the hold records a `cap`
 *  gap, because a trail that silently stops is worse than one that says it
 *  stopped. */
export const ACTIONS_PER_HOLD_CAP = 500;

/** The recorder's payload, exactly. `.strict()` so a key this schema does not
 *  name fails the parse rather than riding along into the row. */
export const takeoverActionPayloadSchema = z.object({
  nonce: z.string().min(1).max(64),
  seq: z.number().int().min(0),
  kind: z.enum(BINDING_ACTION_KINDS),
  url: z.string().max(ACTION_FIELD_CAPS.url),
  urlTruncated: z.boolean(),
  urlProtectedDataOmitted: z.boolean(),
  tag: z.string().max(ACTION_FIELD_CAPS.tag),
  role: z.string().max(ACTION_FIELD_CAPS.role),
  name: z.string().max(ACTION_FIELD_CAPS.name),
  nameTruncated: z.boolean(),
  inputType: z.string().max(ACTION_FIELD_CAPS.inputType),
  value: z.string().max(ACTION_FIELD_CAPS.value),
  valueTruncated: z.boolean(),
  valueDisposition: z.enum(BINDING_VALUE_DISPOSITIONS),
  detail: z.string().max(ACTION_FIELD_CAPS.detail),
  detailTruncated: z.boolean(),
  /** When the page recorded it, as epoch milliseconds from the page's clock;
   *  Node keeps its own arrival time as the row's `at` and uses this only to
   *  order actions against a task's observed steps. */
  at: z.number().int().min(0),
}).strict();

export type TakeoverActionPayload = z.infer<typeof takeoverActionPayloadSchema>;

/** One action as the repository writes it. `navigate` rows are made in Node
 *  from Playwright's frame events under a Node-side nonce; the other nine
 *  arrive through the binding. Every descriptive string has passed the safe
 *  URL projection and the browser text sanitizer before it reaches here, and
 *  the flags say what that pass changed. */
export interface TakeoverActionRow {
  nonce: string;
  seq: number;
  kind: TakeoverActionKind;
  url: string;
  urlTruncated: boolean;
  urlProtectedDataOmitted: boolean;
  tag: string | null;
  role: string | null;
  name: string | null;
  nameTruncated: boolean;
  nameProtectedDataOmitted: boolean;
  inputType: string | null;
  value: string | null;
  valueTruncated: boolean;
  valueDisposition: ValueDisposition;
  detail: string | null;
  detailTruncated: boolean;
  detailProtectedDataOmitted: boolean;
}

/** Parse a binding payload, or null when it is not one. Never throws: a bad
 *  payload costs one action, not the capture. */
export function parseTakeoverActionPayload(raw: string): TakeoverActionPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = takeoverActionPayloadSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
