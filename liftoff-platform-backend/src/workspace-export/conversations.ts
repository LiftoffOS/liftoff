// The four conversation surfaces, and the one transcript projection.
//
// Team chat, Liftoff and the Insights Manager are read here through the
// export's own queries; the Chief AI Officer's threads live in the workforce
// service's database and arrive through its two export feeds. Each surface
// yields the same intermediate shape, messages are grouped by thread in
// memory, and `toTranscript` is the single rule that decides what a row
// becomes in conversations.json: speech stays, a produced file becomes a
// Files line, everything else (tool rows, status rows, suggestions, learning
// confirmations, forwarded context, tool trails, visualization blocks,
// citations, token counts) is dropped.
//
// Who else had a hand in a reply is carried the way the pages carry it: a
// reply written by a colleague names that colleague as `From` (Liftoff's
// hand-overs, and a `colleague` row a platform assistant posted into a team's
// chat), and a reply the team wrote with teammates' help names them under
// `With help from`. The author is always `From`; nobody is listed twice.

import { walkRemote, type ExportBudget } from './budget';
import {
  readTeamChatThreads,
  readTeamChatMessages,
  readLiftoffThreads,
  readLiftoffMessages,
  readInsightsThreads,
  readInsightsMessages,
  type TeamChatMessageRow,
  type AssistantMessageRow,
} from './queries';
import {
  exportTeamPlanThreads,
  exportTeamPlanMessages,
  type WorkforceCaller,
  type TeamPlanExportThread,
  type TeamPlanExportMessage,
} from '../workforce-plans/team-plan-thread-client';
import {
  CONVERSATION_KEYS as K,
  SURFACE_LABELS,
  CHANNEL_LABELS,
  UNTITLED_CHAT,
  WORKSPACE_MEMBER,
  UNKNOWN_AI_TEAM,
} from './labels';
import { COLLEAGUE_MESSAGE_TYPE } from '../agent-chat/colleague-message-type';
import type { Contributor } from '../chat-attachments';

/** The stored Contributor[] as the export trusts it: only entries with both
 *  strings, in the order stored. Rows written before migration 493 read as
 *  the empty list. */
export function contributorsOf(raw: unknown): Contributor[] {
  if (!Array.isArray(raw)) return [];
  const out: Contributor[] = [];
  for (const entry of raw) {
    const c = entry as { id?: unknown; label?: unknown } | null;
    if (c && typeof c.id === 'string' && typeof c.label === 'string' && c.label) {
      out.push({ id: c.id, label: c.label });
    }
  }
  return out;
}

export type Surface = keyof typeof SURFACE_LABELS;

/** Who wrote a row, before names are resolved. */
export type Speaker =
  | { kind: 'account'; accountId: string | null; label: string | null }
  | { kind: 'team'; agentId: string | null }
  | { kind: 'named'; name: string };

export interface CollectedMessage {
  role: string;
  content: string;
  messageType: string | null;
  attachments: unknown;
  media: unknown;
  createdAt: Date;
  speaker: Speaker;
  /** Colleagues who had a hand in the row WITHOUT writing it, by name: the
   *  teammates a team delegated part of the reply to. Empty on every row
   *  whose author is the only colleague on it, which is every user row, every
   *  Liftoff hand-over and every `colleague` row. */
  withHelpFrom: string[];
  /** A reply's own turn; null on every other row and on surfaces without one. */
  turnId: string | null;
  /** A file card's producing turn (team chat, migration 474); null elsewhere. */
  producedInTurnId: string | null;
}

export interface CollectedConversation {
  /** The thread's own id; a join key for produced files, never serialized. */
  id: string;
  surface: Surface;
  channel: string | null;
  title: string | null;
  startedByAccountId: string | null;
  createdAt: Date;
  messages: CollectedMessage[];
}

/** Every conversation on every surface, oldest first, then by id. */
export interface CollectedConversations {
  conversations: CollectedConversation[];
}

// ── Collectors ──────────────────────────────────────────────────────────

