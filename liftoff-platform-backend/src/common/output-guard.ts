// Output guard: the last reader before a person.
//
// The mirror image of injection-guard.ts. That one screens what comes IN
// from a person; this one reads what goes OUT to a person and rewrites the
// sentences that expose the platform's inner workings: an internal
// identifier, the name of a tool, function or field, narrated mechanics
// (previews, confirmation handles, "per the request", what it was told to
// do), or speaking about the person in the third person as though relaying
// a colleague. Every prompt already forbids all of this; a prompt is a hope,
// and this is the guarantee behind it, for the three platform assistants and
// for every agent, on every surface a person reads.
//
// It runs on a paragraph at a time, before that paragraph streams
// (common/guarded-stream.ts), so the person never sees the sentence that was
// rewritten. What can be recognised by shape (a UUID, a tool name) has
// already been removed by shared/identifier-scrub.ts before this reads the
// text; this handles what a pattern cannot express.
//
// Minimal edits. The rubric makes the model return the paragraph unchanged
// unless a sentence exposes something, and then to change only that
// sentence: a rewrite is a chance to drift, and the person's answer must stay
// the assistant's answer.
//
// Fail-open, exactly as the input guard fails open: a classifier error is
// logged and the (already scrubbed) text goes through. A small-model outage
// must not silence every assistant on the platform. Two bounds keep that
// true under a provider that hangs rather than fails: a read has a deadline,
// past which the scrubbed text goes out; and after a few reads in a row have
// failed the guard stands aside for a short while rather than making every
// paragraph wait out the deadline. OUTPUT_GUARD=off is the emergency switch
// and the only other mode there is: there is no shadow phase, by decision.
//
// Audited by kind and count, never by content: what a person was NOT shown
// is exactly the text that must not land in a log.

import { llmClient } from '../llm';
import { log, logAudit } from '../infrastructure/logging';
import type { JSONSchema } from '../llm/types';

export type LeakKind =
  | 'identifier'
  | 'tool_or_field_name'
  | 'mechanics'
  | 'third_person'
  | 'directive_echo';

export interface OutputGuardResult {
  /** What the person may read. Byte-identical to the input when nothing
   *  exposed the platform, or when the guard could not run. */
  text: string;
  changed: boolean;
  kinds: LeakKind[];
}

export interface OutputGuardContext {
  tenantId: string;
  /** Who is speaking, for the audit row and the usage log: 'liftoff',
   *  'insights', 'caio', or a team's id. */
  speaker: string;
  threadId?: string;
}

const LEAK_KINDS: readonly LeakKind[] = ['identifier', 'tool_or_field_name', 'mechanics', 'third_person', 'directive_echo'];

const SYSTEM_PROMPT = `You are the last editor before a message from an AI assistant reaches the person it is talking to. The assistant works inside a product where people manage agents. Your only job is to make sure the message exposes nothing of the product's inner workings. You are not the assistant, you do not answer the person, and you never add a fact.

Rewrite ONLY a sentence that does one of these, and change nothing else:
1. identifier: shows an internal identifier (a UUID, a database key, a run or thread or connector id, a handle or token). Drop it; refer to the thing by its name. A web address the person is being asked to open is not one of these, however much of it looks like a token: keep the address whole, to its last character. Removing the token from a link does not redact anything, it leaves the person an address that does not work.
2. tool_or_field_name: names a tool, a function, an API, a database field or a form field (for example "team_update", "the additional context field", "the responsibilities text field", "a confirmation handle"). Say what was done in plain words instead ("the note under the team's instructions").
3. mechanics: narrates how the assistant works rather than what it did or found: previews and confirmation steps as mechanics, "per the request", "as requested by the background", "this is preview-only", what it was told to do, which colleague briefed it, what a tool gave back or failed to give back ("the article came back truncated", "the search returned nothing usable"), or a plan for the rest of its own turn ("let me confirm this is accurate before advising them", "first I will check whether there is more detail"). Say what it found, or ask the person the question; never describe the working.
4. third_person: speaks about the person it is talking to in the third person, or relays them as though passing a message along ("let Alex know", "tell the Insights Manager if they want it applied"). Address the person directly, as "you". A sentence that says "you" to somebody who is not the reader while naming the reader by name is this same fault, whoever it was written for: the reader is the person, always.
5. directive_echo: repeats an instruction it was given ("do not apply it", "confirm you are targeting") as if it were the person's words.

Keep every other sentence byte-for-byte identical, including markdown, headings, lists, links, numbers and names. Keep the meaning: a rewritten sentence says the same thing without the exposure. If nothing in the message exposes the product, return it unchanged with changed=false. Never touch a fenced code block or a fenced visualization block: return those exactly as they are.

Normal product language is NOT exposure and must stay: the names of agents and people, "agent", "connection", "the Chief AI Officer", "the Insights Manager", "Liftoff", "approval", "paused", counts and costs, "I will apply it when you say yes", "here is what would change", and any web address the person is given to open, whole.`;

