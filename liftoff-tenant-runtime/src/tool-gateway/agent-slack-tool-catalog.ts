// Tool schemas for the per-agent Slack surface.
//
// Surfaced to distillation in platform-backend (via the parallel
// fetchAgentSlackTools helper) so the LLM knows these tools exist when
// the agent has an installed per-agent Slack app. Each schema is JSON
// Schema draft-07, compatible with the platform tool-validator (no $ref,
// no anyOf; every array has items).

import type { LLMTool } from '@liftoffos/runtime-shared-types';

/** Local extension of LLMTool: adds the categories field used by
 *  tenant-runtime's HITL interceptor + gate. shared-types' LLMTool intentionally
 *  omits this because the LLM-facing surface doesn't need it; the runtime
 *  catalog does. */
type AgentSlackToolDef = LLMTool & {
  categories?: string[];
  /** Side-effect class, STATED rather than inferred from absence.
   *
   *  This catalog signalled write-ness by carrying `categories` and
   *  read-ness by carrying nothing. The gate reads it the other way:
   *  `toolIsReadOnly` trusts `read` only when it is stated, because "a
   *  RESOLVED entry carrying NEITHER signal is a catalog that lost the
   *  classification, not a tool nobody classified" — so it fails closed.
   *
   *  Two conventions in conflict, and the reads lost. On an
   *  untrusted-inbound run the external-content invariant gated every one
   *  of them as an effectful write: `slack_resolve_channel_by_name
   *  { name: "code-reviewer" }` would ask a person to authorise LOOKING UP
   *  A CHANNEL ID, from a step whose own description says it exists so the
   *  notification can be posted to the right channel.
   *
   *  The identical failure occurs on Gmail's `get_thread`
   *  ("Approval needed — Retrieve email thread…") and on
   *  `record_step_output`. Both were fixed by stating the effect. These
   *  two catalogs are hand-written and were reached by neither the
   *  central `tool-effect.ts` map nor a connector manifest, so they kept
   *  the defect after both fixes. */
  effect?: 'read' | 'write' | 'spawn';
};

export const AGENT_SLACK_TOOL_NAMES = [
  'slack_send_message',
  'slack_reply_in_thread',
  'slack_update_message',
  'slack_delete_message',
  'slack_add_reaction',
  'slack_list_channels',
  'slack_resolve_channel_by_name',
  'slack_get_thread',
  'slack_get_user_info',
  'slack_send_dm',
] as const;

export type AgentSlackToolName = typeof AGENT_SLACK_TOOL_NAMES[number];

/** Tool calls that send communication outward — gateable by HITL
 *  `communication: 'review'`. */
export const COMMUNICATION_GATED_TOOLS: ReadonlySet<AgentSlackToolName> = new Set([
  'slack_send_message',
  'slack_reply_in_thread',
  'slack_update_message',
  'slack_send_dm',
]);

const CHANNEL_DESC =
  'Slack channel id (e.g. "C01234"). Use slack_list_channels or ' +
  'slack_resolve_channel_by_name if you only have a channel name.';

const WORKSPACE_DESC =
  'Optional Slack workspace (team) id when the agent is installed in ' +
  'multiple workspaces. Omit when only one is installed — the tool will use it.';

