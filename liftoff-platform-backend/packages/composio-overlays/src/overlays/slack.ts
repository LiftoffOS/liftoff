// Slack overlay — hand-authored (translate + W1 work-inbox/ack + thread history).
// Kept rich (not passthrough): the 2 previously-fabricated slugs were corrected
// to real Composio slugs (SLACK_LIST_ALL_CHANNELS, SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION).

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

interface SlackListInput {
  channelId?: unknown; channel?: unknown; limit?: unknown; since?: unknown; until?: unknown; pageToken?: unknown;
  oldest?: unknown; latest?: unknown; inclusive?: unknown; cursor?: unknown;
}
interface SlackReactInput { channelId?: unknown; channel?: unknown; messageId?: unknown; timestamp?: unknown; ts?: unknown; reaction?: unknown; name?: unknown; }
interface SlackSendInput {
  channelId?: unknown; channel?: unknown; text?: unknown; body?: unknown; markdown_text?: unknown; threadId?: unknown; thread_ts?: unknown; blocks?: unknown;
}
interface SlackListChannelsInput {
  types?: unknown; limit?: unknown; pageToken?: unknown; cursor?: unknown;
  channel_name?: unknown; exclude_archived?: unknown;
}
interface SlackHistoryResp { messages?: unknown[]; response_metadata?: { next_cursor?: string } }
interface SlackChannelsResp { channels?: Array<{ id: string; name: string }>; response_metadata?: { next_cursor?: string } }