function groupByThread<M extends { thread_id: string }>(messages: M[]): Map<string, M[]> {
  const byThread = new Map<string, M[]>();
  for (const m of messages) {
    const list = byThread.get(m.thread_id);
    if (list) list.push(m);
    else byThread.set(m.thread_id, [m]);
  }
  return byThread;
}

export async function collectTeamChat(
  tenantId: string, asOf: Date, budget: ExportBudget,
): Promise<CollectedConversation[]> {
  const threads = await readTeamChatThreads(tenantId, asOf, budget);
  const byThread = groupByThread(await readTeamChatMessages(tenantId, asOf, budget));
  return threads.map((t) => ({
    id: t.id,
    surface: 'agent_chat',
    channel: t.channel,
    title: t.title,
    startedByAccountId: t.account_id,
    createdAt: t.created_at,
    messages: (byThread.get(t.id) ?? []).map((m: TeamChatMessageRow): CollectedMessage => {
      const contributors = contributorsOf(m.contributors);
      // A `colleague` row is a platform assistant speaking in the team's
      // chat: its one contributor wrote every word, so it is the author. A
      // team's own reply names its helpers instead.
      const colleagueAuthor = m.role === 'assistant' && m.message_type === COLLEAGUE_MESSAGE_TYPE
        ? contributors[0] ?? null
        : null;
      return {
        role: m.role,
        content: m.content,
        messageType: m.message_type,
        attachments: m.attachments,
        media: m.media,
        createdAt: m.created_at,
        speaker: m.role === 'user'
          ? { kind: 'account', accountId: m.sender_account_id, label: m.sender_label }
          : colleagueAuthor
            ? { kind: 'named', name: colleagueAuthor.label }
            : { kind: 'team', agentId: m.agent_id },
        withHelpFrom: colleagueAuthor || m.role !== 'assistant' ? [] : contributors.map((c) => c.label),
        turnId: m.turn_id,
        producedInTurnId: m.produced_in_turn_id,
      };
    }),
  }));
}

function assistantCollector(
  surface: 'liftoff' | 'insights',
  readThreads: typeof readLiftoffThreads,
  readMessages: typeof readLiftoffMessages,
) {
  return async (tenantId: string, asOf: Date, budget: ExportBudget): Promise<CollectedConversation[]> => {
    const threads = await readThreads(tenantId, asOf, budget);
    const byThread = groupByThread(await readMessages(tenantId, asOf, budget));
    return threads.map((t) => ({
      id: t.id,
      surface,
      channel: null,
      title: t.title,
      startedByAccountId: t.account_id,
      createdAt: t.created_at,
      messages: (byThread.get(t.id) ?? []).map((m: AssistantMessageRow): CollectedMessage => {
        const contributors = contributorsOf(m.contributors);
        // A `colleague` row is a colleague the Insights Manager brought in
        // speaking in its conversation: its one contributor wrote every word,
        // so it is the author, exactly as in a team's chat.
        const colleagueAuthor = m.role === 'assistant' && m.message_type === COLLEAGUE_MESSAGE_TYPE
          ? contributors[0] ?? null
          : null;
        return {
          role: m.role,
          content: m.content,
          messageType: m.message_type,
          attachments: m.attachments,
          media: m.media,
          createdAt: m.created_at,
          speaker: m.role === 'user'
            ? { kind: 'account', accountId: m.sender_account_id, label: null }
            // Liftoff: a colleague's reply names its author; an unnamed reply is
            // Liftoff itself. The Insights Manager's colleague is on the row's
            // type and contributors.
            : { kind: 'named', name: m.author_label ?? colleagueAuthor?.label ?? SURFACE_LABELS[surface] },
          // Liftoff's author is the whole of its attribution, and so is a
          // colleague row's; any other contributors helped the assistant answer.
          withHelpFrom: m.role === 'assistant' && !m.author_label && !colleagueAuthor
            ? contributors.map((c) => c.label)
            : [],
          turnId: null,
          producedInTurnId: null,
        };
      }),
    }));
  };
}

export const collectLiftoff = assistantCollector('liftoff', readLiftoffThreads, readLiftoffMessages);
export const collectInsights = assistantCollector('insights', readInsightsThreads, readInsightsMessages);

