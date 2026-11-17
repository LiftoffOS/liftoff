// Tool schemas for the shared-bot Microsoft Teams surface.
//
// Surfaced to distillation in platform-backend (agent-teams-distill-tools.ts)
// and dispatched here by tenant-runtime's tool-gateway. One multi-tenant
// Liftoff bot serves all agents — there are no per-agent tokens. JSON Schema
// draft-07 (no $ref / no anyOf; every array has items), matching the platform
// tool-validator.

import type { LLMTool } from '@liftoffos/runtime-shared-types';

type AgentTeamsToolDef = LLMTool & {
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

export const AGENT_TEAMS_TOOL_NAMES = [
  'teams_send_message',
  'teams_reply_in_thread',
  'teams_update_message',
  'teams_send_dm',
  'teams_list_channels',
  'teams_get_thread',
  'teams_get_user_info',
] as const;

export type AgentTeamsToolName = typeof AGENT_TEAMS_TOOL_NAMES[number];

/** Tools that send communication outward — gateable by HITL `communication: 'review'`. */
export const COMMUNICATION_GATED_TOOLS: ReadonlySet<AgentTeamsToolName> = new Set([
  'teams_send_message',
  'teams_reply_in_thread',
  'teams_update_message',
  'teams_send_dm',
]);

/** Outbound tools consumed by hitl-side-effects to decide whether to fan out a
 *  Teams review card (parallel to SLACK_OUTBOUND_TOOL_NAMES). */
export const TEAMS_OUTBOUND_TOOL_NAMES: ReadonlySet<string> = new Set([
  'teams_send_message',
  'teams_reply_in_thread',
  'teams_update_message',
  'teams_send_dm',
]);

const CHANNEL_DESC =
  'Microsoft Teams channel id. Use teams_list_channels to discover channel ids first.';

export const AGENT_TEAMS_TOOLS: AgentTeamsToolDef[] = [
  {
    name: 'teams_send_message',
    description:
      'Post a message to a Microsoft Teams channel. Use this for one-off posts, ' +
      'alerts, and summaries. To reply inside an existing thread, use ' +
      'teams_reply_in_thread instead.',
    // Microsoft Teams is an internal collaboration surface, not a customer channel
    // and not a publishing channel. See the matching note in
    // agent-slack-tool-catalog.ts. `internalCollaboration` is deliberately NOT a key
    // in oversight.sensitiveWork, so it can never match an enabled checkbox.
    categories: ['internalCollaboration'],
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: CHANNEL_DESC },
        text: { type: 'string', description: 'Message text (basic markdown supported).' },
      },
      required: ['channel', 'text'],
    },
  },
  {
    name: 'teams_reply_in_thread',
    description: 'Post a reply inside an existing Teams channel thread.',
    // Microsoft Teams is an internal collaboration surface, not a customer channel
    // and not a publishing channel. See the matching note in
    // agent-slack-tool-catalog.ts. `internalCollaboration` is deliberately NOT a key
    // in oversight.sensitiveWork, so it can never match an enabled checkbox.
    categories: ['internalCollaboration'],
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: CHANNEL_DESC },
        thread_id: { type: 'string', description: 'The root message id of the thread to reply to.' },
        text: { type: 'string', description: 'Reply text (basic markdown supported).' },
      },
      required: ['channel', 'thread_id', 'text'],
    },
  },
  {
    name: 'teams_update_message',
    description: 'Edit a message previously posted by the bot.',
    // Microsoft Teams is an internal collaboration surface, not a customer channel
    // and not a publishing channel. See the matching note in
    // agent-slack-tool-catalog.ts. `internalCollaboration` is deliberately NOT a key
    // in oversight.sensitiveWork, so it can never match an enabled checkbox.
    categories: ['internalCollaboration'],
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: CHANNEL_DESC },
        message_id: { type: 'string', description: 'The id of the message to edit.' },
        text: { type: 'string', description: 'New message text.' },
      },
      required: ['channel', 'message_id', 'text'],
    },
  },
  {
    name: 'teams_send_dm',
    description: 'Send a direct (1:1) message to a Teams user.',
    // Microsoft Teams is an internal collaboration surface, not a customer channel
    // and not a publishing channel. See the matching note in
    // agent-slack-tool-catalog.ts. `internalCollaboration` is deliberately NOT a key
    // in oversight.sensitiveWork, so it can never match an enabled checkbox.
    categories: ['internalCollaboration'],
    input_schema: {
      type: 'object',
      properties: {
        user: { type: 'string', description: 'The Teams user (aadObjectId) to DM.' },
        text: { type: 'string', description: 'Message text.' },
      },
      required: ['user', 'text'],
    },
  },
  {
    name: 'teams_list_channels',
    effect: 'read',
    description: 'List the Teams channels the bot has access to.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'teams_get_thread',
    effect: 'read',
    description: 'Fetch the replies in a Teams channel thread.',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: CHANNEL_DESC },
        thread_id: { type: 'string', description: 'The root message id of the thread.' },
      },
      required: ['channel', 'thread_id'],
    },
  },
  {
    name: 'teams_get_user_info',
    effect: 'read',
    description: 'Look up a Teams user by aadObjectId (display name, email).',
    input_schema: {
      type: 'object',
      properties: { user: { type: 'string', description: 'The Teams user aadObjectId.' } },
      required: ['user'],
    },
  },
];
