// Streaming Visualization Fence Parser
//
// Extracts visualization blocks from LLM output that looks like:
//
//   Based on the data, costs are up 10%.
//
//   ```visualization
//   [
//     { "type": "metric_card", "label": "Total Cost", "value": "$4,832", ... },
//     { "type": "bar_chart", "title": "Tasks by Agent", ... }
//   ]
//   ```
//
//   The top cost driver is the Salesforce Sync agent...
//
// The CAIO chat service has two callers for this module:
//
// 1. `parseVisualizationBlocks(fullText)` — one-shot parse called after the
//    LLM stream ends. Returns cleaned text (fences stripped) + all blocks.
//    Used to persist the final assistant message in a form the frontend
//    can render from chat history without re-parsing.
//
// 2. `StreamingVisualizationParser` — stateful incremental parser that
//    consumes text deltas as they arrive. Emits `text` events for prose
//    characters and `blocks` events once a fence closes with valid JSON,
//    so the SSE stream carries text_delta + content_block rather than raw
//    fence markers the user would watch being typed out.
//
// Ported verbatim from platform-backend src/insights/visualization-parser.ts,
// which stayed behind when this service was extracted. Both symbols existed
// here as stubs that returned the text unchanged and never emitted a block,
// so the CAIO's org chart has never rendered. Keep the two implementations in
// step: the frontend renders one union for both chat surfaces.

import { log } from '../infrastructure/logging.js';
import type { VisualizationBlock } from './visualization-types.js';

const FENCE_OPEN = '```visualization';
const FENCE_CLOSE = '```';

// Every discriminator in the VisualizationBlock union (shared-types.ts).
// The CAIO workforce-planning chat emits `org_chart` blocks in addition to
// the insights-chat block types; keeping a single allow-list shared between
// both chat surfaces means one parser codepath instead of a duplicate.
const VALID_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'metric_card',
  'bar_chart',
  'trend_chart',
  'table',
  'text',
  'observation',
  'org_chart',
]);

function isValidVisualizationBlock(obj: unknown): obj is VisualizationBlock {
  if (!obj || typeof obj !== 'object') return false;
  const type = (obj as { type?: unknown }).type;
  return typeof type === 'string' && VALID_BLOCK_TYPES.has(type);
}

/**
 * Return the length of the longest suffix of `buffer` that is also a prefix
 * of FENCE_OPEN. Used by the streaming parser to decide how many trailing
 * characters must be held back in case the next delta completes a fence.
 *
 * Example: longestFenceOpenPrefixSuffix("foo ```vi") === 6
 *          longestFenceOpenPrefixSuffix("foo bar")   === 0
 */
function longestFenceOpenPrefixSuffix(buffer: string): number {
  const maxCheck = Math.min(buffer.length, FENCE_OPEN.length - 1);
  for (let len = maxCheck; len > 0; len--) {
    if (FENCE_OPEN.startsWith(buffer.slice(buffer.length - len))) {
      return len;
    }
  }
  return 0;
}

/**
 * One-shot parser for the full LLM output. Strips all visualization fences
 * from the text and returns them as typed blocks alongside the cleaned text.
 *
 * Uses a greedy regex that matches ```visualization...``` fences across
 * newlines. Malformed JSON inside a fence is logged and the fence is left
 * in the cleaned text (rather than silently dropped) so operators can see
 * what the LLM tried to emit.
 */
export function parseVisualizationBlocks(text: string): {
  cleanedText: string;
  blocks: VisualizationBlock[];
} {
  const blocks: VisualizationBlock[] = [];
  // Non-greedy match so adjacent fences don't collapse into one.
  const fenceRegex = /```visualization\s*\n?([\s\S]*?)\n?```/g;
  const malformedRanges: Array<[number, number]> = [];

  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(text)) !== null) {
    const jsonContent = match[1].trim();
    try {
      const parsed = JSON.parse(jsonContent);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      const validBlocks = candidates.filter(isValidVisualizationBlock);
      if (validBlocks.length > 0) {
        blocks.push(...validBlocks);
      } else {
        log.warn(
          { blockCount: candidates.length },
          'Visualization fence parsed but contained no valid blocks',
        );
        malformedRanges.push([match.index, match.index + match[0].length]);
      }
    } catch (err) {
      log.warn(
        { error: (err as Error).message, preview: jsonContent.slice(0, 120) },
        'Failed to parse visualization fence JSON',
      );
      malformedRanges.push([match.index, match.index + match[0].length]);
    }
  }

  // Strip only the successfully-parsed fences from the cleaned text. Leave
  // malformed fences in place so the error is visible to operators.
  let cleanedText = '';
  let cursor = 0;
  // Iterate fences again to know which to strip (parsed) vs keep (malformed)
  const keepRanges = new Set(malformedRanges.map(([s]) => s));
  fenceRegex.lastIndex = 0;
  while ((match = fenceRegex.exec(text)) !== null) {
    if (keepRanges.has(match.index)) {
      // Keep the malformed fence in the cleaned text
      cleanedText += text.slice(cursor, match.index + match[0].length);
    } else {
      // Strip the well-formed fence
      cleanedText += text.slice(cursor, match.index);
    }
    cursor = match.index + match[0].length;
  }
  cleanedText += text.slice(cursor);

  return {
    cleanedText: cleanedText.replace(/\n{3,}/g, '\n\n').trim(),
    blocks,
  };
}

