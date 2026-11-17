// The four chat surfaces, as one registry.
//
// Liftoff, the Insights Manager and an agent's chat each keep their speech in
// their own pair of tables, with their own speaker rules: who a row is
// attributed to, and which rows are speech at all. The Chief AI Officer keeps
// its own in workforce-service's database — same Cloud SQL instance, different
// database — so it is named here for completeness and served there, never from
// this process.
//
// WHY A REGISTRY rather than per-reader rules. Three readers need all three
// surfaces: the source-conversation route, the thread-history tool and the
// recall search. The speaker rules are the part that drifts when restated —
// whether a typed row is status or speech is a per-surface judgement (a
// `colleague` row IS speech, under the colleague's label; `hitl_status` is
// not), and a reader that disagrees produces an answer no row explains.
//
// THE THREAD IS RESOLVED BEFORE ANYTHING IS READ, always. `liftoff_chat_messages`
// and `insights_chat_messages` carry no `tenant_id` — they are scoped through
// their thread — so `resolveThread` is not a convenience, it is the tenancy
// check. Each surface's `getThread` runs under `withTenantScope` and re-checks
// the row's tenant, so a thread in another tenant reads as absent.
//
// TABLE NAMES ARE CONSTANTS HERE and never reach a query from tool input. The
// recall search interpolates them into SQL (a table cannot be a bind
// parameter), which is only safe because the set is closed and written out.

import {
  getThread as getLiftoffThread,
  listMessages as listLiftoffMessages,
  type LiftoffChatMessage,
} from '../liftoff/chat-repository';
import {
  getThread as getInsightsThread,
  listMessages as listInsightsMessages,
  type InsightsChatMessage,
} from '../insights/chat-repository';
import {
  getThread as getAgentThread,
  listMessages as listAgentMessages,
  type AgentChatMessage,
} from '../agent-chat/chat-repository';
import { internalAgentService } from '../internal-agents/service';
import { teamDisplayName } from '../workspace-actions/teams';
import { collectTranscript, type CollectOptions, type Transcript } from './transcript';

/** The surfaces this process can read. The Chief AI Officer's `caio` is
 *  deliberately absent: its thread store is another database, and a lookup here
 *  would answer "no such thread" for every real one. */
export const CHAT_SURFACES = ['liftoff', 'insights', 'team'] as const;
export type ChatSurface = (typeof CHAT_SURFACES)[number];

/** How a surface names itself to a model reading its own transcript. */
const COUNTERPART: Record<ChatSurface, string> = {
  liftoff: 'Liftoff',
  insights: 'the Insights Manager',
  team: 'this agent',
};

/** Where a surface's rows live. Used by the recall search, which cannot bind a
 *  table name as a parameter. Every value is a literal in this file. */
export interface SurfaceTables {
  readonly threads: string;
  readonly messages: string;
  readonly turns: string;
}

const TABLES: Record<ChatSurface, SurfaceTables> = {
  liftoff: { threads: 'liftoff_chat_threads', messages: 'liftoff_chat_messages', turns: 'liftoff_chat_turns' },
  insights: { threads: 'insights_chat_threads', messages: 'insights_chat_messages', turns: 'insights_chat_turns' },
  team: { threads: 'agent_chat_threads', messages: 'agent_chat_messages', turns: 'agent_chat_turns' },
};

// ── Speakers, per surface ─────────────────────────────────────────────────

function personName(first: string | null, last: string | null): string {
  return [first, last].filter((s): s is string => !!s && s.trim().length > 0).join(' ').trim();
}

/** Who said it, as the person saw it: their own rows, Liftoff's, or a
 *  colleague's stored label (stored so a later rename does not relabel a reply
 *  already read — the same rule the frontend follows). */
function liftoffSpeaker(message: LiftoffChatMessage): string | null {
  if (message.messageType !== null) return null;
  if (message.role === 'user') return 'Person';
  return message.authorLabel ?? 'Liftoff';
}

/** The person by the 492 sender (else "Workspace member"), the Insights
 *  Manager, or a colleague row's contributor label (493). */
function insightsSpeaker(message: InsightsChatMessage): string | null {
  if (message.messageType !== null && message.messageType !== 'colleague') return null;
  if (message.role === 'user') {
    const name = message.sender ? personName(message.sender.firstName, message.sender.lastName) : '';
    return name || 'Workspace member';
  }
  if (message.messageType === 'colleague') {
    return message.contributors[0]?.label ?? 'Colleague';
  }
  return 'Insights Manager';
}