export const SLACK_OVERLAYS: Record<string, ComposioToolOverlay> = {
  SLACK_FETCH_CONVERSATION_HISTORY: {
    stableName: 'list_messages',
    categoryOverrides: ['read'],
    workRole: 'inbox',
    paired_ack: 'add_reaction',
    workItemKind: 'chat_message',
    defaultedArgs: ['limit'],
    argDescriptions: {
      channel: 'The channel id (C…), from list_channels.',
      oldest: 'Only messages after this Slack timestamp.',
      latest: 'Only messages before this Slack timestamp.',
      cursor: 'The nextPageToken of a previous page, to continue listing.',
    },
    // The advertised (vendor) name comes first; the canonical aliases stay
    // accepted, never advertised.
    translateInput: (a) => {
      const i = a as SlackListInput;
      return {
        channel: i.channelId ?? i.channel,
        limit: i.limit ?? 100,
        oldest: i.oldest ?? i.since,
        latest: i.latest ?? i.until,
        inclusive: i.inclusive,
        cursor: i.cursor ?? i.pageToken,
      };
    },
    translateOutput: (r) => {
      const resp = r as SlackHistoryResp;
      return {
        items: (resp.messages ?? []) as unknown[],
        nextPageToken: resp.response_metadata?.next_cursor,
      };
    },
  },
  SLACK_ADD_REACTION_TO_AN_ITEM: {
    stableName: 'add_reaction',
    categoryOverrides: ['write'],
    workRole: 'ack',
    acknowledges: 'list_messages',
    workItemKind: 'chat_message',
    // The reaction is the ack; 'eyes' when the agent names none.
    defaultedArgs: ['name'],
    argDescriptions: {
      timestamp: 'The Slack timestamp (ts) of the message to react to.',
      name: 'The emoji name without colons (default eyes).',
    },
    translateInput: (a) => {
      const i = a as SlackReactInput;
      return {
        channel: i.channelId ?? i.channel,
        timestamp: i.messageId ?? i.timestamp ?? i.ts,
        name: i.name ?? i.reaction ?? 'eyes',
      };
    },
  },
  // Slug renamed upstream: Composio's live slack toolkit no longer has
  // SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL (execute returns "Unable to
  // retrieve tool with slug ..."). SLACK_SEND_MESSAGE is the
  // live canonical slug (verified against GET /api/v3/tools; the CHAT_POST_
  // MESSAGE variant is marked deprecated in favour of this one). The renamed
  // tool also hard-rejects the legacy `text` field, so translateInput
  // normalises to markdown_text (see below).
  SLACK_SEND_MESSAGE: {
    stableName: 'send_message',
    // Slack is an internal collaboration surface, not an outbound channel.
    // 'outbound' put this tool under the workspace Communication policy ("How
    // teams should handle outbound messages" — about reaching people OUTSIDE
    // the workspace), so with communication='draft' a post to an internal
    // channel like #ci-alerts was denied at canUseTool with nothing to
    // approve (no draftVariant exists — Slack has no draft endpoint).
    //
    // NOTE: this overlay is the LIVE source of these categories. The
    // connector-service boot block replaces CONNECTOR_FUNCTIONS['slack'] with
    // overlay-built functions, so the hand-edited SLACK_FUNCTIONS array in
    // connector-functions-registry.ts is dead code for slack — a retag made
    // there changes nothing at runtime.
    categoryOverrides: ['write'],
    // The canonical send is channel + markdown_text (+ blocks, + thread_ts).
    // The vendor's bot-identity and rendering knobs are the overlay's to
    // withhold; none of them is advertised. `text` stays advertised because
    // the translator honours it (as markdown_text) — see below.
    overlayOwnedArgs: [
      'parse', 'mrkdwn', 'as_user', 'icon_url', 'username', 'icon_emoji',
      'link_names', 'attachments', 'unfurl_links', 'unfurl_media', 'reply_broadcast',
    ],
    argDescriptions: {
      channel: 'The channel id (C…), from list_channels.',
      markdown_text: 'The message, in Slack markdown.',
      text: 'Deprecated by Slack; a value here is sent as markdown_text. Prefer markdown_text.',
      thread_ts: 'The ts of the parent message, to reply in its thread.',
    },
    translateInput: (a) => {
      const i = a as SlackSendInput;
      return {
        channel: i.channelId ?? i.channel,
        // SLACK_SEND_MESSAGE hard-rejects the legacy `text` field ("Use
        // markdown_text for normal content") even though the schema still
        // lists it as a deprecated property. Normalise every text-ish
        // input to markdown_text so a model that picks `text` off the schema
        // still succeeds first try.
        markdown_text: i.markdown_text ?? i.text ?? i.body,
        thread_ts: i.thread_ts ?? i.threadId,
        blocks: i.blocks,
      };
    },
    translateOutput: (r) => {
      const resp = r as { ts?: string; channel?: string };
      return { ts: resp.ts ?? '', channel: resp.channel ?? '' };
    },
  },
  SLACK_LIST_ALL_CHANNELS: {
    stableName: 'list_channels',
    categoryOverrides: ['read'],
    defaultedArgs: ['types', 'limit'],
    argDescriptions: {
      cursor: 'The nextPageToken of a previous page, to continue listing.',
    },
    translateInput: (a) => {
      const i = a as SlackListChannelsInput;
      return {
        types: i.types ?? 'public_channel,private_channel',
        limit: i.limit ?? 100,
        cursor: i.cursor ?? i.pageToken,
        channel_name: i.channel_name,
        exclude_archived: i.exclude_archived,
      };
    },
    translateOutput: (r) => {
      const resp = r as SlackChannelsResp;
      return {
        items: resp.channels ?? [],
        nextPageToken: resp.response_metadata?.next_cursor,
      };
    },
  },
  SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION: {
    stableName: 'read_thread',
    categoryOverrides: ['read'],
    defaultedArgs: ['limit'],
    argDescriptions: {
      ts: 'The ts of the thread\'s parent message.',
      cursor: 'The nextPageToken of a previous page, to continue listing.',
    },
    translateInput: (a) => {
      const i = a as {
        id?: unknown; channel?: unknown; ts?: unknown; limit?: unknown; pageToken?: unknown;
        cursor?: unknown; latest?: unknown; oldest?: unknown; inclusive?: unknown;
      };
      const rest = {
        limit: i.limit ?? 100,
        cursor: i.cursor ?? i.pageToken,
        latest: i.latest,
        oldest: i.oldest,
        inclusive: i.inclusive,
      };
      if (typeof i.id === 'string' && i.id.includes(':')) {
        const [channel, ts] = i.id.split(':');
        return { channel, ts, ...rest };
      }
      return { channel: i.channel, ts: i.ts, ...rest };
    },
    translateOutput: (r) => {
      const resp = r as { messages?: Array<{ ts: string; user?: string; text?: string }>; response_metadata?: { next_cursor?: string } };
      return {
        items: (resp.messages ?? []).map((m) => ({ id: m.ts, user: m.user ?? '', text: m.text ?? '' })),
        nextPageToken: resp.response_metadata?.next_cursor,
      };
    },
  },
};

export const SLACK_HISTORY_MAPPINGS: HistoryToolMapping[] = [
  {
    entityType: 'thread',
    stableName: 'read_thread',
    vendorToolName: 'SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION',
    translateInput: (a) => {
      const i = a as { id?: unknown };
      if (typeof i.id === 'string' && i.id.includes(':')) {
        const [channel, ts] = i.id.split(':');
        return { channel, ts, limit: 100 };
      }
      return { channel: '', ts: '', limit: 100 };
    },
    translateOutput: (r) => {
      const resp = r as { messages?: Array<{ ts: string; user?: string; text?: string }> };
      return { items: (resp.messages ?? []).map((m) => ({ id: m.ts, user: m.user ?? '', text: m.text ?? '' })) };
    },
  },
];
