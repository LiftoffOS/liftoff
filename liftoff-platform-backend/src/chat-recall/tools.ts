// The recall tools a model is offered wherever it holds a conversation with a
// person: what was said earlier in THIS conversation, and what was said in the
// other ones.
//
// One dispatcher serves the in-process assistants and the internal route the
// Tenant Runtime calls, so every surface reads the same words and gets the same
// bounds — the shape src/datasets/tools.ts established for the same reason.
//
// THE DESCRIPTIONS ARE PART OF THE CONTRACT, not documentation of it. A recall
// tool is reached for only when its description names the case a person's words
// actually produce — "the spec I gave you earlier", "as I said above" — rather
// than the capability in the abstract ("search past conversations"). A tool a
// model never reaches for is worth what an unwired one is.
//
// AND THE TWO MUST DISTINGUISH THEMSELVES FROM EACH OTHER. They answer different
// questions and a model chooses between them on the descriptions alone. Recall
// returns excerpts and at most one hit per conversation, so aimed at "what did I
// say earlier here" it returns a fragment and the rest reads as though it was
// never said; the thread read returns whole messages but only from this
// conversation. Each names the other and says why.

import type { LLMToolDefinition } from '../llm/types';
import { log } from '../infrastructure/logging';
import { readThreadHistory } from './read-thread-history';
import { recallConversations } from './recall-conversations';
import type { ChatSurface } from './surfaces';

export const READ_CONVERSATION_HISTORY_TOOL = 'read_conversation_history';
export const RECALL_CONVERSATIONS_TOOL = 'recall_conversations';

export const CHAT_RECALL_TOOL_NAMES = [
  READ_CONVERSATION_HISTORY_TOOL,
  RECALL_CONVERSATIONS_TOOL,
] as const;
export type ChatRecallToolName = (typeof CHAT_RECALL_TOOL_NAMES)[number];

export function isChatRecallTool(name: string): name is ChatRecallToolName {
  return (CHAT_RECALL_TOOL_NAMES as readonly string[]).includes(name);
}

const readConversationHistoryTool: LLMToolDefinition = {
  name: READ_CONVERSATION_HISTORY_TOOL,
  description:
    'Read what was said earlier in THIS conversation, further back than the messages you can currently see. '
    + 'Only the most recent messages are shown to you; everything older reaches you as a short summary that drops detail. '
    + 'Use this whenever the person refers to something from earlier that you cannot see in full — "the spec I sent", '
    + '"as I said above", "the figures from before", a decision already taken, a name or a link already given — instead of '
    + 'asking them to repeat it. Set match to find the exact message rather than paging: a filtered read reaches much '
    + 'further back. The result says whether older messages remain and how to continue. For something settled in a '
    + 'DIFFERENT conversation, use recall_conversations instead.',
  input_schema: {
    type: 'object',
    properties: {
      match: {
        type: 'string',
        description: 'Only messages containing this text, case-insensitive. The most efficient way to find one fact.',
      },
      limit: {
        type: 'integer',
        description: 'Messages to return, 1-100 (default 30).',
      },
      before: {
        type: 'string',
        description: 'Read messages older than this timestamp; pass the previous result\'s before value to continue further back.',
      },
    },
  },
};

const recallConversationsTool: LLMToolDefinition = {
  name: RECALL_CONVERSATIONS_TOOL,
  description:
    'Search OTHER conversations you have had with this person. Use when they refer to something settled somewhere '
    + 'else and not in this conversation — "last time", "as we agreed", a decision or a figure from a previous '
    + 'session. Omit query to list the most recent ones. This returns short excerpts and at most one hit per '
    + 'conversation, so for something said EARLIER IN THIS CONVERSATION use read_conversation_history instead: that '
    + 'reads this conversation in full.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Words to search for; omit for the most recent conversations.',
      },
      limit: {
        type: 'integer',
        description: 'Conversations to return, 1-10 (default 5).',
      },
    },
  },
};

export const chatRecallTools: LLMToolDefinition[] = [
  readConversationHistoryTool,
  recallConversationsTool,
];

export interface ChatRecallToolContext {
  /** Which surface's conversation this is. */
  surface: ChatSurface;
  /** The conversation the model is in. Supplied by the calling service from its
   *  own turn context, NEVER read from the model's arguments: a thread id in a
   *  tool argument would let a model name a conversation it is not in. */
  threadId: string;
  /** The person asking, for cross-thread recall. Same rule as threadId: it comes
   *  from the authenticated turn, never from the model. Absent means recall is
   *  not offered — there is nobody to scope it to. */
  accountId?: string;
  /** The executing turn, excluded so a search does not return the question that
   *  asked it. */
  turnId?: string;
}

/** Run one recall tool and return the text the model reads. Never throws: a
 *  failure is answered in words, because a model handed an exception says
 *  something invented to the person instead. */
export async function runChatRecallTool(
  tenantId: string,
  name: ChatRecallToolName,
  input: Record<string, unknown>,
  ctx: ChatRecallToolContext,
): Promise<string> {
  try {
    switch (name) {
      case READ_CONVERSATION_HISTORY_TOOL:
        return await readThreadHistory(
          { tenantId, surface: ctx.surface, threadId: ctx.threadId },
          {
            ...(typeof input.before === 'string' ? { before: input.before } : {}),
            ...(typeof input.match === 'string' ? { match: input.match } : {}),
            ...(input.limit !== undefined ? { limit: Number(input.limit) } : {}),
          },
        );
      case RECALL_CONVERSATIONS_TOOL: {
        // Team chat reaches its own recall through the Tenant Runtime's gateway
        // tool, against agent_chat_turns and scoped to the responding agent.
        // Answering it here would search the wrong tables.
        if (ctx.surface === 'team') {
          return 'Searching other conversations is not available on this surface.';
        }
        if (!ctx.accountId) {
          return 'Searching other conversations needs to know who is asking, and this turn does not carry it.';
        }
        return await recallConversations(
          {
            surface: ctx.surface,
            tenantId,
            accountId: ctx.accountId,
            ...(ctx.turnId ? { excludeTurnId: ctx.turnId } : {}),
          },
          {
            ...(typeof input.query === 'string' ? { query: input.query } : {}),
            ...(input.limit !== undefined ? { limit: Number(input.limit) } : {}),
          },
        );
      }
    }
  } catch (err) {
    log.warn(
      { tenantId, tool: name, surface: ctx.surface, err: (err as Error).message },
      'chat recall tool failed',
    );
    return 'That could not be read right now. Say plainly that the earlier part of the conversation could not be reached.';
  }
  return 'Unknown recall tool.';
}
