// The brief does not come back out in the colleague's reply.
//
// A hand-over puts a brief in front of the colleague's model and never shows it
// to the person (forwarded-context.ts). A colleague can still read it out
// anyway: by repeating an agent's id back, which is why the brief is not
// persisted at all, or by opening its reply with the brief's own plan, in the
// brief's own voice, about the person in the third person:
//
//   "The article content came back truncated. Let me confirm what they
//    already know, and check if there's more relevant detail they're missing
//    before advising them."
//
// Three things already stand between that and the person and none of them is
// enough: the brief says in its first line that it is not shown and must not
// be repeated, the Chief AI Officer's prompt keys a rule on that line
// (migration 497), and the output guard can read such a paragraph and pass it. The guard is a
// small model at temperature 0, so a second read of the same text by the asking
// surface would return the same verdict and is not worth its latency; what the
// asking surface has that nobody else does is THE BRIEF ITSELF. It wrote it. So
// this compares, and needs no model.
//
// Conservative on purpose: a false positive deletes a sentence of a real answer,
// which is worse than the leak. A reply sentence is dropped only when it carries
// six or more consecutive words of the brief verbatim (after normalising to
// lowercase words), and never when those same words are in the PERSON's own
// message. The person's words are never a leak, and the brief routinely quotes
// them, which is exactly where a naive match would do damage.
//
// A paraphrase is not a verbatim match and this half cannot see one. That is
// what brief-restatement.ts is for: the same question put to a small model with
// the brief in hand, no threshold anywhere. This half runs first because it is
// free and exact, and it is also the part that still works when the model
// cannot be reached.

import { log } from '../infrastructure/logging';
import { removeBriefRestatement, type RestatementJudge } from './brief-restatement';

/** Consecutive words of the brief that make an echo. Six is the shortest span
 *  that is not plausibly a coincidence between two models writing about the
 *  same request; the sentence this was built for ("the article content came
 *  back truncated") is exactly six. */
const ECHO_WORDS = 6;

/** Words only, lowercased, single-spaced. A model that repeats the brief
 *  reproduces its words, rarely its punctuation or capitalisation. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Every run of `ECHO_WORDS` consecutive words in `text`, space-padded so a
 *  match is always on whole words. */
function shingles(text: string): Set<string> {
  const words = normalise(text).split(' ').filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + ECHO_WORDS <= words.length; i++) {
    out.add(` ${words.slice(i, i + ECHO_WORDS).join(' ')} `);
  }
  return out;
}

/** A sentence, kept with the whitespace that follows it so the paragraph can be
 *  rebuilt from the pieces that survive. */
const SENTENCE = /[^.!?]+(?:[.!?]+|$)\s*/g;

export interface BriefEchoReader {
  /** One paragraph in, the same paragraph out with any sentence that is the
   *  brief's own words removed. Free and exact: no model, no threshold. */
  read(paragraph: string): { text: string; removed: number };
  /** The same, and then the paraphrase reader. This is what the relay uses;
   *  `read` alone is what remains when the model cannot be reached. */
  readFully(paragraph: string): Promise<{ text: string; removed: number }>;
}

/**
 * A reader for one hand-over, or null when there is nothing to compare against:
 * no brief, or a brief with no span of its own that the person did not write.
 *
 * Null rather than a no-op reader so the caller can skip the paragraph machine
 * entirely on the common case, which is a hand-over with no brief at all.
 */
export function briefEchoReader(
  brief: string | null,
  userMessage: string,
  context: { tenantId: string; speaker: string; threadId?: string; abortSignal?: AbortSignal },
  /** Test seam for the paraphrase half. */
  judge?: RestatementJudge,
): BriefEchoReader | null {
  if (!brief) return null;
  const persons = shingles(userMessage);
  const own = new Set([...shingles(brief)].filter((s) => !persons.has(s)));
  if (own.size === 0) return null;

  const reader: BriefEchoReader = {
    read(paragraph: string) {
      const padded = ` ${normalise(paragraph)} `;
      // Nothing of the brief is anywhere in this paragraph: the overwhelmingly
      // common case, and one string scan settles it.
      let anywhere = false;
      for (const s of own) {
        if (padded.includes(s)) { anywhere = true; break; }
      }
      if (!anywhere) return { text: paragraph, removed: 0 };

      let kept = '';
      let removed = 0;
      for (const m of paragraph.match(SENTENCE) ?? []) {
        const sentence = ` ${normalise(m)} `;
        let echo = false;
        for (const s of own) {
          if (sentence.includes(s)) { echo = true; break; }
        }
        if (echo) removed++;
        else kept += m;
      }
      if (removed > 0) {
        log.warn(
          {
            tenantId: context.tenantId,
            speaker: context.speaker,
            ...(context.threadId ? { threadId: context.threadId } : {}),
            sentencesRemoved: removed,
            // Lengths only. What the person was not shown must not land here,
            // the same rule the output guard's audit follows.
            paragraphLength: paragraph.length,
            keptLength: kept.length,
          },
          'brief_echo: a colleague repeated the brief to the person; removed',
        );
      }
      return { text: kept, removed };
    },

    async readFully(paragraph: string) {
      const verbatim = reader.read(paragraph);
      // Nothing left to judge: the whole paragraph was the brief, word for word.
      if (verbatim.text.trim().length === 0) return verbatim;
      const judged = await removeBriefRestatement(verbatim.text, brief, context, judge);
      return { text: judged.text, removed: verbatim.removed + judged.removed };
    },
  };
  return reader;
}
