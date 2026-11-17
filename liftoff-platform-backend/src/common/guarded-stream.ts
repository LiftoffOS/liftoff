// The output guard on a token stream.
//
// A model's deltas come in; a person's deltas go out. Nothing reaches the
// person until the paragraph it belongs to is complete and has been read by
// the scrub (shared/identifier-scrub.ts) and the output guard
// (common/output-guard.ts): a rewritten sentence is never seen in its first
// form, because the first form never left this class.
//
// The unit is a paragraph, for two reasons. The guard rewrites sentences, and
// a sentence is not knowable until its paragraph ends; and a paragraph is
// about as long as a person waits without noticing (the guard reads one in
// well under a second). Paragraphs are guarded as they complete, each
// starting while the next is still streaming in, and delivered in order.
//
// A fenced block (code, or Insights' ```visualization JSON) is not prose, and
// neither is a team's <CITATIONS> block: they are scrubbed and passed through,
// never rewritten, because a model that "improved" a code block or a chart's
// JSON would be a worse defect than the one this prevents.
//
// Used the same way on every surface: feed every text delta, and await flush
// when the model's stream ends (or is stopped), before anything that must
// come after the text.

import { log } from '../infrastructure/logging';
import { scrubIdentifiers } from '../shared/identifier-scrub';
import { guardOutgoingText, type OutputGuardContext, type OutputGuardResult } from './output-guard';

export interface GuardedOutputOptions {
  /** Receives the person's text, in order, one guarded segment at a time. */
  onText: (text: string) => void;
  /** The exact tool names this turn was offered, removed by the scrub. */
  toolNames?: readonly string[];
  /** Test seam. Production reads with the output guard. */
  guard?: (text: string, context: OutputGuardContext) => Promise<OutputGuardResult>;
}

/** A paragraph that grows past this without a blank line (a long table, a
 *  long list) is cut at a line end so the person is not kept waiting on the
 *  whole thing, and so the guard's reply fits its budget. */
const MAX_PROSE_SEGMENT = 6000;

/** A blank line: the end of a paragraph, kept with it. */
const PARAGRAPH_END = /\n[ \t]*\n/;

/** The blocks that pass through unread. `open` says where one starts (the
 *  match's `at` group is its first character); `close` says where it ends,
 *  and must be unambiguous when split across deltas: a closing fence is
 *  taken only with its own newline, so a partial one is never mistaken for
 *  one. */
interface BlockKind {
  open: RegExp;
  close: RegExp;
}
const BLOCK_KINDS: readonly BlockKind[] = [
  // A fence line, only at a line start.
  { open: /(?:^|\n)(?<at>`{3,}|~{3,})/, close: /\n(?:`{3,}|~{3,})[ \t]*\n/ },
  // A team's citations, JSON the relay parses out of the reply.
  { open: /(?<at><CITATIONS>)/, close: /<\/CITATIONS>/ },
];

export class GuardedOutput {
  private buffer = '';
  private inBlock: BlockKind | null = null;
  /** Guarded segments are delivered through this chain, in the order they
   *  were cut, whatever order their guards resolve in. */
  private delivery: Promise<void> = Promise.resolve();
  private readonly guard: NonNullable<GuardedOutputOptions['guard']>;

  constructor(
    private readonly context: OutputGuardContext,
    private readonly options: GuardedOutputOptions,
  ) {
    this.guard = options.guard ?? guardOutgoingText;
  }

  /** Take a model delta. Any paragraph it completes starts its read now. */
  feed(delta: string): void {
    if (!delta) return;
    this.buffer += delta;
    this.cutCompleteSegments();
  }

  /** The model's stream has ended: read what is held and deliver everything.
   *  Resolves once the last segment has reached `onText`. */
  async flush(): Promise<void> {
    const rest = this.buffer;
    this.buffer = '';
    if (rest.length > 0) {
      if (this.inBlock) this.enqueueBlock(rest);
      else this.enqueueProse(rest);
    }
    this.inBlock = null;
    await this.delivery;
  }

