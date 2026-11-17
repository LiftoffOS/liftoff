// What a workflow step is told about its predecessor's output.
//
// Three states, and the difference between them is the whole point:
//
//   - fits     the value itself, unchanged
//   - parked   a summary plus where the whole thing is
//   - gone     a summary and an explicit statement that the rest is lost
//
// The third had no words at all. An oversized value with no workspace to park it
// in was rendered exactly like a small one — a summary, no note, nothing to say
// that most of it no longer existed. A step deciding whether something is
// present would read that summary as the set. Without a workspace the parked
// state is the rare one and the silent state is not.
//
// Rendering lives here rather than at the call site because these three strings
// are the entire contract between the size machinery and the model, and a
// caller that assembles them inline is a caller that can omit one.

import { offloadNote, offloadLocation, type OffloadResult } from './offload-large-value';

export interface PriorOutputView {
  /** The compressed or deterministic rendering. Empty when the value must not
   *  be summarised at all. */
  summary: string;
  /** Where the whole value is, when it was parked. */
  offloaded: OffloadResult | null;
  /** The value carries a completeness constraint from the tool that produced it. */
  mustBeWhole: boolean;
  /** The value is larger than the step prompt's budget. */
  exceeded: boolean;
  /** Tool that produced it, for naming in the note. */
  producedBy?: string;
  /** Serialized size, for the truncation note. */
  chars: number;
}

export function renderPriorOutput(view: PriorOutputView): string {
  const { summary, offloaded, mustBeWhole, exceeded, producedBy, chars } = view;

  // Handle ALONE. No summary is offered, because for this value a summary is not
  // a convenience — it is the wrong answer, pre-computed and sitting in the
  // prompt. The file is the only correct source, so it is the only thing named.
  if (mustBeWhole && offloaded) {
    // Named by DESTINATION: a value parked in a dataset is read with
    // `dataset_query`, and sending the model to `file_read` on a path that was
    // never written reads to it as the value being gone.
    const where = `${offloadLocation(offloaded)}. `
      + (offloaded.path
        ? 'This step must work from the WHOLE result, so read and process that file — '
          + 'with file_read, or your code-execution tools for anything set-shaped like '
          + '"which of these already exist".'
        : 'This step must work from the WHOLE result, so read all of it with '
          + 'dataset_query, paging with limit and cursor until there is no cursor left.');
    return `[Not shown here on purpose. The complete result of ${producedBy ?? 'the previous step'} `
      + `(${offloaded.bytes} characters) is ${where} `
      + 'Do not answer from memory of an earlier summary.]';
  }

  // Parked: summary plus a way back to the rest. `offloadNote` owns this wording
  // so the promise made here and the file written there cannot drift apart.
  if (offloaded) return `${summary}${offloadNote(offloaded)}`;

  // Gone. The wording is deliberately blunt about the direction of the error:
  // absence from a truncated view is not evidence of absence, and a step whose
  // answer depends on completeness is told to stop rather than guess.
  if (exceeded) {
    return `${summary}\n[TRUNCATED: the prior step produced ${chars} characters and only a summary `
      + `fits here. The rest was NOT saved anywhere and cannot be recovered in this run. `
      + `Do not treat the text above as a complete list: something missing from it may still `
      + `exist. If this step's answer depends on seeing every record, say so and stop rather `
      + `than answering from this summary.]`;
  }

  return summary;
}
