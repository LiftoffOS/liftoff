// SlackStreamer — progressive message updates via Slack's chat.update API
//
// Renders agent output play-by-play, in chronological event order:
//   tool call  → section block  "> _Looking up github: list commits..._"
//   text delta → section block  "Here's what I found..."
//   tool call  → context block  "_Looking up review recent activity..._"
//   text delta → section block  (appended to the current text segment)
//   ...
//
// This mirrors how Claude Code renders actions and text in the terminal —
// each event appears inline as it arrives, not grouped into sections.
//
// Implementation: events are stored as an ordered `segments[]` array.
// Each addToolCall() pushes a ToolSegment. Each append() pushes or extends
// a TextSegment. buildBlocks() walks segments in order to produce Block Kit.
//
// Flushes eagerly every 150 characters (Cloud Run fire-and-forget safe),
// with a 200ms debounce for small chunks. Rate-limit retries on 429.

import { log } from '../../infrastructure/logging';
import { stripCitationsBlock, formatCitationsMrkdwn } from '../citation-format';
import type { Citation } from '../chat-repository';
import type { FileCardItem } from '../file-cards';

const TOKEN_REVOKED_ERRORS = new Set(['token_revoked', 'invalid_auth', 'account_inactive', 'not_authed']);
const SECTION_MAX_CHARS = 2900; // Slack section block text limit is 3000

// ── Segment types ─────────────────────────────────────────────────────────

type ToolSegment = { type: 'tool'; name: string };
type TextSegment = { type: 'text'; content: string };
type Segment = ToolSegment | TextSegment;

// ── Formatting helpers ────────────────────────────────────────────────────

/** Format an internal tool name for human-readable Slack display. */
function formatToolName(name: string): string {
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    if (parts.length >= 3) {
      const provider = parts[1].replace(/-/g, ' ');
      const action = parts.slice(2).join(' ').replace(/[-_]/g, ' ');
      return `${provider}: ${action}`;
    }
  }
  return name.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/** Strip **bold** / __bold__ markers — used for header plain_text blocks. */
function stripInlineBold(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1');
}

/** Convert Markdown body text to Slack mrkdwn. */
function markdownBodyToMrkdwn(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/gm, '*$1*')   // **bold** → *bold*
    .replace(/__(.+?)__/gm, '*$1*')         // __bold__ → *bold*
    .replace(/^[-*_]{3,}$/gm, '')           // horizontal rules → remove
    .replace(/\n{3,}/g, '\n\n')             // collapse excess blank lines
    .trim();
}

/** Parse inline markdown into rich text element objects for use in rich_text blocks. */
function parseInlineToRichElements(text: string): Array<Record<string, unknown>> {
  const elements: Array<Record<string, unknown>> = [];
  const pattern = /\*\*(.+?)\*\*|\*(.+?)\*|_(.+?)_|`(.+?)`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      elements.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    }
    if (match[1] !== undefined) {
      elements.push({ type: 'text', text: match[1], style: { bold: true } });
    } else if (match[2] !== undefined) {
      elements.push({ type: 'text', text: match[2], style: { italic: true } });
    } else if (match[3] !== undefined) {
      elements.push({ type: 'text', text: match[3], style: { italic: true } });
    } else if (match[4] !== undefined) {
      elements.push({ type: 'text', text: match[4], style: { code: true } });
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    elements.push({ type: 'text', text: text.slice(lastIndex) });
  }

  return elements.length > 0 ? elements : [{ type: 'text', text }];
}

/** Convert an array of bullet item strings into a rich_text bullet list block. */
function buildBulletBlock(items: string[]): Record<string, unknown> {
  return {
    type: 'rich_text',
    elements: [{
      type: 'rich_text_list',
      style: 'bullet',
      elements: items.map(item => ({
        type: 'rich_text_section',
        elements: parseInlineToRichElements(item),
      })),
    }],
  };
}

/**
 * Convert a Markdown text segment into Block Kit blocks.
 *
 * - `#` / `##` → Slack `header` block
 * - `###`+    → `section` with `*bold*`
 * - Body text → `section` with mrkdwn (**bold** → *bold*)
 * - Long sections split at SECTION_MAX_CHARS
 */
