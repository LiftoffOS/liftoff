// Block Kit cards for the Liftoff workspace Slack app (ADR-040).
//
// The agent picker is an external_select: Slack loads options by POSTing a
// block_suggestion payload to the interactivity URL as the user types (the
// Teams adapter's application/search typeahead analog), so the picker scales
// to any roster size. The intended binding context is encoded in the select's
// block_id — the interactivity handler can't otherwise tell whether a
// selection should bind a whole channel/DM or a single thread, because Slack
// only gives it the picker MESSAGE's coordinates.

export type BindingScope = 'dm' | 'channel' | 'group';

export interface PickerContext {
  scope: BindingScope;
  channelId: string;
  /** Empty string = channel/DM-level binding. */
  threadRootTs: string;
  /**
   * ts of the message that triggered the picker, so the chosen agent can
   * answer it instead of making the person ask twice. Empty when there is
   * nothing to answer (a bare mention, or an explicit switch).
   */
  pendingTs: string;
}

export const PICK_AGENT_ACTION_ID = 'liftoff_pick_agent';

const CTX_PREFIX = 'liftoff_pickctx';
// block_id must stay under Slack's 255-char limit: prefix (15) + scope (~7) +
// channel id (~11) + two ts (~17 each) + separators is well inside it. '|'
// cannot appear in Slack channel ids or timestamps.
export function encodePickerContext(ctx: PickerContext): string {
  return [CTX_PREFIX, ctx.scope, ctx.channelId, ctx.threadRootTs, ctx.pendingTs].join('|');
}

export function decodePickerContext(blockId: string): PickerContext | null {
  const parts = blockId.split('|');
  if (parts.length !== 5 || parts[0] !== CTX_PREFIX) return null;
  const [, scope, channelId, threadRootTs, pendingTs] = parts;
  if (scope !== 'dm' && scope !== 'channel' && scope !== 'group') return null;
  if (!channelId) return null;
  return { scope, channelId, threadRootTs, pendingTs };
}

/** The agent picker message (posted when no binding exists, or on "switch"). */
export function buildAgentPickerBlocks(ctx: PickerContext, promptText?: string): unknown[] {
  return [
    {
      type: 'section',
      block_id: encodePickerContext(ctx),
      text: {
        type: 'mrkdwn',
        text: promptText ?? 'Who would you like to talk to?',
      },
      accessory: {
        type: 'external_select',
        action_id: PICK_AGENT_ACTION_ID,
        placeholder: { type: 'plain_text', text: 'Select agent' },
        min_query_length: 0,
      },
    },
  ];
}

/** block_suggestion options payload from a picker agent list. */
export function buildPickerOptions(
  agents: Array<{ agentId: string; label: string }>,
): { options: Array<{ text: { type: 'plain_text'; text: string }; value: string }> } {
  return {
    options: agents.map((a) => ({
      // Slack caps option text at 75 chars.
      text: { type: 'plain_text' as const, text: a.label.slice(0, 75) },
      value: a.agentId,
    })),
  };
}
