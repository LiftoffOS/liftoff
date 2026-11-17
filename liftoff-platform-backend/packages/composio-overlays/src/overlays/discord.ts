// discord overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const DISCORD_OVERLAYS: Record<string, ComposioToolOverlay> = {
  DISCORD_LIST_MY_GUILDS: { stableName: 'list_guilds', categoryOverrides: ["read"] },
  DISCORD_GET_MY_USER: { stableName: 'get_current_user', categoryOverrides: ["read"] },
  DISCORD_GET_MY_GUILD_MEMBER: { stableName: 'get_guild_member', categoryOverrides: ["read"] },
  DISCORD_LIST_MY_CONNECTIONS: { stableName: 'list_connections', categoryOverrides: ["read"] },
  DISCORD_GET_INVITE: { stableName: 'get_invite', categoryOverrides: ["write"] },
};

export const DISCORD_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
