// Per-agent Slack tool handler.
//
// Dispatched from tool-gateway when a tool call carries actionType
// matching the AGENT_SLACK_TOOL_NAMES set. Routes to Slack Web API using
// the agent's per-workspace bot token resolved from platform-backend
// (which fetches the token from Secret Manager).
//
// HITL is enforced upstream by the existing tool-interceptor: tools in
// COMMUNICATION_GATED_TOOLS are gated by the oversight `communication`
// category, same as reply_email.
//
// Audit + cost attribution: the standard tool-gateway path emits
// `tool_executed` audit events and usage_events with cost_micros=0 for
// connector-style calls. We piggyback on that — the handler returns the
// ExecuteResult shape the dispatcher expects, and audit metadata is
// derived from input.actionType + the resolved team id.

import { logger } from '../infrastructure/logging';
import {
  resolveInstallForCall,
  SlackNotInstalledError,
  SlackWorkspaceAmbiguousError,
  SlackWorkspaceNotFoundError,
  type AgentSlackInstall,
} from '../agent-chat/agent-slack-client';
import { slackApiCall, SlackApiError } from '../agent-chat/slack-api';
import type { ExecuteResult } from './types';
import {
  AGENT_SLACK_TOOL_NAMES,
  type AgentSlackToolName,
} from './agent-slack-tool-catalog';

export interface AgentSlackHandlerInput {
  tenantId: string;
  agentId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  traceId: string;
}

class AgentSlackHandler {
  async execute(input: AgentSlackHandlerInput): Promise<ExecuteResult> {
    const { toolName, traceId } = input;

    if (!isAgentSlackTool(toolName)) {
      return failure(traceId, `unknown_slack_tool: ${toolName}`);
    }

    try {
      const install = await resolveInstallForCall(
        input.tenantId,
        input.agentId,
        typeof input.toolInput.workspace === 'string'
          ? input.toolInput.workspace
          : undefined,
      );

      // Bot token is guaranteed non-null after resolveInstallForCall
      const botToken = install.botToken as string;

      const data = await this.dispatchTool(
        toolName,
        botToken,
        install,
        input,
      );

      return { success: true, data, traceId };
    } catch (err) {
      return this.toExecuteResult(err, traceId, toolName);
    }
  }