function buildFinalContentBlocks(markdown: string): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const lines = markdown.split('\n');
  let bodyLines: string[] = [];
  let bulletItems: string[] = [];

  const flushBody = () => {
    if (!bodyLines.length) return;
    const body = markdownBodyToMrkdwn(bodyLines.join('\n'));
    bodyLines = [];
    if (!body) return;
    let remaining = body;
    while (remaining) {
      const chunk = remaining.slice(0, SECTION_MAX_CHARS);
      remaining = remaining.slice(SECTION_MAX_CHARS);
      if (chunk.trim()) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
      }
    }
  };

  const flushBullets = () => {
    if (!bulletItems.length) return;
    blocks.push(buildBulletBlock(bulletItems));
    bulletItems = [];
  };

  for (const line of lines) {
    const h12Match = line.match(/^#{1,2}\s+(.+)$/);
    const h3PlusMatch = line.match(/^#{3,6}\s+(.+)$/);
    const bulletMatch = line.match(/^[*\-+] (.+)$/);

    if (h12Match) {
      flushBody();
      flushBullets();
      const text = stripInlineBold(h12Match[1]).trim();
      if (text) {
        blocks.push({ type: 'header', text: { type: 'plain_text', text, emoji: true } });
      }
    } else if (h3PlusMatch) {
      flushBody();
      flushBullets();
      const text = stripInlineBold(h3PlusMatch[1]).trim();
      if (text) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${text}*` } });
      }
    } else if (bulletMatch) {
      flushBody();
      bulletItems.push(bulletMatch[1]);
    } else {
      flushBullets();
      bodyLines.push(line);
    }
  }
  flushBody();
  flushBullets();

  return blocks;
}

/** Block Kit blocks listing files the agent produced this turn (empty if none). */
export function buildSlackFileBlocks(files: FileCardItem[]): Array<Record<string, unknown>> {
  if (files.length === 0) return [];
  const lines = files.map((f) => `📎 <${f.url}|${f.filename}>`).join('\n');
  return [
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: `*Files*\n${lines}` } },
  ];
}

// ── SlackStreamer ─────────────────────────────────────────────────────────

export class SlackStreamer {
  private segments: Segment[] = [];
  private citations: Citation[] = [];
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private tokenRevoked = false;
  private finalized = false;
  private unflushedChars = 0;
  private readonly debounceMs: number;
  // Flush immediately when this many unflushed characters accumulate.
  // Avoids relying solely on timers in Cloud Run's fire-and-forget context.
  private readonly eagerFlushThreshold: number;
  private readonly channel: string;
  private readonly messageTs: string;
  private readonly botToken: string;
  private readonly onTokenRevoked?: () => void;

  constructor(opts: {
    botToken: string;
    channel: string;
    messageTs: string;
    debounceMs?: number;
    eagerFlushThreshold?: number;
    /** Called when the bot token is detected as revoked/invalid (CC-5). */
    onTokenRevoked?: () => void;
  }) {
    this.botToken = opts.botToken;
    this.channel = opts.channel;
    this.messageTs = opts.messageTs;
    this.debounceMs = opts.debounceMs ?? 200;
    this.eagerFlushThreshold = opts.eagerFlushThreshold ?? 150;
    this.onTokenRevoked = opts.onTokenRevoked;
  }

  /** Whether the bot token has been detected as revoked. */
  isTokenRevoked(): boolean {
    return this.tokenRevoked;
  }

  /**
   * Append text. Extends the current TextSegment if the last segment is text,
   * otherwise pushes a new TextSegment. Flushes eagerly at the threshold.
   */
  append(text: string): void {
    const last = this.segments[this.segments.length - 1];
    if (last?.type === 'text') {
      last.content += text;
    } else {
      this.segments.push({ type: 'text', content: text });
    }

    this.unflushedChars += text.length;
    if (this.unflushedChars >= this.eagerFlushThreshold) {
      if (this.updateTimer) {
        clearTimeout(this.updateTimer);
        this.updateTimer = null;
      }
      this.unflushedChars = 0;
      void this.flush();
    } else if (!this.updateTimer) {
      this.updateTimer = setTimeout(() => {
        this.unflushedChars = 0;
        void this.flush();
      }, this.debounceMs);
    }
  }

  /**
   * Record a tool call. Always pushes a new ToolSegment (never merges),
   * then flushes immediately so the context block appears right away.
   */
  addToolCall(name: string): void {
    this.segments.push({ type: 'tool', name });
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    this.unflushedChars = 0;
    void this.flush();
  }

  /** Flush remaining content with final markdown formatting. Call when the turn ends. */
  async finalize(citations?: Citation[] | null): Promise<void> {
    if (citations) this.citations = citations;
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    this.unflushedChars = 0;
    // Set finalized before awaiting so any in-flight fire-and-forget flush()
    // calls that wake up from a rate-limit sleep will see it and abort,
    // preventing them from overwriting the final Block Kit render.
    this.finalized = true;
    await this.flush(true);
  }

  /** Return all accumulated text content (concatenated across all TextSegments). */
  getBuffer(): string {
    return this.segments
      .filter((s): s is TextSegment => s.type === 'text')
      .map(s => s.content)
      .join('');
  }

  // ── Internal ──────────────────────────────────────────────────────────

  /**
   * Build Block Kit blocks from the segment sequence, preserving order.
   *
   * Streaming (isFinal=false):
   *   tool  → section block "> _Looking up <name>..._"
   *   text  → section block (light **bold**→*bold* conversion)
   *
   * Final (isFinal=true):
   *   tool  → task_card block (same)
   *   text  → full markdown→Block Kit conversion (header blocks, mrkdwn, rich_text lists)
   */
  private buildBlocks(isFinal = false): Array<Record<string, unknown>> {
    const blocks: Array<Record<string, unknown>> = [];

    for (const seg of this.segments) {
      if (blocks.length >= 49) break; // Slack hard limit is 50 blocks

      if (seg.type === 'tool') {
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: `> _Looking up ${formatToolName(seg.name)}..._` },
        });
      } else {
        // Strip the <CITATIONS> block so the raw JSON never renders in Slack
        // (chat-service parses it out of the persisted text; the streamer sees
        // the raw text_delta stream).
        const content = stripCitationsBlock(seg.content);
        if (!content.trim()) continue;

        if (isFinal) {
          const contentBlocks = buildFinalContentBlocks(content);
          const remaining = 49 - blocks.length;
          blocks.push(...contentBlocks.slice(0, remaining));
        } else {
          // Streaming: light conversion only; headers/bullets cleaned up at finalize
          const text = content
            .replace(/\*\*(.+?)\*\*/gm, '*$1*')
            .replace(/^[*\-+] /gm, '• ');
          let remaining = text;
          while (remaining && blocks.length < 49) {
            const chunk = remaining.slice(0, SECTION_MAX_CHARS);
            remaining = remaining.slice(SECTION_MAX_CHARS);
            if (chunk.trim()) {
              blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
            }
          }
        }
      }
    }

    // Append a "Sources" section from the message's citations (final render only).
    if (isFinal && this.citations.length > 0 && blocks.length < 48) {
      const sources = formatCitationsMrkdwn(this.citations);
      if (sources) {
        blocks.push({ type: 'divider' });
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: sources } });
      }
    }

    return blocks;
  }

  /** Build plain-text fallback for notifications and non-Block-Kit clients. */
  private buildFallbackText(): string {
    for (const seg of this.segments) {
      if (seg.type === 'text' && seg.content.trim()) {
        const clean = stripCitationsBlock(seg.content);
        const preview = clean
          .replace(/^#{1,6}\s+/gm, '')
          .replace(/\*\*/g, '')
          .slice(0, 300);
        return preview.length < clean.replace(/^#{1,6}\s+/gm, '').replace(/\*\*/g, '').length
          ? `${preview}…`
          : preview;
      }
    }
    const toolNames = this.segments
      .filter((s): s is ToolSegment => s.type === 'tool')
      .map(s => formatToolName(s.name));
    if (toolNames.length > 0) {
      const shown = toolNames.slice(0, 3).join(', ');
      return toolNames.length > 3
        ? `Looking up ${shown} and ${toolNames.length - 3} more...`
        : `Looking up ${shown}...`;
    }
    return ':hourglass_flowing_sand:';
  }

  private async flush(isFinal = false): Promise<void> {
    this.updateTimer = null;
    // Intermediate flushes must not run after finalize() has been called —
    // doing so would overwrite the correctly-rendered final Block Kit message
    // with a streaming version that leaves ## as literal text.
    if (!isFinal && this.finalized) return;
    if (this.segments.length === 0) return;

    const blocks = this.buildBlocks(isFinal);
    if (blocks.length === 0) return;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch('https://slack.com/api/chat.update', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.botToken}`,
          },
          body: JSON.stringify({
            channel: this.channel,
            ts: this.messageTs,
            text: this.buildFallbackText(),
            blocks,
          }),
        });

        const data = (await response.json()) as { ok: boolean; error?: string };
        if (data.ok) return;

        if (data.error === 'ratelimited') {
          const retryAfter = parseInt(
            response.headers.get('Retry-After') ?? '2',
            10,
          );
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          // Re-check after sleeping — finalize() may have completed during the wait.
          if (!isFinal && this.finalized) return;
          continue;
        }

        // CC-5: Detect token revocation
        if (data.error && TOKEN_REVOKED_ERRORS.has(data.error)) {
          log.error(
            { error: data.error, channel: this.channel },
            'SlackStreamer: bot token revoked or invalid — stopping updates',
          );
          this.tokenRevoked = true;
          this.onTokenRevoked?.();
          return;
        }

        log.warn(
          { error: data.error, channel: this.channel },
          'SlackStreamer: chat.update failed',
        );
        return;
      } catch (err) {
        log.warn(
          { error: (err as Error).message },
          'SlackStreamer: network error on chat.update',
        );
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000));
          // Re-check after sleeping — finalize() may have completed during the wait.
          if (!isFinal && this.finalized) return;
        }
      }
    }
  }
}