export async function collectChiefAiOfficer(
  caller: WorkforceCaller, asOf: Date, budget: ExportBudget,
): Promise<CollectedConversation[]> {
  const threads = await walkRemote<TeamPlanExportThread>('workforce', budget, (cursor, limit) =>
    exportTeamPlanThreads(caller, { asOf, cursor, limit }));
  const messages = await walkRemote<TeamPlanExportMessage>('workforce', budget, (cursor, limit) =>
    exportTeamPlanMessages(caller, { asOf, cursor, limit }));
  const byThread = new Map<string, TeamPlanExportMessage[]>();
  for (const m of messages) {
    const list = byThread.get(m.threadId);
    if (list) list.push(m);
    else byThread.set(m.threadId, [m]);
  }
  return threads.map((t) => ({
    id: t.id,
    surface: 'caio',
    channel: null,
    title: t.title,
    startedByAccountId: t.accountId,
    createdAt: new Date(t.createdAt),
    messages: (byThread.get(t.id) ?? []).map((m): CollectedMessage => {
      const contributors = contributorsOf(m.contributors);
      // Same rule as the other surfaces: a `colleague` row is the colleague
      // the Chief AI Officer brought in, speaking in its conversation.
      const colleagueAuthor = m.role === 'assistant' && m.messageType === COLLEAGUE_MESSAGE_TYPE
        ? contributors[0] ?? null
        : null;
      return {
        role: m.role,
        content: m.content,
        messageType: m.messageType,
        attachments: m.attachments,
        media: m.media,
        createdAt: new Date(m.createdAt),
        speaker: m.role === 'user'
          ? { kind: 'account', accountId: m.senderAccountId, label: null }
          : { kind: 'named', name: colleagueAuthor?.label ?? SURFACE_LABELS.caio },
        withHelpFrom: m.role === 'assistant' && !colleagueAuthor ? contributors.map((c) => c.label) : [],
        turnId: null,
        producedInTurnId: null,
      };
    }),
  }));
}

// ── The transcript rule ─────────────────────────────────────────────────

/** A produced file, as the transcript points at it. */
export type FileEntry =
  | { [K.name]: string; [K.path]: string }
  | { [K.name]: string; [K.link]: string }
  | { [K.name]: string };

/** What a transcript row references: the stored object's id, the name the
 *  card shows, and the link the card itself carries. A document a team wrote
 *  through a connector (a Google Doc it edited in the person's Drive) has no
 *  stored object here at all: the card is the whole record, and its link is
 *  what the chat page renders (agent-chat/file-cards.ts). */
export interface FileReference {
  fileId: string;
  filename: string;
  webViewUrl: string | null;
}

/** Turns a reference into its archive entry: a Path into files/, a Link for
 *  a connector-native document, or the Name alone when the object is gone. */
export type FileResolver = (ref: FileReference) => FileEntry;

export interface TranscriptRow {
  role: string;
  content: string;
  messageType: string | null;
  attachments: unknown;
  media: unknown;
  createdAt: Date;
  /** The row's author, already resolved to what the person recognises. */
  from: string;
  /** Who helped the author write it, by name; empty when nobody did. */
  withHelpFrom: string[];
  turnId: string | null;
  producedInTurnId: string | null;
}

export interface TranscriptEntry {
  [K.from]: string;
  [K.withHelpFrom]?: string[];
  [K.sent]: string;
  [K.message]?: string;
  [K.attachments]?: string[];
  [K.files]?: FileEntry[];
}

/** The message types that carry a produced file rather than speech. */
const FILE_OUTPUT_MESSAGE_TYPE = 'file_output';
const MEDIA_MESSAGE_TYPE = 'media';

function fileOutputReferences(attachments: unknown): FileReference[] {
  if (!Array.isArray(attachments)) return [];
  const refs: FileReference[] = [];
  for (const raw of attachments) {
    const a = raw as { generatedFileId?: unknown; filename?: unknown; webViewUrl?: unknown } | null;
    if (a && typeof a.generatedFileId === 'string' && typeof a.filename === 'string') {
      refs.push({
        fileId: a.generatedFileId,
        filename: a.filename,
        webViewUrl: typeof a.webViewUrl === 'string' && a.webViewUrl.length > 0 ? a.webViewUrl : null,
      });
    }
  }
  return refs;
}