// ── Streaming parser ────────────────────────────────────────────────────

export type StreamingParseEvent =
  | { type: 'text'; content: string }
  | { type: 'blocks'; blocks: VisualizationBlock[] };

/**
 * Incremental parser that consumes text deltas and emits either text or
 * block events. State-machine driven so opening / closing fences split
 * across deltas are handled correctly.
 *
 * The key safety trick: when we haven't seen a fence opener yet, we only
 * emit text up to `length - (FENCE_OPEN.length - 1)` characters. The
 * trailing window is held back because it might be the start of an
 * opening fence on the next delta.
 */
export class StreamingVisualizationParser {
  private buffer = '';
  private inFence = false;

  /** Feed an incoming text delta. Returns a list of events to emit. */
  feed(text: string): StreamingParseEvent[] {
    this.buffer += text;
    return this.drain();
  }

  /** Stream ended — emit anything left in the buffer. */
  flush(): StreamingParseEvent[] {
    const events: StreamingParseEvent[] = [];
    if (this.inFence) {
      // Unterminated fence — emit whatever's buffered as text, fences and all.
      // The one-shot parser at the end of the turn will try harder.
      events.push({ type: 'text', content: FENCE_OPEN + '\n' + this.buffer });
      this.buffer = '';
      this.inFence = false;
    } else if (this.buffer.length > 0) {
      events.push({ type: 'text', content: this.buffer });
      this.buffer = '';
    }
    return events;
  }

  private drain(): StreamingParseEvent[] {
    const events: StreamingParseEvent[] = [];

    for (;;) {
      if (this.inFence) {
        const closeIdx = this.buffer.indexOf(FENCE_CLOSE);
        if (closeIdx === -1) {
          // Need more data. Keep the buffer intact.
          return events;
        }

        const jsonContent = this.buffer.slice(0, closeIdx).trim();
        try {
          const parsed = JSON.parse(jsonContent);
          const candidates = Array.isArray(parsed) ? parsed : [parsed];
          const validBlocks = candidates.filter(isValidVisualizationBlock);
          if (validBlocks.length > 0) {
            events.push({ type: 'blocks', blocks: validBlocks });
          } else {
            // Malformed — fall through to raw text emission
            events.push({
              type: 'text',
              content: `${FENCE_OPEN}\n${jsonContent}\n${FENCE_CLOSE}`,
            });
          }
        } catch (err) {
          log.warn(
            { error: (err as Error).message, preview: jsonContent.slice(0, 120) },
            'Streaming parser: failed to parse fence JSON',
          );
          events.push({
            type: 'text',
            content: `${FENCE_OPEN}\n${jsonContent}\n${FENCE_CLOSE}`,
          });
        }

        this.buffer = this.buffer.slice(closeIdx + FENCE_CLOSE.length);
        this.inFence = false;
        continue;
      }

      // Not in fence — look for an opening fence marker
      const openIdx = this.buffer.indexOf(FENCE_OPEN);
      if (openIdx === -1) {
        // No complete fence yet. Emit everything that CAN'T be the start of
        // an opening fence, and hold back only the trailing characters that
        // form a prefix of FENCE_OPEN. For example, given "foo bar ```vi",
        // we can safely emit "foo bar " and hold back "```vi" (6 chars)
        // since that might be the start of "```visualization".
        const holdBackLen = longestFenceOpenPrefixSuffix(this.buffer);
        const safeLen = this.buffer.length - holdBackLen;
        if (safeLen > 0) {
          events.push({ type: 'text', content: this.buffer.slice(0, safeLen) });
          this.buffer = this.buffer.slice(safeLen);
        }
        return events;
      }

      // Found fence marker. Emit text before it, then enter fence mode.
      if (openIdx > 0) {
        events.push({ type: 'text', content: this.buffer.slice(0, openIdx) });
      }
      // Skip past the fence marker and any leading whitespace inside the fence
      this.buffer = this.buffer.slice(openIdx + FENCE_OPEN.length).replace(/^[ \t\r\n]+/, '');
      this.inFence = true;
    }
  }
}
