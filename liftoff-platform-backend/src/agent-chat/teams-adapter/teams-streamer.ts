// TeamsStreamer — renders an agent's response into a Teams chat.
//
// Shows a typing indicator while the agent works — refreshed periodically, since
// Teams typing indicators fade after a few seconds — then posts the reply as an
// Adaptive Card. Message streaming and emoji reactions aren't used: the SDK
// rejects the streaming typing frames, and bots can't add reactions without a
// delegated user token (our app is application-permission + roster identity).
//
// Every send goes through adapter.continueConversationAsync(appId, ref, cb)
// so it is safe after the inbound ack (Cloud Run fire-and-forget).

import type { CloudAdapter, ConversationReference, TurnContext } from 'botbuilder';
import { log } from '../../infrastructure/logging';
import { getTeamsAdapter, getBotAppId } from './teams-bot-adapter';
import { buildAgentMessageCard, buildFilesCard } from './cards';
import { stripCitationsBlock, formatCitationsMarkdown } from '../citation-format';
import type { Citation } from '../chat-repository';
import type { FileCardItem } from '../file-cards';

const TYPING_REFRESH_MS = 4000;
const TYPING_MAX_TICKS = 45; // ~3 min safety cap in case finalize() never runs

export interface TeamsStreamerOpts {
  conversationReference: Partial<ConversationReference>;
  scope: 'personal' | 'channel' | 'groupChat';
  agentName: string;
}

export class TeamsStreamer {
  private readonly adapter: CloudAdapter;
  private readonly appId: string;
  private readonly ref: Partial<ConversationReference>;
  private readonly agentName: string;

  private fullText = '';
  private typingTimer: ReturnType<typeof setInterval> | null = null;
  private typingTicks = 0;

  constructor(opts: TeamsStreamerOpts) {
    this.adapter = getTeamsAdapter();
    this.appId = getBotAppId();
    this.ref = opts.conversationReference;
    this.agentName = opts.agentName;
  }

  /**
   * Show a typing indicator and keep it alive while the agent works. This is the
   * single ack path — the inbound handler no longer sends its own typing.
   */
  async begin(): Promise<void> {
    await this.sendTyping();
    this.typingTimer = setInterval(() => {
      if (this.typingTicks++ >= TYPING_MAX_TICKS) {
        this.stopTyping();
        return;
      }
      void this.sendTyping();
    }, TYPING_REFRESH_MS);
  }

  /** Accumulate a text delta into the final response. */
  append(text: string): void {
    this.fullText += text;
  }

  /** Tool calls are not surfaced separately in Teams (no incremental stream). */
  addToolCall(_name: string): void {
    // no-op
  }

  /** Concatenated text accumulated so far. */
  getBuffer(): string {
    return this.fullText;
  }

  /** Stop the typing indicator and post the final reply as an Adaptive Card. */
  async finalize(citations?: Citation[] | null): Promise<void> {
    this.stopTyping();
    let markdown = stripCitationsBlock(this.fullText).trim() || '(no response)';
    const sources = formatCitationsMarkdown(citations);
    if (sources) markdown += `\n\n${sources}`;
    await this.send(async (ctx) => {
      await ctx.sendActivity({
        type: 'message',
        attachments: [buildAgentMessageCard({ agentName: this.agentName, markdown })],
      });
    });
  }

  /** Post a follow-up card listing files the agent produced this turn. */
  async postFiles(files: FileCardItem[]): Promise<void> {
    if (files.length === 0) return;
    await this.send(async (ctx) => {
      await ctx.sendActivity({ type: 'message', attachments: [buildFilesCard(files)] });
    });
  }

  /**
   * Stop the typing indicator without posting anything.
   *
   * `begin()` arms a refresh interval that keeps the indicator alive for up to
   * ~3 minutes, and `finalize()` is what normally clears it. A turn that is
   * being handed back to the queue posts no reply, so it never reaches
   * finalize — and without this the interval would keep firing typing frames at
   * a conversation whose turn has already ended, on an instance that has already
   * answered the request. Public because abandoning a turn is a legitimate end
   * state, not an error path.
   */
  abandon(): void {
    this.stopTyping();
  }

  private stopTyping(): void {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
  }

  private async sendTyping(): Promise<void> {
    await this.send(async (ctx) => {
      await ctx.sendActivity({ type: 'typing' });
    });
  }

  private async send(cb: (ctx: TurnContext) => Promise<void>): Promise<void> {
    try {
      await this.adapter.continueConversationAsync(this.appId, this.ref, cb);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'TeamsStreamer send failed');
    }
  }
}

export function makeTeamsStreamer(opts: TeamsStreamerOpts): TeamsStreamer {
  return new TeamsStreamer(opts);
}