function mediaReferences(media: unknown): FileReference[] {
  if (!Array.isArray(media)) return [];
  const refs: FileReference[] = [];
  for (const raw of media) {
    const m = raw as { mediaId?: unknown; filename?: unknown } | null;
    if (m && typeof m.mediaId === 'string' && typeof m.filename === 'string') {
      refs.push({ fileId: m.mediaId, filename: m.filename, webViewUrl: null });
    }
  }
  return refs;
}

/** The names of what a person attached: uploads and connector references by
 *  name, and the pictures they sent by filename. Names only; the person holds
 *  the originals and inbound uploads are retained for a limited time. */
function attachmentNames(attachments: unknown, media: unknown): string[] {
  const names: string[] = [];
  if (Array.isArray(attachments)) {
    for (const raw of attachments) {
      const a = raw as { name?: unknown } | null;
      if (a && typeof a.name === 'string' && a.name) names.push(a.name);
    }
  }
  for (const ref of mediaReferences(media)) names.push(ref.filename);
  return names;
}

/**
 * The one transcript rule.
 *
 * Keeps `role IN ('user','assistant')` with `message_type IS NULL` as speech,
 * and a `colleague` row (a platform assistant speaking in a team's chat) as
 * speech too, with the person's own attachments as names; keeps `file_output`
 * / `media` rows as a Files line pointing into files/ (or a Link, or a Name
 * alone); drops everything else. Oldest first; the caller passes rows in
 * order. A reply written with teammates' help names them under `With help
 * from`, after `From`, so the two read together.
 *
 * A produced file rides on the reply of the turn that produced it: a card
 * carries `produced_in_turn_id` (migration 474) and the reply carries that
 * turn as `turn_id`, so the entry reads "Two findings." with its file beside
 * it, the way the person saw it. A card with no producing turn (an older
 * runtime image, a non-chat caller), a media row (which carries no turn), or a
 * card whose turn left no reply is its own entry with Files alone: nothing is
 * guessed from timing.
 */
export function toTranscript(rows: TranscriptRow[], resolveFile: FileResolver): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  const replyByTurn = new Map<string, TranscriptEntry>();
  const pendingFiles: Array<{ row: TranscriptRow; files: FileEntry[]; index: number }> = [];

  for (const row of rows) {
    const sent = row.createdAt.toISOString();
    if (row.messageType === FILE_OUTPUT_MESSAGE_TYPE || row.messageType === MEDIA_MESSAGE_TYPE) {
      const refs = row.messageType === FILE_OUTPUT_MESSAGE_TYPE
        ? fileOutputReferences(row.attachments)
        : mediaReferences(row.media);
      if (refs.length === 0) continue;
      // Placed now so a card whose reply never comes keeps its position;
      // folded into the reply below when the turn has one.
      const entry: TranscriptEntry = { [K.from]: row.from, [K.sent]: sent, [K.files]: refs.map(resolveFile) };
      out.push(entry);
      if (row.messageType === FILE_OUTPUT_MESSAGE_TYPE && row.producedInTurnId) {
        pendingFiles.push({ row, files: entry[K.files] as FileEntry[], index: out.length - 1 });
      }
      continue;
    }
    if (row.messageType !== null && row.messageType !== COLLEAGUE_MESSAGE_TYPE) continue;
    if (row.role !== 'user' && row.role !== 'assistant') continue;
    const entry: TranscriptEntry = {
      [K.from]: row.from,
      ...(row.withHelpFrom.length > 0 ? { [K.withHelpFrom]: row.withHelpFrom } : {}),
      [K.sent]: sent,
      [K.message]: row.content,
    };
    if (row.role === 'user') {
      const names = attachmentNames(row.attachments, row.media);
      if (names.length > 0) entry[K.attachments] = names;
    }
    if (row.role === 'assistant' && row.turnId) replyByTurn.set(row.turnId, entry);
    out.push(entry);
  }

  // Fold each card into its turn's reply; drop the standalone entry it held.
  const folded = new Set<number>();
  for (const pending of pendingFiles) {
    const reply = replyByTurn.get(pending.row.producedInTurnId as string);
    if (!reply) continue;
    reply[K.files] = [...(reply[K.files] ?? []), ...pending.files];
    folded.add(pending.index);
  }
  return folded.size === 0 ? out : out.filter((_, i) => !folded.has(i));
}