const RESPONSE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    changed: {
      type: 'boolean',
      description: 'true when at least one sentence was rewritten',
    },
    kinds: {
      type: 'array',
      items: { type: 'string', enum: [...LEAK_KINDS] },
      description: 'The kinds of exposure that were rewritten; empty when nothing changed',
    },
    text: {
      type: 'string',
      description: 'The whole message as the person may read it, unchanged when changed=false',
    },
  },
  required: ['changed', 'kinds', 'text'],
};

/** A web address as prose carries one. Bounded, like the scrub's: this runs on
 *  model output and an unbounded quantifier would be a denial of service the
 *  model could trigger. The closing bracket of a markdown link, and the quotes
 *  and brackets a sentence hangs an address on, end it. */
const URL_IN_TEXT = /https?:\/\/[^\s<>()[\]"'`]{1,2000}/g;

/** Every address the rewrite hands back must be one the assistant wrote.
 *
 *  Dropping a link is allowed: the reader may decide an address exposes
 *  something and remove it. Emitting a DIFFERENT one is not, and a link cut
 *  short is a different one. Trailing punctuation is carried identically on
 *  both sides, so it compares equal and needs no stripping. */
function mutilatesALink(before: string, after: string): boolean {
  const written = new Set(before.match(URL_IN_TEXT) ?? []);
  if (written.size === 0) return false;
  return (after.match(URL_IN_TEXT) ?? []).some((url) => !written.has(url));
}

/** The guard is on unless an operator turns it off. The only other mode. */
export function outputGuardEnabled(): boolean {
  return (process.env['OUTPUT_GUARD'] ?? 'on').toLowerCase() !== 'off';
}

/** A paragraph reads in well under a second; past this the person has
 *  waited long enough and the scrubbed text goes out. */
const READ_DEADLINE_MS = 6_000;
/** Reads that failed in a row before the guard stands aside... */
const STAND_ASIDE_AFTER_FAILURES = 3;
/** ...and for how long. Long enough to ride out a blip, short enough that a
 *  recovered provider is back in the path within a conversation. */
const STAND_ASIDE_MS = 30_000;

let consecutiveFailures = 0;
let standingAsideUntil = 0;

/** Test seam: forget the failures seen so far. */
export function _resetOutputGuardState(): void {
  consecutiveFailures = 0;
  standingAsideUntil = 0;
}

function readFailed(): void {
  consecutiveFailures += 1;
  if (consecutiveFailures >= STAND_ASIDE_AFTER_FAILURES && standingAsideUntil === 0) {
    standingAsideUntil = Date.now() + STAND_ASIDE_MS;
  }
}

function readSucceeded(): void {
  consecutiveFailures = 0;
  standingAsideUntil = 0;
}

/** True while the guard is standing aside after repeated failures. Clears
 *  itself when the time is up, so the next read is a real attempt. */
function standingAside(): boolean {
  if (standingAsideUntil === 0) return false;
  if (Date.now() < standingAsideUntil) return true;
  standingAsideUntil = 0;
  consecutiveFailures = 0;
  return false;
}

/** The read, or a rejection at the deadline, whichever comes first. The
 *  controller is handed to the call so a provider that honours it stops. */
async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error('output_guard_deadline'));
      reject(new Error(`output guard read exceeded ${READ_DEADLINE_MS}ms`));
    }, READ_DEADLINE_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Whitespace only, or a lone fence: nothing a person reads as a sentence. */
