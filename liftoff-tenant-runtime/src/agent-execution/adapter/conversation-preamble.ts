// Resume / multi-turn history replay for the self-managing SDK engines
// (ADK / Codex / opencode).
//
// The hybrid loop (service.ts) does NOT call adapter.resume() — on HITL-resume or
// a follow-up chat turn it rehydrates `state.conversationHistory`, rebuilds
// `InvocationInput.messages` from it, and calls `adapter.invoke()` again with the
// FULL conversation. The @openai/agents adapter handles this by replaying prior
// turns as role-tagged input items (text-only). But Codex/opencode/ADK own the
// loop and expect to GENERATE assistant turns — they can't accept pre-filled
// assistant turns as input. So we replay prior turns as a text transcript
// PREAMBLE prepended to the current user prompt, giving the engine the context it
// needs to continue. This mirrors the existing adapters' text-only replay
// (structured tool-call turns are rendered as text — lossy but functional).
//
// Single-turn autonomous runs (messages == [objective]) produce NO preamble, so
// the common path is unchanged.
//
// IMAGES. Two of the three engines can take a picture with the turn's input —
// Codex as a local file on its `--image` flag, opencode as a file part carrying
// a data URL — and for those the preamble does not describe the picture, it
// POINTS at it: every image in the conversation is attached to the one turn
// that carries the replayed transcript, numbered in order, and the transcript
// names each by its number. ADK takes a text prompt and nothing else, so on
// that engine the picture is still described in words. Either way it is never
// dropped: a turn that mentions no picture leaves the model answering about
// one it never received, and nothing in the answer says so.

import type { PlatformMessage, PlatformContent } from './types';

export type MediaContent = Extract<PlatformContent, { type: 'media' }>;

export interface PreambleOptions {
  /** The engine takes the conversation's images with this turn's input, so an
   *  image is referred to by its attachment number rather than described as
   *  something the engine cannot see. Video is described either way: neither
   *  carrying engine takes one. */
  carriesImages?: boolean;
}

/** Whether a media member is one the carrying engines take with the turn.
 *  A plain boolean rather than a type predicate: a predicate that can be false
 *  for a media member would narrow the false branch to `never`. */
function isCarriedImage(c: MediaContent, opts: PreambleOptions): boolean {
  return !!opts.carriesImages && c.mimeType.startsWith('image/');
}

/** The images an engine that carries them attaches to the first turn, in the
 *  order the preamble numbers them: message order, then content order, over
 *  exactly the turns the prompt renders. The whole conversation is replayed in
 *  that one turn, so every picture in it belongs on that turn too — an image on
 *  an earlier turn is as unseen by a fresh session as one on the current turn. */
export function attachedImages(messages: PlatformMessage[]): MediaContent[] {
  const out: MediaContent[] = [];
  for (const m of renderedTurns(messages)) {
    for (const c of m.content) {
      if (c.type === 'media' && isCarriedImage(c, { carriesImages: true })) out.push(c);
    }
  }
  return out;
}

/** A tool exchange as one line of transcript text, for the engines that take
 *  history as a prompt rather than as structured turns: the call with its
 *  arguments, the result with its payload. The ONE rendering, shared with the
 *  Claude SDK's history replay, so every engine that cannot pair a result with
 *  its call natively shows the model the same thing. */
export function toolBlockToText(c: Extract<PlatformContent, { type: 'tool_use' | 'tool_result' }>): string {
  if (c.type === 'tool_use') return `[called ${c.toolName}(${safeJson(c.args)})]`;
  return `[tool result${c.error ? ' error' : ''}: ${safeJson(c.result)}]`;
}

/** Renders one message's content, numbering carried images through `counter`
 *  so the number in the transcript is the position of the attachment. */
function contentToText(
  content: PlatformContent[],
  opts: PreambleOptions,
  counter: { next: number },
): string {
  return content
    .map((c) => {
      if (c.type === 'text') return c.text;
      if (c.type === 'tool_use' || c.type === 'tool_result') return toolBlockToText(c);
      if (c.type === 'media') {
        if (isCarriedImage(c, opts)) {
          const n = counter.next++;
          return `[The person attached an image (${c.mimeType})${c.alt ? `, described as: ${c.alt}` : ''}. `
            + `It is attachment ${n} of this message.]`;
        }
        // Media the engine cannot take: every kind on ADK, video on Codex and
        // opencode.
        //
        // Described rather than shown — and described, not dropped, which is
        // the difference that matters. An empty string here (what this returned
        // before the image member existed) would leave the model reading a turn
        // that mentions no picture at all, so it would answer about one it never
        // received and nothing in the answer would say so. The sentence is
        // addressed to the model on purpose.
        const kind = c.mimeType.startsWith('video/') ? 'video' : 'image';
        const verb = kind === 'video' ? 'watch' : 'see';
        const what = opts.carriesImages ? kind : 'media';
        return `[The person attached a ${kind} (${c.mimeType})${c.alt ? `, described as: ${c.alt}` : ''}. `
          + `You cannot ${verb} it: this engine cannot receive ${what}. Say so if asked about it, `
          + 'and do not describe it from its type or name.]';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function safeJson(v: unknown): string {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 2000 ? s.slice(0, 2000) + '…' : s;
  } catch {
    return String(v);
  }
}

/** Index of the LAST user message (the current turn), or -1. */
export function lastUserIndex(messages: PlatformMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i;
  }
  return -1;
}

/** The turns the prompt is built from, in order: every non-system turn before
 *  the last user message, then that message. Anything after it is not part of
 *  the prompt, so it carries no attachment either. */
function renderedTurns(messages: PlatformMessage[]): PlatformMessage[] {
  const lastUser = lastUserIndex(messages);
  const prior = messages.slice(0, lastUser < 0 ? messages.length : lastUser).filter((m) => m.role !== 'system');
  return lastUser >= 0 ? [...prior, messages[lastUser]] : prior;
}

/** Preamble and current-turn text, rendered in ONE pass so the attachment
 *  numbers run through both halves: an image on the current turn is numbered
 *  after the ones in the history it follows.
 *
 *  `preamble` is the transcript of every turn BEFORE the last user message
 *  (system turns skipped — those are passed via the engine's system slot), and
 *  is empty when there is no prior history (the single-turn autonomous case).
 *  `current` is the text of the last user message. */
export function renderTurnPrompt(
  messages: PlatformMessage[],
  opts: PreambleOptions = {},
): { preamble: string; current: string } {
  const counter = { next: 1 };
  const lastUser = lastUserIndex(messages);
  const turns = renderedTurns(messages);
  const prior = lastUser >= 0 ? turns.slice(0, -1) : turns;
  const lines = prior.map((m) => {
    const who = m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? 'Tool' : 'User';
    return `${who}: ${contentToText(m.content, opts, counter)}`;
  });
  const preamble = lines.length === 0 ? '' : `Conversation so far:\n${lines.join('\n')}\n\n`;
  const current = lastUser >= 0 ? contentToText(messages[lastUser].content, opts, counter) : '';
  return { preamble, current };
}

/** The full first-turn prompt for a fresh session: history preamble + current user text. */
export function firstTurnPrompt(messages: PlatformMessage[], opts: PreambleOptions = {}): string {
  const { preamble, current } = renderTurnPrompt(messages, opts);
  return `${preamble}${current}`;
}
