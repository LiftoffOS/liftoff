// Per-agent Slack tool definitions surfaced to the distillation LLM.
//
// Kept in sync with tenant-runtime's src/tool-gateway/agent-slack-tool-catalog.ts.
// The two files MUST list the same tool names and the same JSON Schema
// shapes — tenant-runtime dispatches by tool name, distill-service tells
// the LLM these tools exist. A divergence means the agent might emit a
// tool call the runtime can't handle, or skip a capability it actually has.
//
// We duplicate (rather than share via shared-types) because:
//   - tool descriptions are LLM-facing and may need to differ slightly
//     between distill-time (planning) and runtime (execution)
//   - shared-types is already large; pulling Slack-specific schemas in
//     forces an upgrade on every package that consumes it
//
// Follow-up: extract to shared-types if a third repo needs these.

export interface DistillSlackTool {
  name: string;
  description: string;
}

export const AGENT_SLACK_DISTILL_TOOLS: readonly DistillSlackTool[] = [
  {
    name: 'slack_send_message',
    description:
      'Post a message to a Slack channel by channel id. The agent must have ' +
      'been invited to that channel for the post to succeed. Use ' +
      'slack_list_channels or slack_resolve_channel_by_name to discover ' +
      'channel ids first.',
  },
  {
    name: 'slack_reply_in_thread',
    description:
      "Post a reply inside an existing Slack thread (parent message's ts). " +
      'Prefer threads over channel-spam for follow-ups to a specific message.',
  },
  {
    name: 'slack_update_message',
    description:
      'Edit a message previously posted by this agent.',
  },
  {
    name: 'slack_delete_message',
    description:
      'Delete a message previously posted by this agent.',
  },
  {
    name: 'slack_add_reaction',
    description:
      'Add a reaction emoji to a message (e.g. ":white_check_mark:" to ' +
      'confirm, ":eyes:" to acknowledge).',
  },
  {
    name: 'slack_list_channels',
    description:
      'List public + private channels the agent has access to (the channels ' +
      'someone invited the agent bot into).',
  },
  {
    name: 'slack_resolve_channel_by_name',
    description:
      'Look up a channel id by its human name (e.g. "customer-support"). ' +
      'Returns null if the agent has not been invited to the channel.',
  },
  {
    name: 'slack_get_thread',
    description:
      'Fetch all messages in a Slack thread. Use when responding to a thread ' +
      'where context matters.',
  },
  {
    name: 'slack_get_user_info',
    description:
      'Look up a Slack user by id (display name, email).',
  },
  {
    name: 'slack_send_dm',
    description:
      'Open a DM with a Slack user and post a message. Useful for private ' +
      'follow-ups.',
  },
] as const;

/**
 * Guidance appended to the distill system prompt when the agent has per-
 * agent Slack tools available. Tells the LLM to use the slack_* family
 * directly without inventing channel-binding tool names or expecting a
 * workspace OAuth.
 */
export const AGENT_SLACK_DISTILL_PROMPT_NOTE =
  '\n\n## Slack tools\n\n' +
  'The slack_* tools above post through the Liftoff Slack app installed in this ' +
  "workspace. That is the ONLY way an agent posts to Slack. The message arrives " +
  'from the Liftoff app and the platform prefixes the speaking agent\'s name, so ' +
  'do not add a name prefix yourself and do not describe the post as coming from ' +
  'a person.\n\n' +
  "If the responsibilities mention 'post to #channel-name' or 'alert the team in " +
  "Slack', use slack_send_message (or slack_reply_in_thread for replies). Call " +
  'slack_resolve_channel_by_name when given a #name, or slack_list_channels to ' +
  'discover what the app has been invited into.\n\n' +
  'A Slack CONNECTOR may also be bound to this agent. Its tools are for READING ' +
  'Slack. Never use a connector tool to send, reply, update or DM: those carry ' +
  'the identity of the person who connected Slack, and a post that appears to ' +
  'come from a human when an agent wrote it is never what the operator asked ' +
  'for. Sending is slack_* only.';