export const AGENT_SLACK_TOOLS: AgentSlackToolDef[] = [
  {
    name: 'slack_send_message',
    description:
      'Post a message to a Slack channel. Use this for one-off posts, alerts, ' +
      'and summaries. To reply inside an existing thread, use ' +
      'slack_reply_in_thread instead.',
    // Slack is an internal collaboration surface, not a customer channel and not a
    // publishing channel. The previous tags contradicted this tool's own description
    // ("one-off posts, alerts, and summaries") and made an internal CI ping gate as
    // customer communication. `internalCollaboration` is deliberately NOT a key in
    // oversight.sensitiveWork, so it can never match an enabled checkbox.
    categories: ['internalCollaboration'],
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: CHANNEL_DESC },
        text: { type: 'string', description: 'Message text. Slack mrkdwn supported.' },
        blocks: {
          type: 'array',
          description: 'Optional Block Kit payload. If supplied, text is the fallback notification.',
          items: { type: 'object', properties: {}, additionalProperties: true },
        },
        workspace: { type: 'string', description: WORKSPACE_DESC },
      },
      required: ['channel', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'slack_reply_in_thread',
    description:
      "Post a reply inside an existing Slack thread. Use the parent message's " +
      'ts as thread_ts. Threads keep conversation tidy and avoid spamming the ' +
      'channel for follow-ups.',
    // Slack is an internal collaboration surface, not a customer channel and not a
    // publishing channel. The previous tags contradicted this tool's own description
    // ("one-off posts, alerts, and summaries") and made an internal CI ping gate as
    // customer communication. `internalCollaboration` is deliberately NOT a key in
    // oversight.sensitiveWork, so it can never match an enabled checkbox.
    categories: ['internalCollaboration'],
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: CHANNEL_DESC },
        thread_ts: { type: 'string', description: "Parent message ts (e.g. '1716847200.123456')." },
        text: { type: 'string', description: 'Reply text.' },
        blocks: {
          type: 'array',
          description: 'Optional Block Kit payload.',
          items: { type: 'object', properties: {}, additionalProperties: true },
        },
        workspace: { type: 'string', description: WORKSPACE_DESC },
      },
      required: ['channel', 'thread_ts', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'slack_update_message',
    description:
      'Edit a message previously posted by this agent. You can only edit your ' +
      "own bot's messages. Pass the channel and ts of the original message.",
    categories: ['internalCollaboration'],
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: CHANNEL_DESC },
        ts: { type: 'string', description: 'Message ts to edit.' },
        text: { type: 'string', description: 'Replacement text.' },
        blocks: {
          type: 'array',
          description: 'Optional replacement Block Kit payload.',
          items: { type: 'object', properties: {}, additionalProperties: true },
        },
        workspace: { type: 'string', description: WORKSPACE_DESC },
      },
      required: ['channel', 'ts', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'slack_delete_message',
    description: 'Delete a message previously posted by this agent.',
    categories: ['internalCollaboration'],
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: CHANNEL_DESC },
        ts: { type: 'string', description: 'Message ts to delete.' },
        workspace: { type: 'string', description: WORKSPACE_DESC },
      },
      required: ['channel', 'ts'],
      additionalProperties: false,
    },
  },
  {
    name: 'slack_add_reaction',
    // A reaction is a state change on someone else's message, not a read.
    effect: 'write',
    categories: ['internalCollaboration'],
    description:
      'Add a reaction emoji to a message (e.g. "white_check_mark" to confirm, ' +
      '"eyes" to acknowledge work in progress). Emoji name without colons.',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: CHANNEL_DESC },
        ts: { type: 'string', description: 'Message ts to react to.' },
        emoji: { type: 'string', description: 'Emoji name without colons.' },
        workspace: { type: 'string', description: WORKSPACE_DESC },
      },
      required: ['channel', 'ts', 'emoji'],
      additionalProperties: false,
    },
  },
  {
    name: 'slack_list_channels',
    effect: 'read',
    description:
      'List public + private channels the agent has access to. Optional ' +
      'cursor for pagination. Result includes ids the agent can use as ' +
      'channel inputs to send tools.',
    input_schema: {
      type: 'object',
      properties: {
        types: {
          type: 'string',
          description: "Comma-separated list of channel types. Default 'public_channel,private_channel'.",
        },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
        cursor: { type: 'string', description: 'Pagination cursor from a prior call.' },
        workspace: { type: 'string', description: WORKSPACE_DESC },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'slack_resolve_channel_by_name',
    effect: 'read',
    description:
      'Find a channel by its human name (e.g. "customer-support"). Returns ' +
      'the channel id or null if not found / agent not invited.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Channel name, with or without leading "#".',
        },
        workspace: { type: 'string', description: WORKSPACE_DESC },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'slack_get_thread',
    effect: 'read',
    description:
      'Fetch all messages in a thread by channel + parent ts. Returns messages ' +
      'in chronological order. Use this when responding to a thread you need ' +
      'full context for.',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: CHANNEL_DESC },
        thread_ts: { type: 'string', description: 'Parent message ts.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        workspace: { type: 'string', description: WORKSPACE_DESC },
      },
      required: ['channel', 'thread_ts'],
      additionalProperties: false,
    },
  },
  {
    name: 'slack_get_user_info',
    effect: 'read',
    description:
      'Look up a Slack user by id. Useful when a message references a user ' +
      'and you want their display name or email.',
    input_schema: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: "Slack user id (e.g. 'U01234')." },
        workspace: { type: 'string', description: WORKSPACE_DESC },
      },
      required: ['user_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'slack_send_dm',
    description:
      'Open a DM with a Slack user and post a message. Useful for private ' +
      'follow-ups or sensitive escalations.',
    // Slack is an internal collaboration surface, not a customer channel and not a
    // publishing channel. The previous tags contradicted this tool's own description
    // ("one-off posts, alerts, and summaries") and made an internal CI ping gate as
    // customer communication. `internalCollaboration` is deliberately NOT a key in
    // oversight.sensitiveWork, so it can never match an enabled checkbox.
    categories: ['internalCollaboration'],
    input_schema: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'Slack user id to DM.' },
        text: { type: 'string', description: 'Message text.' },
        blocks: {
          type: 'array',
          description: 'Optional Block Kit payload.',
          items: { type: 'object', properties: {}, additionalProperties: true },
        },
        workspace: { type: 'string', description: WORKSPACE_DESC },
      },
      required: ['user_id', 'text'],
      additionalProperties: false,
    },
  },
];

/** Names that the executeToolCalls draft-redirect block uses to identify
 *  outbound Slack tools. Kept in sync with the categories tags above. */
export const SLACK_OUTBOUND_TOOL_NAMES: ReadonlySet<string> = new Set([
  'slack_send_message',
  'slack_reply_in_thread',
  'slack_update_message',
  'slack_send_dm',
]);