function nothingToRead(text: string): boolean {
  return text.trim().length === 0;
}

/**
 * Read one paragraph (or one whole reply) on the person's behalf.
 *
 * Returns what may be shown. The scrub (shared/identifier-scrub.ts) has
 * already run on `text`; this catches what it cannot.
 */
export async function guardOutgoingText(
  text: string,
  context: OutputGuardContext,
): Promise<OutputGuardResult> {
  if (!outputGuardEnabled() || nothingToRead(text) || standingAside()) {
    return { text, changed: false, kinds: [] };
  }

  try {
    const usageContext: Record<string, string> = {
      tenantId: context.tenantId,
      purpose: 'output_guard',
      speaker: context.speaker,
    };
    if (context.threadId) usageContext.threadId = context.threadId;

    const response = await withDeadline((abortSignal) => llmClient.complete(
      {
        abortSignal,
        messages: [
          // The rubric is the same bytes on every paragraph the platform
          // reads out, and the paragraph sits after it, so the prefix is
          // cached where the provider caches.
          { role: 'system', content: SYSTEM_PROMPT, cacheControl: { type: 'ephemeral' } },
          { role: 'user', content: text },
        ],
        tier: 'small',
        // The whole paragraph comes back; a rewrite is at most a little
        // longer than what went in.
        maxTokens: Math.min(4000, Math.max(300, Math.ceil(text.length / 2))),
        temperature: 0,
        responseSchema: {
          name: 'guarded_message',
          description: 'The message as the person may read it',
          schema: RESPONSE_SCHEMA,
        },
      },
      undefined,
      usageContext,
    ));
    readSucceeded();

    const parsed = JSON.parse(response.content) as { changed?: unknown; kinds?: unknown; text?: unknown };
    const changed = parsed.changed === true;
    const kinds = Array.isArray(parsed.kinds)
      ? parsed.kinds.filter((k): k is LeakKind => LEAK_KINDS.includes(k as LeakKind))
      : [];
    // A rewrite that came back empty, or a "changed" that changed nothing, is
    // not a rewrite: the scrubbed text stands.
    if (!changed || typeof parsed.text !== 'string' || parsed.text.trim().length === 0 || parsed.text === text) {
      return { text, changed: false, kinds: [] };
    }
    // The reader may DROP a link. It may never hand back one the assistant did
    // not write, and a truncated address is exactly that. Rule 1 reads a
    // capture link's token as "a handle or token", which is the one token that
    // has to survive: a connection link with its token cut off is not a
    // redaction, it is an instruction the person cannot follow, and it was
    // intermittent because a paragraph is read by a model. The wording tells
    // the reader; this decides it.
    if (mutilatesALink(text, parsed.text)) {
      log.warn(
        { tenantId: context.tenantId, speaker: context.speaker },
        'Output guard rewrite emitted a link the assistant did not write; keeping the scrubbed text',
      );
      return { text, changed: false, kinds: [] };
    }

    logAudit(
      'output_guard.rewrote',
      { tenantId: context.tenantId },
      {
        speaker: context.speaker,
        ...(context.threadId ? { threadId: context.threadId } : {}),
        kinds,
        // Lengths only: what the person was not shown must not land here.
        inputLength: text.length,
        outputLength: parsed.text.length,
      },
    );
    return { text: parsed.text, changed: true, kinds };
  } catch (err) {
    readFailed();
    log.error(
      {
        tenantId: context.tenantId,
        speaker: context.speaker,
        error: (err as Error).message,
        consecutiveFailures,
        ...(standingAsideUntil > 0 ? { standingAsideUntil: new Date(standingAsideUntil).toISOString() } : {}),
      },
      'output_guard: read failed, failing open with the scrubbed text',
    );
    return { text, changed: false, kinds: [] };
  }
}
