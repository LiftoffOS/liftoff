// Outbound posting for the runtime teams_* tools.
//
// One shared bot serves all agents, so posting is centralised here (PB holds
// the bot adapter + credentials) rather than duplicating bot creds into
// tenant-runtime. Posts to a known conversation by id using its stored
// ConversationReference via continueConversationAsync.
//
// Channel new-post vs reply: a channel ConversationReference's conversation.id
// carries `;messageid=<root>` when it points at a thread. For kind 'message'
// (a new top-level post) we strip that suffix so the bot starts a new thread
// root; for kind 'reply' we keep it so the bot replies inside the thread.

import type { ConversationReference, TurnContext } from 'botbuilder';
import { getTeamsAdapter, getBotAppId } from './teams-bot-adapter';
import { getConversationReferenceById } from './repository';

export interface SendToConversationInput {
  tenantId: string;
  conversationId: string;
  text: string;
  kind: 'message' | 'reply' | 'update';
  messageId?: string;
}

/** Strip the `;messageid=...` thread suffix so a post starts a new channel thread. */
function bareChannelRef(
  ref: Partial<ConversationReference>,
): Partial<ConversationReference> {
  const conv = ref.conversation;
  if (!conv?.id || !conv.id.includes(';messageid=')) return ref;
  return { ...ref, conversation: { ...conv, id: conv.id.split(';messageid=')[0] } };
}

/** Default pause before the single retry, when the service gives no hint. */
const DEFAULT_RETRY_DELAY_MS = 1_000;
/** Never wait longer than this, whatever Retry-After says — the caller is a
 *  request with its own deadline. */
const MAX_RETRY_DELAY_MS = 5_000;

/**
 * How long to wait before the one retry, or null when the failure is not
 * transient and retrying would just repeat it (or duplicate a post).
 *
 * Retryable: 429 (with Retry-After honoured when present) and 5xx, plus the
 * usual socket-level failures. Everything else — 4xx auth, a missing
 * conversation, a malformed activity — is a real answer, not a blip.
 */
function transientRetryDelayMs(err: unknown): number | null {
  const e = err as { statusCode?: number; code?: string; headers?: Record<string, string> } | null;
  const status = e?.statusCode;

  if (status === 429) {
    const header = e?.headers?.['retry-after'] ?? e?.headers?.['Retry-After'];
    const seconds = header ? Number(header) : NaN;
    const ms = Number.isFinite(seconds) ? seconds * 1000 : DEFAULT_RETRY_DELAY_MS;
    return Math.min(ms, MAX_RETRY_DELAY_MS);
  }
  if (typeof status === 'number' && status >= 500) return DEFAULT_RETRY_DELAY_MS;

  const code = e?.code;
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN') {
    return DEFAULT_RETRY_DELAY_MS;
  }
  return null;
}

export async function sendToConversation(
  input: SendToConversationInput,
): Promise<{ activityId: string | null }> {
  const stored = await getConversationReferenceById(input.tenantId, input.conversationId);
  if (!stored) throw new Error(`No conversation reference for ${input.conversationId}`);
  const ref = stored as Partial<ConversationReference>;

  const adapter = getTeamsAdapter();
  const appId = getBotAppId();
  let activityId: string | null = null;

  // New top-level post → strip the thread suffix; reply/update keep the thread.
  const targetRef = input.kind === 'message' ? bareChannelRef(ref) : ref;

  // C1: one bounded retry on a transient failure.
  //
  // Teams had none at all, so a single blip lost the message outright. Slack's
  // client already honours 429 with Retry-After; this mirrors that intent for
  // the surface that had nothing.
  //
  // Bounded to ONE retry, and only for transient shapes: an update is not
  // idempotent in the general case, and re-sending after an ambiguous failure
  // is exactly how people end up with duplicates. The delivery-obligation row
  // is what covers the harder cases; this only smooths over the blips.
  const attemptSend = async (): Promise<void> => {
    await adapter.continueConversationAsync(appId, targetRef, async (ctx: TurnContext) => {
      if (input.kind === 'update' && input.messageId) {
        await ctx.updateActivity({ id: input.messageId, type: 'message', text: input.text });
        activityId = input.messageId;
      } else {
        const res = await ctx.sendActivity({ type: 'message', text: input.text });
        activityId = res?.id ?? null;
      }
    });
  };

  try {
    await attemptSend();
  } catch (err) {
    const retryAfterMs = transientRetryDelayMs(err);
    if (retryAfterMs === null) throw err;
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
    await attemptSend();
  }

  return { activityId };
}
