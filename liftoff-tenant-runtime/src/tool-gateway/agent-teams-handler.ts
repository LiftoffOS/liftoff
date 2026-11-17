// Shared-bot Microsoft Teams tool handler.
//
// Dispatched from tool-gateway when a tool call matches AGENT_TEAMS_TOOL_NAMES.
// One multi-tenant Liftoff bot serves all agents, so all Graph/Connector work is
// done by platform-backend's bot adapter via the /api/internal/agent-teams/*
// endpoints — there are no per-agent tokens. Outbound posts (send/reply/update/
// dm) and reads (list channels, thread replies, user info) both route there.

import { logger } from '../infrastructure/logging';
import {
  listAgentTeamsConversations,
  sendTeamsActivity,
  sendTeamsDm,
  getTeamsUserInfo,
  getTeamsThread,
} from '../agent-chat/agent-teams-client';
import type { ExecuteResult } from './types';
import { AGENT_TEAMS_TOOL_NAMES, type AgentTeamsToolName } from './agent-teams-tool-catalog';

export interface AgentTeamsHandlerInput {
  tenantId: string;
  agentId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  traceId: string;
}

function requireString(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (typeof v !== 'string' || !v) throw new Error(`missing required string '${key}'`);
  return v;
}

function isAgentTeamsTool(name: string): name is AgentTeamsToolName {
  return (AGENT_TEAMS_TOOL_NAMES as readonly string[]).includes(name);
}

class AgentTeamsHandler {
  async execute(input: AgentTeamsHandlerInput): Promise<ExecuteResult> {
    const { toolName, traceId } = input;
    if (!isAgentTeamsTool(toolName)) {
      return { success: false, data: null, error: `unknown_teams_tool: ${toolName}`, traceId };
    }
    try {
      const data = await this.dispatch(toolName, input);
      return { success: true, data, traceId };
    } catch (err) {
      logger.warn({ toolName, err: (err as Error).message }, 'agent-teams tool failed');
      return { success: false, data: null, error: (err as Error).message, traceId };
    }
  }

  private async dispatch(toolName: AgentTeamsToolName, input: AgentTeamsHandlerInput): Promise<unknown> {
    const p = input.toolInput;
    const { tenantId, agentId } = input;

    switch (toolName) {
      case 'teams_send_message': {
        const conversationId = requireString(p, 'channel');
        const text = requireString(p, 'text');
        return sendTeamsActivity({ tenantId, agentId, conversationId, text, kind: 'message' });
      }
      case 'teams_reply_in_thread': {
        const conversationId = requireString(p, 'channel');
        const text = requireString(p, 'text');
        // thread_id is the root message; the conversationId carries the thread.
        return sendTeamsActivity({ tenantId, agentId, conversationId, text, kind: 'reply' });
      }
      case 'teams_update_message': {
        const conversationId = requireString(p, 'channel');
        const messageId = requireString(p, 'message_id');
        const text = requireString(p, 'text');
        return sendTeamsActivity({ tenantId, agentId, conversationId, text, kind: 'update', messageId });
      }
      case 'teams_list_channels': {
        const convs = await listAgentTeamsConversations(tenantId, agentId);
        return {
          channels: convs.map((c) => ({ channel: c.conversationId, scope: c.scope })),
        };
      }
      case 'teams_send_dm': {
        const aadUserId = requireString(p, 'user');
        const text = requireString(p, 'text');
        return sendTeamsDm({ tenantId, agentId, aadUserId, text });
      }
      case 'teams_get_thread': {
        const conversationId = requireString(p, 'channel');
        const messageId = requireString(p, 'thread_id');
        return getTeamsThread(tenantId, conversationId, messageId);
      }
      case 'teams_get_user_info': {
        const aadUserId = requireString(p, 'user');
        return getTeamsUserInfo(tenantId, aadUserId);
      }
    }
  }
}

export const agentTeamsHandler = new AgentTeamsHandler();

export function isAgentTeamsToolName(name: string): boolean {
  return (AGENT_TEAMS_TOOL_NAMES as readonly string[]).includes(name);
}
