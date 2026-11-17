// MCP Server Types — Zod schemas and tool manifests
// Eight tools exposed via the /mcp endpoint. Every tool corresponds to
// something a person can see and do in the dashboard — that correspondence is
// the admission rule for this list. Every manifest carries MCP annotations so
// a host can tell a read from a write before it calls.

import { z } from 'zod';
import { MAX_ATTACHMENT_CONTENT_CHARS, MAX_MEDIA_ATTACHMENTS, attachmentsSchema } from '../chat-attachments';

export interface McpAuthContext {
  tenantId: string;
  accountId: string;
  keyId: string;
  keyType: 'claude_code' | 'collab';
}

// ── Tool input schemas ─────────────────────────────────────────────────

// Roster mode (plan v2.1): query is OPTIONAL — absent means "enumerate the
// full active roster" instead of searching.
export const FindTeammatesInput = z.object({
  query: z.string().max(200).optional().describe('Name, role, or capability to search for. Omit to list the full roster.'),
  limit: z.number().int().min(1).max(50).optional().default(10),
  // Caller attribution — propagated by the MCP envelope so getQueryEmbedding's
  // cost row carries the agent/thread/invocation that triggered the search.
  callerAgentId: z.string().optional(),
  callerThreadId: z.string().optional(),
  callerInvocationId: z.string().optional(),
});

export const SearchConnectorContentInput = z.object({
  query: z.string().max(500).describe('What to search for'),
  connectorType: z.string().optional().describe('Optional: filter to a specific connector e.g. "slack"'),
  limit: z.number().int().min(1).max(50).optional().default(10),
  agentId: z.string().uuid().optional().describe('Your agent ID for cost attribution'),
});

// Dual addressing: exactly one of the name (`agent`, or its older spelling
// `team`) or `agentId`.
//
// `team` IS DEPRECATED AND STILL ACCEPTED, and that is deliberate. This schema
// is the one part of the vocabulary rename that reaches software we do not
// ship: every connected MCP client holds a cached copy of it, and the CLI has
// written these tool names into users' own CLAUDE.md files. Renaming the
// argument outright would have made every installed client fail its next call
// with a validation error, for as long as it went without re-reading the
// schema. Only `agent` carries a description, so only `agent` is advertised to
// a model; `team` is honoured for anything already on the wire.
const dualAddressing = {
  agent: z.string().max(200).optional().describe('The agent or platform assistant to contact, by name (resolved server-side)'),
  team: z.string().max(200).optional(),
  agentId: z.string().uuid().optional().describe('The agent ID (from liftoff_find_teammates)'),
};

/** The name an address was given under, whichever spelling was used. */
export function addressName(v: { agent?: string; team?: string }): string | undefined {
  return v.agent ?? v.team;
}

function exactlyOneAddress(v: { agent?: string; team?: string; agentId?: string }): boolean {
  // Both spellings of the name count as ONE address, so sending them together
  // is not a way to smuggle two. Sending them with different values is a
  // confused caller rather than a malicious one, and `agent` wins.
  return (addressName(v) !== undefined) !== (v.agentId !== undefined);
}

export const DelegateTaskInput = z.object({
  ...dualAddressing,
  objective: z.string().max(10000).describe('The task objective'),
  context: z.record(z.string(), z.unknown()).optional().default({}),
}).refine(exactlyOneAddress, { message: 'Provide exactly one of agent or agentId' });

/** Inline media on liftoff_chat rides a JSON body, so it is capped far below
 *  the upload route's MAX_MEDIA_BYTES (20 MiB): 1.5 MiB decoded per item, four
 *  items, which keeps the whole request under the 10 MB body limit the MCP
 *  router sets. Larger media is sent from the dashboard, which uploads bytes.
 *  The base64 length is checked before anything is decoded. */
export const MAX_INLINE_MEDIA_BYTES = 1.5 * 1024 * 1024;
export const MAX_INLINE_MEDIA_BASE64_CHARS = Math.ceil(MAX_INLINE_MEDIA_BYTES * 4 / 3);

export const MediaInlineItem = z.object({
  name: z.string().min(1).max(255).describe('The file name'),
  mimeType: z.string().min(1).max(128).describe('The media type, e.g. image/png'),
  base64: z.string().min(1).max(MAX_INLINE_MEDIA_BASE64_CHARS, {
    message: `Each inline media item is at most ${MAX_INLINE_MEDIA_BYTES / (1024 * 1024)} MiB decoded; send larger files from the dashboard`,
  }).describe('The bytes, base64'),
});