// ── Rendering ───────────────────────────────────────────────────────────

export interface ConversationEntry {
  [K.with]: string[];
  [K.surface]: string;
  [K.channel]?: string;
  [K.title]: string;
  [K.startedBy]?: string;
  [K.started]: string;
  [K.lastMessage]?: string;
  [K.messages]: TranscriptEntry[];
}

export interface NameResolvers {
  /** accounts.id → what the person recognises (name, else email). */
  accountName: (accountId: string) => string | undefined;
  /** internal_agents.id → the team's name, archived teams included. */
  teamName: (agentId: string) => string | undefined;
  resolveFile: FileResolver;
}

/** `From` on a row: team chat → sender name, else email, else the Slack/Teams
 *  guest's label; the three assistant surfaces → the recorded sender, else
 *  "Workspace member". An AI reply names the team that wrote it. */
export function speakerName(speaker: Speaker, names: NameResolvers): string {
  switch (speaker.kind) {
    case 'account': {
      const resolved = speaker.accountId ? names.accountName(speaker.accountId) : undefined;
      return resolved ?? speaker.label ?? WORKSPACE_MEMBER;
    }
    case 'team': {
      const resolved = speaker.agentId ? names.teamName(speaker.agentId) : undefined;
      return resolved ?? UNKNOWN_AI_TEAM;
    }
    case 'named':
      return speaker.name;
  }
}

/** `With`: every AI participant that spoke, in order of first reply. */
function participants(conversation: CollectedConversation, names: NameResolvers): string[] {
  const seen: string[] = [];
  const add = (name: string) => { if (!seen.includes(name)) seen.push(name); };
  if (conversation.surface !== 'agent_chat') add(SURFACE_LABELS[conversation.surface]);
  for (const m of conversation.messages) {
    if (m.role !== 'assistant' || m.speaker.kind === 'account') continue;
    add(speakerName(m.speaker, names));
  }
  return seen;
}

export function renderConversation(conversation: CollectedConversation, names: NameResolvers): ConversationEntry {
  const rows: TranscriptRow[] = conversation.messages.map((m) => ({
    role: m.role,
    content: m.content,
    messageType: m.messageType,
    attachments: m.attachments,
    media: m.media,
    createdAt: m.createdAt,
    from: speakerName(m.speaker, names),
    withHelpFrom: m.withHelpFrom,
    turnId: m.turnId,
    producedInTurnId: m.producedInTurnId,
  }));
  const transcript = toTranscript(rows, names.resolveFile);
  const startedBy = conversation.startedByAccountId
    ? names.accountName(conversation.startedByAccountId)
    : undefined;
  const channel = conversation.channel ? CHANNEL_LABELS[conversation.channel] : undefined;
  const last = transcript.length > 0 ? transcript[transcript.length - 1][K.sent] : undefined;
  return {
    [K.with]: participants(conversation, names),
    [K.surface]: SURFACE_LABELS[conversation.surface],
    ...(channel !== undefined ? { [K.channel]: channel } : {}),
    [K.title]: conversation.title ?? UNTITLED_CHAT,
    ...(startedBy !== undefined ? { [K.startedBy]: startedBy } : {}),
    [K.started]: conversation.createdAt.toISOString(),
    ...(last !== undefined ? { [K.lastMessage]: last } : {}),
    [K.messages]: transcript,
  };
}

/** Every surface's conversations, sorted by created time ascending, then id. */
export function sortConversations(conversations: CollectedConversation[]): CollectedConversation[] {
  return [...conversations].sort((a, b) =>
    a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