  /** The earliest block opening in the buffer, and where it starts. */
  private nextBlock(): { kind: BlockKind; at: number } | null {
    let found: { kind: BlockKind; at: number } | null = null;
    for (const kind of BLOCK_KINDS) {
      const m = kind.open.exec(this.buffer);
      if (!m) continue;
      const at = m.index + m[0].length - (m.groups?.['at']?.length ?? 0);
      if (!found || at < found.at) found = { kind, at };
    }
    return found;
  }

  private cutCompleteSegments(): void {
    for (;;) {
      if (this.inBlock) {
        const close = this.inBlock.close.exec(this.buffer);
        if (!close) return;
        const end = close.index + close[0].length;
        this.enqueueBlock(this.buffer.slice(0, end));
        this.buffer = this.buffer.slice(end);
        this.inBlock = null;
        continue;
      }

      const paragraph = PARAGRAPH_END.exec(this.buffer);
      const block = this.nextBlock();

      if (block && (!paragraph || block.at <= paragraph.index)) {
        if (block.at > 0) this.enqueueProse(this.buffer.slice(0, block.at));
        this.buffer = this.buffer.slice(block.at);
        this.inBlock = block.kind;
        continue;
      }
      if (paragraph) {
        const end = paragraph.index + paragraph[0].length;
        this.enqueueProse(this.buffer.slice(0, end));
        this.buffer = this.buffer.slice(end);
        continue;
      }
      if (this.buffer.length > MAX_PROSE_SEGMENT) {
        const lineEnd = this.buffer.lastIndexOf('\n', MAX_PROSE_SEGMENT);
        const end = lineEnd > 0 ? lineEnd + 1 : MAX_PROSE_SEGMENT;
        this.enqueueProse(this.buffer.slice(0, end));
        this.buffer = this.buffer.slice(end);
        continue;
      }
      return;
    }
  }

  private enqueueBlock(segment: string): void {
    const text = scrubIdentifiers(segment, { toolNames: this.options.toolNames, inCode: true });
    this.deliver(Promise.resolve(text));
  }

  private enqueueProse(segment: string): void {
    // The guard reads the words; the whitespace that shapes the paragraph
    // around them is put back exactly.
    const lead = /^\s*/.exec(segment)?.[0] ?? '';
    const trail = /\s*$/.exec(segment)?.[0] ?? '';
    const body = segment.slice(lead.length, segment.length - trail.length);
    if (body.length === 0) {
      this.deliver(Promise.resolve(segment));
      return;
    }
    const scrubbed = scrubIdentifiers(body, { toolNames: this.options.toolNames });
    // Starts now, while the next paragraph streams in.
    const read = this.guard(scrubbed, this.context).then(
      (result) => lead + result.text + trail,
      // The guard fails open on its own; this is for a seam that does not.
      () => lead + scrubbed + trail,
    );
    this.deliver(read);
  }

  private deliver(segment: Promise<string>): void {
    this.delivery = this.delivery.then(async () => {
      const text = await segment;
      if (!text) return;
      try {
        this.options.onText(text);
      } catch (err) {
        // A receiver that has gone (a closed stream) must not stop the
        // segments behind this one from being delivered to the ones that
        // remain, such as the row being persisted.
        log.error(
          { tenantId: this.context.tenantId, speaker: this.context.speaker, error: (err as Error).message },
          'guarded_output: receiver threw',
        );
      }
    });
  }
}

/**
 * The same reading for text that arrives whole rather than as deltas: a
 * reply written by a callback after a pause, a team posting through a
 * platform tool, a colleague's block over the internal route. Paragraphs
 * and fences are cut and read exactly as a stream's are, so a whole reply
 * and a streamed one come out the same.
 */
export async function guardWholeText(
  text: string,
  context: OutputGuardContext,
  options: Pick<GuardedOutputOptions, 'toolNames' | 'guard'> = {},
): Promise<string> {
  if (!text) return text;
  let out = '';
  const guarded = new GuardedOutput(context, { ...options, onText: (t) => { out += t; } });
  guarded.feed(text);
  await guarded.flush();
  return out;
}