export const ChatInput = z.object({
  ...dualAddressing,
  message: z.string().max(10000).describe('What to say to the team'),
  conversationId: z.string().uuid().optional().describe('Continue an existing conversation: the conversationId a prior liftoff_chat result or liftoff_list_conversations returned'),
  waitSeconds: z.number().int().min(5).max(50).optional().default(45),
  attachments: attachmentsSchema.optional().describe('Documents as uploads (kind upload: name, content excerpt, addedAt)'),
  mediaInline: z.array(MediaInlineItem).max(MAX_MEDIA_ATTACHMENTS, {
    message: `At most ${MAX_MEDIA_ATTACHMENTS} inline media items per message`,
  }).optional().describe('Pictures as base64, at most four, each at most 1.5 MiB decoded'),
}).refine(exactlyOneAddress, { message: 'Provide exactly one of agent or agentId' });

export const GetChatReplyInput = z.object({
  chatRunId: z.string().uuid().describe('The chatRunId returned by liftoff_chat'),
});

export const ListConversationsInput = z.object({
  // A FILTER, not an address: both absent means every conversation, which is
  // why this does not carry the exactly-one refinement the addressing schemas
  // do. Both spellings are accepted here for the same reason as there.
  agent: z.string().max(200).optional().describe('Only conversations with this agent or platform assistant, by name'),
  team: z.string().max(200).optional(),
  query: z.string().max(200).optional().describe('Only conversations whose title contains this text'),
  limit: z.number().int().min(1).max(50).optional().default(20),
});

// Learned Context: dashboard parity (list one agent's entries, remove one).
export const ListLearnedContextInput = z.object({
  ...dualAddressing,
  limit: z.number().int().min(1).max(100).optional().describe('Max entries per page'),
  cursor: z.string().max(500).optional().describe('Continue a previous listing from its nextCursor'),
}).refine(exactlyOneAddress, { message: 'Provide exactly one of agent or agentId' });

export const RemoveLearnedContextInput = z.object({
  ...dualAddressing,
  memoryId: z.string().uuid().describe('The Learned Context entry id, from liftoff_list_learned_context'),
}).refine(exactlyOneAddress, { message: 'Provide exactly one of agent or agentId' });

// ── Tool manifest list (returned by tools/list) ───────────────────────

// team-XOR-agentId note: the exactly-one contract is stated in the tool
// descriptions and enforced server-side (zod refine -> invalid params).
// It must NOT be expressed as a top-level oneOf in inputSchema — the
// Anthropic tools API rejects oneOf/allOf/anyOf at the schema top level,
// which 400s the client's entire model call the moment our tools are
// forwarded (e.g. by Claude Code).

