// Deterministic cadence parsing, for verifying a derived schedule.
//
// The distiller derives crons from prose, and a mis-derivation used to be
// silent: "letting the LLM re-derive a schedule from prose is how a Monday
// brief quietly becomes a daily one" (provisioning-helper's triggerOverride
// note). When the person stated an exact cadence, this parser turns it into
// the cron they meant, and the analyzer then REQUIRES the derived trigger set
// to contain it — a wrong derivation becomes a retried generation error
// instead of a schedule the person discovers on the wrong day.
//
// Deliberately a LIMITED grammar. Anything it does not recognise returns
// null and verification is skipped — a guessed expectation would recreate the
// defect one layer up. Two different recognisable cadences in one sentence is
// treated as unparseable for the same reason: the parser must never pick.

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

export interface ParsedCadence {
  cronExpr: string;
}

/** "9am" | "4:30pm" | "16:00" | "09:15" → [hour, minute], or null. */
function parseTime(text: string): [number, number] | null {
  const ampm = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(text.trim());
  if (ampm) {
    let hour = Number(ampm[1]);
    const minute = ampm[2] ? Number(ampm[2]) : 0;
    if (hour < 1 || hour > 12 || minute > 59) return null;
    if (ampm[3].toLowerCase() === 'pm' && hour !== 12) hour += 12;
    if (ampm[3].toLowerCase() === 'am' && hour === 12) hour = 0;
    return [hour, minute];
  }
  const h24 = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (h24) {
    const hour = Number(h24[1]);
    const minute = Number(h24[2]);
    if (hour > 23 || minute > 59) return null;
    return [hour, minute];
  }
  return null;
}

const TIME_PATTERN = String.raw`(\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2})`;

const WEEKDAY_FORM = new RegExp(
  String.raw`\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+(?:morning|afternoon|evening))?\s+at\s+${TIME_PATTERN}`,
  'gi',
);
const DAILY_FORM = new RegExp(
  String.raw`\b(?:every\s+(?:day|morning)|daily)\s+at\s+${TIME_PATTERN}`,
  'gi',
);
const WEEKDAYS_FORM = new RegExp(
  String.raw`\b(?:every\s+weekday|weekdays)\s+at\s+${TIME_PATTERN}`,
  'gi',
);
const MINUTES_FORM = /\bevery\s+(\d{1,2})\s+minutes\b/gi;
const HOURS_FORM = /\bevery\s+(\d{1,2})\s+hours\b/gi;

/**
 * The cron the prose states, or null when the prose states none, states one
 * this grammar cannot read, or states more than one.
 */
export function parseCadence(prose: string): ParsedCadence | null {
  const found = new Set<string>();

  for (const m of prose.matchAll(WEEKDAY_FORM)) {
    const time = parseTime(m[2]);
    if (!time) return null;
    found.add(`${time[1]} ${time[0]} * * ${WEEKDAYS[m[1].toLowerCase()]}`);
  }
  for (const m of prose.matchAll(DAILY_FORM)) {
    const time = parseTime(m[1]);
    if (!time) return null;
    found.add(`${time[1]} ${time[0]} * * *`);
  }
  for (const m of prose.matchAll(WEEKDAYS_FORM)) {
    const time = parseTime(m[1]);
    if (!time) return null;
    found.add(`${time[1]} ${time[0]} * * 1-5`);
  }
  for (const m of prose.matchAll(MINUTES_FORM)) {
    const n = Number(m[1]);
    if (n < 1 || n > 59) return null;
    found.add(`*/${n} * * * *`);
  }
  for (const m of prose.matchAll(HOURS_FORM)) {
    const n = Number(m[1]);
    if (n < 1 || n > 23) return null;
    found.add(`0 */${n} * * *`);
  }

  if (found.size !== 1) return null;
  return { cronExpr: found.values().next().value! };
}

/** Same schedule, ignoring the fields the distiller may legitimately widen:
 *  minute, hour and day-of-week must agree; day-of-month and month are its
 *  business. Interval forms compare whole. */
export function cronMatchesExpected(produced: string, expected: string): boolean {
  const p = produced.trim().split(/\s+/);
  const e = expected.trim().split(/\s+/);
  if (p.length !== 5 || e.length !== 5) return false;
  return p[0] === e[0] && p[1] === e[1] && p[4] === e[4];
}

const TIME_MENTIONS = new RegExp(TIME_PATTERN, 'gi');
const WEEKDAY_MENTIONS = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi;

/** The distinct weekdays a text names, as cron day-of-week digits. The
 *  routine resolver and the auto-accept gate both read day words off free
 *  text, and two readers of the same words must not disagree. */
export function mentionedWeekdays(text: string): Set<string> {
  return new Set(
    [...text.matchAll(WEEKDAY_MENTIONS)].map((m) => String(WEEKDAYS[m[1].toLowerCase()])),
  );
}

/**
 * Did the person's OWN words state exactly the change being proposed?
 *
 * The confirmation question on a routine change exists to catch
 * interpretation: what gets written is the agent's restatement, and a wrong
 * target or a misheard time is durable. But when the person's message pins
 * the change deterministically, asking "are you sure?" right after they said
 * so is a second confirmation of an explicit instruction. This is the gate
 * for skipping it, and it must never guess: any ambiguity returns false and
 * the question is asked.
 *
 * Two ways the words can pin the change:
 *  1. The message itself parses to the proposed cadence ("every Monday at
 *     9am" in their words) — the same grammar derive-then-verify trusts.
 *  2. The change idiom: the message names exactly one NEW time (times equal
 *     to the routine's current time are the "from 8am" reference and are
 *     ignored), that time is the proposed cadence's time, and the day is
 *     untouched — with any weekday the message mentions required to be
 *     exactly the routine's day. "change the Monday one from 8AM to 9AM"
 *     against a Monday-8am routine and a Monday-9am proposal passes; a
 *     message with two candidate times, a different weekday, or no known
 *     current cadence does not.
 */
export function statedChangeAgrees(
  userMessage: string,
  currentCronExpr: string | null,
  proposedCronExpr: string | null,
): boolean {
  if (!proposedCronExpr) return false;
  const proposed = proposedCronExpr.trim().split(/\s+/);
  if (proposed.length !== 5) return false;

  const direct = parseCadence(userMessage);
  if (direct && cronMatchesExpected(proposedCronExpr, direct.cronExpr)) return true;

  if (!currentCronExpr) return false;
  const current = currentCronExpr.trim().split(/\s+/);
  if (current.length !== 5) return false;
  // The idiom only reads plain scheduled forms; interval or wildcard fields
  // mean the parser's grammar does not cover this routine.
  if (!/^\d+$/.test(current[0]) || !/^\d+$/.test(current[1]) || !/^\d+$/.test(current[4])) return false;
  if (!/^\d+$/.test(proposed[0]) || !/^\d+$/.test(proposed[1]) || !/^\d+$/.test(proposed[4])) return false;

  const stated = new Set<string>();
  for (const m of userMessage.matchAll(TIME_MENTIONS)) {
    const time = parseTime(m[0]);
    if (!time) return false;
    stated.add(`${time[1]} ${time[0]}`);
  }
  stated.delete(`${current[0]} ${current[1]}`);
  if (stated.size !== 1) return false;
  const newTime = stated.values().next().value!;
  if (newTime !== `${proposed[0]} ${proposed[1]}`) return false;

  if (proposed[4] !== current[4]) return false;
  const days = mentionedWeekdays(userMessage);
  if (days.size > 1) return false;
  if (days.size === 1 && !days.has(proposed[4])) return false;
  return true;
}
