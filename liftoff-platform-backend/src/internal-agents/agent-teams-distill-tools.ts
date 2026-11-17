// Per-agent Microsoft Teams tool definitions surfaced to the distillation LLM.
//
// Kept in sync with tenant-runtime's src/tool-gateway/agent-teams-tool-catalog.ts
// (same tool names). The single multi-tenant Liftoff bot serves all agents, so
// distill surfaces these whenever the tenant has Teams published (tenant-level),
// unlike the per-agent Slack install count.

export interface DistillTeamsTool {
  name: string;
  description: string;
}

export const AGENT_TEAMS_DISTILL_TOOLS: readonly DistillTeamsTool[] = [
  {
    name: 'teams_send_message',
    description:
      'Post a message to a Microsoft Teams channel by channel id. The Liftoff ' +
      'bot must be installed in that team. Use teams_list_channels to discover ' +
      'channel ids first.',
  },
  {
    name: 'teams_reply_in_thread',
    description:
      'Post a reply inside an existing Teams channel thread (the root message id). ' +
      'Prefer threads over new posts for follow-ups to a specific message.',
  },
  {
    name: 'teams_update_message',
    description: 'Edit a message previously posted by the bot in Teams.',
  },
  {
    name: 'teams_send_dm',
    description:
      'Send a direct (1:1) message to a Teams user. Useful for private follow-ups.',
  },
  {
    name: 'teams_list_channels',
    description:
      'List the Teams channels the bot has access to (the teams it has been ' +
      'installed into).',
  },
  {
    name: 'teams_get_thread',
    description:
      'Fetch the replies in a Teams channel thread. Use when responding to a ' +
      'thread where context matters.',
  },
  {
    name: 'teams_get_user_info',
    description: 'Look up a Teams user (display name, email).',
  },
] as const;

/**
 * Guidance appended to the distill system prompt when the agent has Teams
 * available (the tenant has connected Microsoft Teams). One shared bot serves
 * all agents — there is no per-agent Teams app.
 */
export const AGENT_TEAMS_DISTILL_PROMPT_NOTE =
  '\n\n## Microsoft Teams tools (shared Liftoff bot)\n\n' +
  'When the workspace has connected Microsoft Teams, the teams_* tools above ' +
  'are available for outbound posts. Messages are sent through the shared ' +
  'Liftoff bot in whichever teams/channels it has been installed into. If the ' +
  "responsibilities mention 'post to a Teams channel' or 'message the team in " +
  "Teams', use teams_send_message (or teams_reply_in_thread for replies). Use " +
  'teams_list_channels to discover available channels.';