export const TOOL_MANIFESTS = [
  {
    name: 'liftoff_find_teammates',
    description:
      'Find agents and teammates in your Liftoff workspace by name, role, or capability, or omit query to list the full roster. The roster also includes the three platform assistants every workspace has: Liftoff (the general assistant), the Chief AI Officer (designs and changes agents), and the Insights Manager (answers from their real Liftoff workspace data), and the workspace\'s external agents (type external_agent, chat: false): systems the teams work with, listed so you can name them, but not conversation partners; liftoff_chat refuses them and names the teams that work with them. Use this when you need a specialist, or to see who is available.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 200, description: 'Name, role, or capability to search for. Omit to list everyone.' },
        limit: { type: 'number', minimum: 1, maximum: 50, description: 'Max results (default 10; roster mode returns up to 50)' },
      },
    },
  },
  {
    name: 'liftoff_chat',
    description:
      'Chat with one of the workspace agents or platform assistants and get its reply. Provide exactly one of team (by name; the server resolves it) or agentId. The three assistants are addressed by name like any team: "Chief AI Officer" to design or change agents, "Insights Manager" for questions answered from their real Liftoff workspace data, and "Liftoff" for everything else. When the user does not name who to ask, use "Liftoff": it routes to the right colleague server-side; do not pick a specialist or a team yourself. Reuse the returned conversationId to continue the same conversation (it is also what liftoff_list_conversations returns, and the result\'s link opens that conversation in Liftoff); every result echoes the resolved team so you can attribute the reply, and a result carrying answeredBy names the colleague the assistant brought in to write it; attribute the reply to that name. If the reply is not ready within waitSeconds, you get in_progress plus a chatRunId to fetch later with liftoff_get_chat_reply. The assistants can change the workspace on the person\'s behalf (teams, reviews, connections), so a message may lead to a change; a confirmation an assistant asks for must be put to the person.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        team: { type: 'string', maxLength: 200, description: 'The team or platform assistant to contact, by name' },
        agentId: { type: 'string', format: 'uuid', description: 'The platform agent ID' },
        message: { type: 'string', maxLength: 10000, description: 'What to say to the team' },
        conversationId: { type: 'string', format: 'uuid', description: 'Continue an existing conversation: the conversationId a prior result or liftoff_list_conversations returned' },
        waitSeconds: { type: 'number', minimum: 5, maximum: 50, description: 'How long to wait for the reply (default 45)' },
        attachments: {
          type: 'array', maxItems: 8,
          description: `Documents to hand over with the message, as uploads: the file name and its text (excerpted to ${MAX_ATTACHMENT_CONTENT_CHARS} characters; put the part that matters first).`,
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['upload'] },
              name: { type: 'string', maxLength: 200 },
              content: { type: 'string', maxLength: MAX_ATTACHMENT_CONTENT_CHARS },
              addedAt: { type: 'string', format: 'date-time' },
            },
            required: ['kind', 'name', 'content', 'addedAt'],
          },
        },
        mediaInline: {
          type: 'array', maxItems: MAX_MEDIA_ATTACHMENTS,
          description: 'Pictures to hand over with the message, as base64: at most four, each at most 1.5 MiB decoded. Larger files are sent from the dashboard.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', maxLength: 255 },
              mimeType: { type: 'string', maxLength: 128, description: 'e.g. image/png, image/jpeg' },
              base64: { type: 'string', maxLength: MAX_INLINE_MEDIA_BASE64_CHARS },
            },
            required: ['name', 'mimeType', 'base64'],
          },
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'liftoff_get_chat_reply',
    description:
      'Fetch the outcome of an earlier liftoff_chat call by its chatRunId — the reply when completed, or the current status (in_progress, waiting_on_human, failed). A completed result may carry answeredBy, naming the colleague the assistant brought in to write the reply.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        chatRunId: { type: 'string', format: 'uuid', description: 'The chatRunId returned by liftoff_chat' },
      },
      required: ['chatRunId'],
    },
  },
  {
    name: 'liftoff_list_learned_context',
    description:
      'List an agent\'s Learned Context: the entries it has learned from working with the workspace, exactly as the dashboard shows them on Update Team. Provide exactly one of team (by name) or agentId. Each entry carries the id liftoff_remove_learned_context takes. Only agents keep Learned Context; the platform assistants have none.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        team: { type: 'string', maxLength: 200, description: 'The agent, by name' },
        agentId: { type: 'string', format: 'uuid', description: 'The platform agent ID' },
        limit: { type: 'number', minimum: 1, maximum: 100, description: 'Max entries per page' },
        cursor: { type: 'string', maxLength: 500, description: 'Continue a previous listing from its nextCursor' },
      },
    },
  },
  {
    name: 'liftoff_remove_learned_context',
    description:
      'Remove one entry from an agent\'s Learned Context, the same action as Remove memory on the dashboard\'s Update Team page. Provide exactly one of team (by name) or agentId, plus the entry\'s memoryId from liftoff_list_learned_context.',
    inputSchema: {
      type: 'object',
      properties: {
        team: { type: 'string', maxLength: 200, description: 'The agent, by name' },
        agentId: { type: 'string', format: 'uuid', description: 'The platform agent ID' },
        memoryId: { type: 'string', format: 'uuid', description: 'The Learned Context entry id to remove' },
      },
      required: ['memoryId'],
    },
  },
  {
    name: 'liftoff_delegate_task',
    description:
      'Hand off a task to a platform agent for asynchronous execution. Provide exactly one of team (by name) or agentId. The task runs in the background — use liftoff_chat instead when you want the reply in this conversation. The platform assistants (Liftoff, Chief AI Officer, Insights Manager) take no background tasks; talk to them with liftoff_chat.',
    inputSchema: {
      type: 'object',
      properties: {
        team: { type: 'string', maxLength: 200, description: 'The team to delegate to, by name' },
        agentId: { type: 'string', format: 'uuid', description: 'The platform agent ID to delegate to' },
        objective: { type: 'string', maxLength: 10000, description: 'The task objective' },
        context: { type: 'object', description: 'Optional context' },
      },
      required: ['objective'],
    },
  },
  {
    name: 'liftoff_search_connector_content',
    description:
      'Search documents, messages, and records that have been fetched from your connected apps (Slack messages, Confluence pages, Notion docs, CRM records, etc.). Use this when you need to look up specific content from a connected tool. If this returns no results or thin results, use the relevant connector tool to fetch the specific resource you need directly, then search again — fetching it will make it available for future searches. NOT for general team knowledge or agent learnings — use liftoff_read_context for those. Pass your agent ID in agentId for cost attribution.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' },
        connectorType: { type: 'string', description: 'Optional: filter to a specific connector e.g. "slack"' },
        limit: { type: 'number', description: 'Max results to return (default 10, max 50)' },
        agentId: { type: 'string', format: 'uuid', description: 'Your agent ID for cost attribution' },
      },
      required: ['query'],
    },
  },
  {
    name: 'liftoff_list_conversations',
    description:
      'List the conversations in this Liftoff workspace, newest first, with the agents and the three platform assistants alike, including ones started on the Liftoff dashboard. Each row carries the conversationId to continue it with liftoff_chat, a link that opens it in Liftoff, its title, when it was last active, and whether it is waiting on a person. Filter with team (a team or assistant name) and query (title text). Use this to find and continue an earlier conversation instead of starting a new one.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        team: { type: 'string', maxLength: 200, description: 'Only conversations with this team or platform assistant, by name' },
        query: { type: 'string', maxLength: 200, description: 'Only conversations whose title contains this text' },
        limit: { type: 'number', minimum: 1, maximum: 50, description: 'Max conversations (default 20)' },
      },
    },
  },
  {
    name: 'liftoff_get_settings',
    description:
      'Read the workspace\'s AI provider and this person\'s notification settings: which of the AI providers the workspace runs on (with the valid options), which notifications they receive, how often, and whether email delivery is on. Read this before changing anything, so you can show them what it is now and use the exact provider names rather than guessing. Browser notification delivery is reported but cannot be changed from here.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'liftoff_set_ai_provider',
    description:
      'Change which AI provider the workspace runs on, or override it for one agent. Use the exact provider name from liftoff_get_settings; "default" is Liftoff Managed. Pass agentId to change one agent instead of the whole workspace — and setting an agent to the workspace\'s own provider makes it follow the workspace again rather than pinning it. PREVIEW FIRST: call without confirmationId to get the before/after and a handle, put that to the person, and call again with the handle only once they agree. A vendor\'s own API key is entered on the Liftoff settings page, never through a tool.',
    inputSchema: {
      type: 'object',
      properties: {
        vendor: { type: 'string', maxLength: 50, description: 'The provider name, from liftoff_get_settings; "default" is Liftoff Managed' },
        agentId: { type: 'string', format: 'uuid', description: 'Change this agent only, instead of the workspace default' },
        confirmationId: { type: 'string', maxLength: 200, description: 'The handle the preview returned; send it only after the person agrees' },
      },
      required: ['vendor'],
    },
  },
  {
    name: 'liftoff_set_communication_settings',
    description:
      'Change this person\'s own settings on the Communication tab of Liftoff settings: which notifications they receive (taskUpdates, teamActivity, escalations, weeklyDigest), how often (realtime, daily, weekly, none), whether email delivery is on, and whether they are subscribed to the Liftoff Newsletter. Send only what changes. The newsletter is a mailing list rather than a delivery channel, so turning every notification off leaves it subscribed and it is unsubscribed on its own. Browser notification delivery cannot be set here — it needs a push subscription and the operating system\'s permission, which only a browser can obtain — and is left exactly as it is.',
    inputSchema: {
      type: 'object',
      properties: {
        notificationTypes: {
          type: 'object',
          description: 'The types to change, as booleans. Only the ones you send change.',
          properties: {
            taskUpdates: { type: 'boolean' },
            teamActivity: { type: 'boolean' },
            escalations: { type: 'boolean' },
            weeklyDigest: { type: 'boolean' },
          },
        },
        notificationFrequency: { type: 'string', enum: ['realtime', 'daily', 'weekly', 'none'] },
        emailDelivery: { type: 'boolean', description: 'Whether notifications are emailed' },
        newsletter: { type: 'boolean', description: 'Whether they are subscribed to the Liftoff Newsletter' },
      },
    },
  },
  {
    name: 'liftoff_get_ai_provider_keys',
    description:
      'Read whether the workspace uses its own AI provider keys (Anthropic, Google, OpenAI, xAI) and what is paying for its calls: for each provider, whether a key is stored, a redacted hint of it, when it was last verified, and whether a rejected key has put calls back on Liftoff Managed. Owner or admin only. Use it when someone asks about their own provider keys or their AI spend. The result carries the link to the page where a key is added or replaced: hand that link over, and NEVER ask for a key or accept one in a message, because doing so would put the secret into this conversation and its logs.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {} },
  },
] as const;