  private async dispatchTool(
    toolName: AgentSlackToolName,
    botToken: string,
    install: AgentSlackInstall,
    input: AgentSlackHandlerInput,
  ): Promise<unknown> {
    const p = input.toolInput;
    // One Liftoff bot posts for every agent, so an agent-authored message
    // opens by saying who is speaking. The SENDER stays the Liftoff app: an
    // agent carrying a human nickname must not look like a colleague, and one
    // app should read as one app. Legacy per-agent installs need no prefix —
    // that bot already IS the agent.
    const speaker = install.postAs?.username;
    const say = (text: string): string => (speaker ? `${speaker}: ${text}` : text);

    switch (toolName) {
      case 'slack_send_message': {
        const channel = requireString(p, 'channel');
        const text = requireString(p, 'text');
        const blocks = optionalArray(p, 'blocks');
        const res = await slackApiCall<{ ok: true; channel: string; ts: string; message?: unknown }>(
          'chat.postMessage',
          botToken,
          { channel, text: say(text), ...(blocks ? { blocks } : {}) },
        );
        return {
          channel: res.channel,
          ts: res.ts,
          slackTeamId: install.slackTeamId,
        };
      }

      case 'slack_reply_in_thread': {
        const channel = requireString(p, 'channel');
        const thread_ts = requireString(p, 'thread_ts');
        const text = requireString(p, 'text');
        const blocks = optionalArray(p, 'blocks');
        const res = await slackApiCall<{ ok: true; channel: string; ts: string }>(
          'chat.postMessage',
          botToken,
          { channel, thread_ts, text: say(text), ...(blocks ? { blocks } : {}) },
        );
        return {
          channel: res.channel,
          ts: res.ts,
          thread_ts,
          slackTeamId: install.slackTeamId,
        };
      }

      case 'slack_update_message': {
        const channel = requireString(p, 'channel');
        const ts = requireString(p, 'ts');
        const text = requireString(p, 'text');
        const blocks = optionalArray(p, 'blocks');
        const res = await slackApiCall<{ ok: true; channel: string; ts: string }>(
          'chat.update',
          botToken,
          // An edit keeps the same speaker prefix the original was posted with.
          { channel, ts, text: say(text), ...(blocks ? { blocks } : {}) },
        );
        return { channel: res.channel, ts: res.ts };
      }

      case 'slack_delete_message': {
        const channel = requireString(p, 'channel');
        const ts = requireString(p, 'ts');
        await slackApiCall('chat.delete', botToken, { channel, ts });
        return { deleted: true, channel, ts };
      }

      case 'slack_add_reaction': {
        const channel = requireString(p, 'channel');
        const ts = requireString(p, 'ts');
        const emoji = requireString(p, 'emoji').replace(/^:|:$/g, '');
        await slackApiCall('reactions.add', botToken, {
          channel,
          timestamp: ts,
          name: emoji,
        });
        return { reacted: true, channel, ts, emoji };
      }

      case 'slack_list_channels': {
        const types =
          typeof p.types === 'string'
            ? p.types
            : 'public_channel,private_channel';
        const limit = Math.min(200, Math.max(1, Number(p.limit ?? 100)));
        const body: Record<string, unknown> = {
          types,
          limit,
          exclude_archived: true,
        };
        if (typeof p.cursor === 'string') body.cursor = p.cursor;
        const res = await slackApiCall<{
          ok: true;
          channels: Array<{ id: string; name: string; is_member?: boolean; is_archived?: boolean }>;
          response_metadata?: { next_cursor?: string };
        }>('conversations.list', botToken, body);
        return {
          channels: res.channels.map((c) => ({
            id: c.id,
            name: c.name,
            is_member: c.is_member ?? null,
          })),
          next_cursor: res.response_metadata?.next_cursor ?? null,
          slackTeamId: install.slackTeamId,
        };
      }

      case 'slack_resolve_channel_by_name': {
        const target = requireString(p, 'name').replace(/^#/, '').toLowerCase();
        let cursor: string | undefined;
        for (let pages = 0; pages < 10; pages++) {
          const body: Record<string, unknown> = {
            types: 'public_channel,private_channel',
            limit: 200,
            exclude_archived: true,
          };
          if (cursor) body.cursor = cursor;
          const res = await slackApiCall<{
            ok: true;
            channels: Array<{ id: string; name: string }>;
            response_metadata?: { next_cursor?: string };
          }>('conversations.list', botToken, body);
          const hit = res.channels.find((c) => c.name.toLowerCase() === target);
          if (hit) {
            return { channel_id: hit.id, name: hit.name, slackTeamId: install.slackTeamId };
          }
          cursor = res.response_metadata?.next_cursor;
          if (!cursor) break;
        }
        return { channel_id: null, name: target, slackTeamId: install.slackTeamId };
      }

      case 'slack_get_thread': {
        const channel = requireString(p, 'channel');
        const thread_ts = requireString(p, 'thread_ts');
        const limit = Math.min(200, Math.max(1, Number(p.limit ?? 50)));
        const res = await slackApiCall<{
          ok: true;
          messages: Array<Record<string, unknown>>;
          has_more?: boolean;
        }>('conversations.replies', botToken, { channel, ts: thread_ts, limit });
        return {
          messages: res.messages,
          has_more: res.has_more ?? false,
        };
      }

      case 'slack_get_user_info': {
        const user_id = requireString(p, 'user_id');
        const res = await slackApiCall<{
          ok: true;
          user: { id: string; name: string; real_name?: string; profile?: Record<string, unknown> };
        }>('users.info', botToken, { user: user_id });
        return {
          id: res.user.id,
          name: res.user.name,
          real_name: res.user.real_name ?? null,
          email: (res.user.profile as { email?: string } | undefined)?.email ?? null,
        };
      }

      case 'slack_send_dm': {
        const user_id = requireString(p, 'user_id');
        const text = requireString(p, 'text');
        const blocks = optionalArray(p, 'blocks');
        // Open a DM channel — idempotent, returns the same channel for the
        // same (bot, user) pair.
        const open = await slackApiCall<{ ok: true; channel: { id: string } }>(
          'conversations.open',
          botToken,
          { users: user_id },
        );
        const post = await slackApiCall<{ ok: true; channel: string; ts: string }>(
          'chat.postMessage',
          botToken,
          {
            channel: open.channel.id,
            text: say(text),
            ...(blocks ? { blocks } : {}),
          },
        );
        return {
          channel: post.channel,
          ts: post.ts,
          slackTeamId: install.slackTeamId,
        };
      }
    }
  }

  private toExecuteResult(
    err: unknown,
    traceId: string,
    toolName: string,
  ): ExecuteResult {
    if (err instanceof SlackNotInstalledError) {
      return failure(traceId, err.message, 'slack_not_installed');
    }
    if (err instanceof SlackWorkspaceAmbiguousError) {
      return failure(traceId, err.message, 'slack_workspace_ambiguous');
    }
    if (err instanceof SlackWorkspaceNotFoundError) {
      return failure(traceId, err.message, 'slack_workspace_not_found');
    }
    if (err instanceof SlackApiError) {
      const code = `slack_api_error:${err.slackError}`;
      logger.warn(
        { toolName, slackError: err.slackError, metadata: err.metadata },
        'Per-agent Slack tool failed at Slack API',
      );
      return failure(traceId, err.message, code);
    }
    logger.error(
      { toolName, err: (err as Error).message },
      'Per-agent Slack tool failed unexpectedly',
    );
    return failure(traceId, (err as Error).message ?? 'unknown_error');
  }
}

function isAgentSlackTool(name: string): name is AgentSlackToolName {
  return (AGENT_SLACK_TOOL_NAMES as readonly string[]).includes(name);
}

function requireString(
  input: Record<string, unknown>,
  key: string,
): string {
  const v = input[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`missing_or_invalid_param:${key}`);
  }
  return v;
}

function optionalArray(
  input: Record<string, unknown>,
  key: string,
): unknown[] | null {
  const v = input[key];
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) {
    throw new Error(`invalid_param:${key}`);
  }
  return v;
}

function failure(traceId: string, message: string, code?: string): ExecuteResult {
  return {
    success: false,
    data: null,
    traceId,
    error: code ? `${code}: ${message}` : message,
  };
}

export const agentSlackHandler = new AgentSlackHandler();