/** The team chat's speakers: a person by `sender` (first and last name, else
 *  the existing `senderLabel`, else "A member of the workspace"); an ordinary
 *  assistant row by resolving its `agentId`; a `colleague` row by its
 *  contributor label (493). Rows with any other `message_type` are status.
 *
 *  Resolution is asynchronous and memoised per call, because one name lookup
 *  per message on a 200-message page is the whole cost of reading a thread. */
function agentSpeakerResolver(tenantId: string): (message: AgentChatMessage) => Promise<string | null> {
  const names = new Map<string, Promise<string>>();
  const nameOf = (agentId: string): Promise<string> => {
    let pending = names.get(agentId);
    if (!pending) {
      pending = internalAgentService.getById(agentId, tenantId)
        .then((agent) => (agent ? teamDisplayName(agent) : 'agent'))
        .catch(() => 'agent');
      names.set(agentId, pending);
    }
    return pending;
  };
  return async (message) => {
    if (message.role === 'user') {
      if (message.messageType !== null) return null;
      const name = message.sender ? personName(message.sender.firstName, message.sender.lastName) : '';
      return name || message.senderLabel || 'A member of the workspace';
    }
    if (message.messageType === 'colleague') {
      return message.contributors[0]?.label ?? 'Colleague';
    }
    if (message.messageType !== null) return null;
    if (message.role !== 'assistant') return null;
    return message.agentId ? nameOf(message.agentId) : 'agent';
  };
}

// ── Attachments, per surface ──────────────────────────────────────────────

/** The chip text the composer showed: the file's name, with the connector type
 *  for a reference ("Q3 plan (google_drive)"). Names only — contents were never
 *  stored (the attachments column is metadata by design). */
function liftoffAttachmentNames(message: LiftoffChatMessage): string[] {
  return message.attachments.map((attachment) =>
    attachment.kind === 'connector'
      ? `${attachment.name} (${attachment.connectorType})`
      : attachment.name,
  );
}

function genericAttachmentNames(attachments: unknown[] | null | undefined): string[] {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .map((a) => (typeof a === 'object' && a !== null ? (a as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
}

// ── The registry ──────────────────────────────────────────────────────────

/** chat-repository's MAX_MESSAGE_LIMIT on every surface — ask for full pages. */
const PAGE_SIZE = 200;

export interface SurfaceReader {
  readonly surface: ChatSurface;
  /** What the surface calls its assistant side, for a rendered header. */
  readonly counterpart: string;
  readonly tables: SurfaceTables;
  /** The thread under this tenant, or null when it is absent, deleted or
   *  another tenant's. ALWAYS call this before reading messages. */
  resolveThread(tenantId: string, threadId: string): Promise<{ id: string } | null>;
  /** This thread's speech, bounded by `options`. */
  collect(tenantId: string, threadId: string, options: CollectOptions): Promise<Transcript>;
}

const READERS: Record<ChatSurface, SurfaceReader> = {
  liftoff: {
    surface: 'liftoff',
    counterpart: COUNTERPART.liftoff,
    tables: TABLES.liftoff,
    resolveThread: (tenantId, threadId) => getLiftoffThread(threadId, tenantId),
    collect: (tenantId, threadId, options) => collectTranscript(
      (cursor) => listLiftoffMessages(threadId, { limit: PAGE_SIZE, cursor }),
      liftoffSpeaker,
      liftoffAttachmentNames,
      options,
    ),
  },
  insights: {
    surface: 'insights',
    counterpart: COUNTERPART.insights,
    tables: TABLES.insights,
    resolveThread: (tenantId, threadId) => getInsightsThread(threadId, tenantId),
    collect: (tenantId, threadId, options) => collectTranscript(
      (cursor) => listInsightsMessages(threadId, { limit: PAGE_SIZE, cursor }),
      insightsSpeaker,
      (message) => genericAttachmentNames(message.attachments as unknown[]),
      options,
    ),
  },
  team: {
    surface: 'team',
    counterpart: COUNTERPART.team,
    tables: TABLES.team,
    resolveThread: (tenantId, threadId) => getAgentThread(threadId, tenantId),
    collect: (tenantId, threadId, options) => collectTranscript(
      (cursor) => listAgentMessages(threadId, tenantId, { limit: PAGE_SIZE, cursor }),
      agentSpeakerResolver(tenantId),
      (message) => genericAttachmentNames(message.attachments),
      options,
    ),
  },
};

export function surfaceReader(surface: ChatSurface): SurfaceReader {
  return READERS[surface];
}
