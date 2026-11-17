// The workspace export: one archive of what the workspace holds.
//
// One cutoff. The route takes `asOf = now()` once, it goes in the manifest,
// and every collector, local and remote, applies `created_at <= asOf` to every
// record it includes and to every recorded decision. It is NOT a historical
// reconstruction of mutable properties: a team's current description, a
// connector's current status and a member's current role are read as they are
// at request time, and the README says so in one sentence.
//
// One budget, sequential collectors. Local sections first (cheap, fail fast on
// a huge workspace), then the produced files' SIZES (charged before any
// download), then the runtime feeds (the review history, then each team's
// Learned Context), then the workforce service, then the connectors, and the
// files' BYTES last, so every cheaper way to fail has been tried before the
// bucket is touched. Then names are resolved in one lookup,
// the README is rendered, and the zip is built as a buffer: the ceiling makes
// a buffer fine, and a buffer lets the response carry Content-Length and never
// fail after headers.

import JSZip from 'jszip';
import { ExportBudget } from './budget';
import {
  readTeams,
  readTeamNames,
  readKnowledge,
  readCustomMcpServers,
  readMembers,
  readPendingInvitations,
  readAssignments,
  readExternalCollaborators,
  readExternalCollaboratorNames,
  readGeneratedFiles,
  readWorkspaceName,
  readAccountNames,
  type CustomMcpRow,
} from './queries';
import { collectLearnedContext } from './learned-context';
import {
  collectTeamChat,
  collectLiftoff,
  collectInsights,
  collectChiefAiOfficer,
  renderConversation,
  sortConversations,
  type CollectedConversation,
  type ConversationEntry,
  type NameResolvers,
} from './conversations';
import {
  collectLateFeedback,
  collectRuntimeReview,
  projectApproval,
  projectClarification,
  type ReviewContext,
} from './review';
import {
  collectConnectors,
  catalogDisplayNames,
  resolveTeamIntegrationNames,
  projectTeams,
  projectCollaborators,
  projectKnowledge,
  projectConnections,
  projectMembers,
  projectInvitations,
} from './sections';
import { chargeFileSizes, planFiles, downloadFiles, fileResolver, slugify, type ConversationFolder } from './files';
import type { KnownIds } from './action-format';
import {
  ARCHIVE_FILES,
  EXPORT_FORMAT_VERSION,
  MANIFEST_KEYS,
  AS_OF_NOTE,
  SECTION_KEYS,
  CONVERSATION_KEYS,
  UNTITLED_CHAT,
} from './labels';

export interface WorkspaceExportInput {
  tenantId: string;
  actor: { accountId: string; role: string };
  asOf: Date;
}

export interface ExportCounts {
  [SECTION_KEYS.conversations]: number;
  [SECTION_KEYS.messages]: number;
  [SECTION_KEYS.teams]: number;
  [SECTION_KEYS.knowledge]: number;
  [SECTION_KEYS.connected]: number;
  [SECTION_KEYS.approvals]: number;
  [SECTION_KEYS.clarifications]: number;
  [SECTION_KEYS.members]: number;
  [SECTION_KEYS.files]: number;
  [SECTION_KEYS.invitations]: number;
  [SECTION_KEYS.collaborators]: number;
}

export interface WorkspaceExportResult {
  buffer: Buffer;
  filename: string;
  counts: ExportCounts;
}

const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

export async function buildWorkspaceExport(input: WorkspaceExportInput): Promise<WorkspaceExportResult> {
  const { tenantId, actor, asOf } = input;
  const budget = new ExportBudget();

  // ── The workspace and the exporter ──────────────────────────────────
  const workspaceName = (await readWorkspaceName(tenantId)) ?? 'Workspace';
  const exporter = (await readAccountNames([actor.accountId])).get(actor.accountId);

  // ── Local sections ──────────────────────────────────────────────────
  const conversations: CollectedConversation[] = [];
  conversations.push(...(await collectTeamChat(tenantId, asOf, budget)));
  conversations.push(...(await collectLiftoff(tenantId, asOf, budget)));
  conversations.push(...(await collectInsights(tenantId, asOf, budget)));
  const teams = await readTeams(tenantId, asOf, budget);
  // A resolver, not a section: every team name the tenant has ever had, so an
  // archived team's replies and files keep their name. Bounded by the tenant's
  // own team count and never serialized, so it is not charged to the budget;
  // the same holds for the workspace name and the account lookup below.
  const teamNames = await readTeamNames(tenantId);
  const collaborators = await readExternalCollaborators(tenantId, asOf, budget);
  // The same kind of resolver for External Agents: a team's binding to
  // one that has since been removed still carries its name.
  const collaboratorNames = await readExternalCollaboratorNames(tenantId);
  const knowledge = await readKnowledge(tenantId, asOf, budget);
  const customMcp = await readCustomMcpServers(tenantId, asOf, budget);
  const lateFeedback = await collectLateFeedback(tenantId, asOf, budget);
  const members = await readMembers(tenantId, asOf, budget);
  const invitations = await readPendingInvitations(tenantId, asOf, budget);
  const assignments = await readAssignments(tenantId, asOf, budget);
  const generatedFiles = await readGeneratedFiles(tenantId, asOf, budget);

  // ── File sizes, charged before any byte is fetched ──────────────────
  chargeFileSizes(generatedFiles, budget);

  // ── The runtime feeds, then the workforce service ───────────────────
  const review = await collectRuntimeReview(tenantId, asOf, budget);
  const learnedContext = await collectLearnedContext(tenantId, teams, asOf, budget);
  conversations.push(...(await collectChiefAiOfficer(
    { tenantId, accountId: actor.accountId, role: actor.role }, asOf, budget,
  )));
  const conversationFolders = new Map<string, ConversationFolder>();
  for (const c of conversations) conversationFolders.set(c.id, { createdAt: c.createdAt, title: c.title });
  const filePlan = planFiles(generatedFiles, conversationFolders);

  // ── Connectors ──────────────────────────────────────────────────────
  const { connectors, catalog } = await collectConnectors(tenantId, actor.accountId);
  const displayNames = catalogDisplayNames(catalog);
  const customByConnectorId = new Map<string, CustomMcpRow>(customMcp.map((row) => [row.connector_id, row]));
  const teamIntegrationNames = await resolveTeamIntegrationNames(
    tenantId, teams, displayNames, customByConnectorId, teamNames, collaboratorNames,
  );

  // ── File bytes, last ────────────────────────────────────────────────
  const fileBytes = await downloadFiles(filePlan);

  // ── Names, in one lookup ────────────────────────────────────────────
  const accountIds = new Set<string>([actor.accountId]);
  for (const c of conversations) {
    if (c.startedByAccountId) accountIds.add(c.startedByAccountId);
    for (const m of c.messages) {
      if (m.speaker.kind === 'account' && m.speaker.accountId) accountIds.add(m.speaker.accountId);
    }
  }
  for (const a of review.approvals) if (a.decidedBy) accountIds.add(a.decidedBy);
  for (const c of review.clarifications) if (c.resolvedBy) accountIds.add(c.resolvedBy);
  for (const f of lateFeedback) accountIds.add(f.decided_by);
  const accountNames = await readAccountNames(accountIds);
  const accountName = (id: string): string | undefined => accountNames.get(id)?.display;

  // Every internal identifier this run has seen, for the argument scrub: the
  // resolved name where there is one, "Hidden" otherwise.
  const known = new Map<string, string | null>();
  known.set(tenantId, null);
  for (const [id, name] of accountNames) known.set(id, name.display);
  for (const [id, name] of teamNames) known.set(id, name);
  for (const [id, name] of collaboratorNames) known.set(id, name);
  for (const memories of learnedContext.values()) for (const m of memories) known.set(m.id, null);
  for (const c of connectors) known.set(c.id, c.type ? displayNames.get(c.type) ?? null : null);
  for (const row of customMcp) known.set(row.connector_id, row.name);
  for (const c of conversations) known.set(c.id, c.title ?? UNTITLED_CHAT);
  for (const a of review.approvals) known.set(a.id, null);
  for (const c of review.clarifications) known.set(c.id, null);
  for (const f of filePlan.files) known.set(f.id, f.name);
  const knownIds: KnownIds = known;

  // ── Render ──────────────────────────────────────────────────────────
  const names: NameResolvers = {
    accountName,
    teamName: (agentId) => teamNames.get(agentId),
    resolveFile: fileResolver(filePlan),
  };
  const conversationEntries: ConversationEntry[] = sortConversations(conversations)
    .map((c) => renderConversation(c, names));
  const messageCount = conversationEntries.reduce((n, c) => n + c[CONVERSATION_KEYS.messages].length, 0);

  const reviewCtx: ReviewContext = {
    asOf,
    accountName,
    lateFeedbackByApproval: new Map(lateFeedback.map((f) => [f.approval_id, f])),
    known: knownIds,
  };
  const approvalEntries = review.approvals.map((a) => projectApproval(a, reviewCtx));
  const clarificationEntries = review.clarifications.map((c) => projectClarification(c, reviewCtx));

  const teamEntries = projectTeams(teams, teamIntegrationNames, learnedContext);
  const collaboratorEntries = projectCollaborators(collaborators, teamNames);
  const knowledgeEntries = projectKnowledge(knowledge, displayNames);
  const connectionEntries = projectConnections(connectors, displayNames, customByConnectorId, asOf);
  const memberEntries = projectMembers(members, assignments);
  const invitationEntries = projectInvitations(invitations);
  const includedFiles = filePlan.files.filter((f) => f.path !== null && fileBytes.has(f.path));

  const counts: ExportCounts = {
    [SECTION_KEYS.conversations]: conversationEntries.length,
    [SECTION_KEYS.messages]: messageCount,
    [SECTION_KEYS.teams]: teamEntries.length,
    [SECTION_KEYS.knowledge]: knowledgeEntries.length,
    [SECTION_KEYS.connected]: connectionEntries.length,
    [SECTION_KEYS.approvals]: approvalEntries.length,
    [SECTION_KEYS.clarifications]: clarificationEntries.length,
    [SECTION_KEYS.members]: memberEntries.length,
    [SECTION_KEYS.files]: includedFiles.length,
    [SECTION_KEYS.invitations]: invitationEntries.length,
    [SECTION_KEYS.collaborators]: collaboratorEntries.length,
  };

  const exported = new Date();
  const manifest = {
    [MANIFEST_KEYS.formatVersion]: EXPORT_FORMAT_VERSION,
    [MANIFEST_KEYS.workspace]: workspaceName,
    [MANIFEST_KEYS.exported]: exported.toISOString(),
    [MANIFEST_KEYS.asOf]: asOf.toISOString(),
    [MANIFEST_KEYS.note]: AS_OF_NOTE,
    // An optional key is omitted when there is no value: the exporter always
    // has an account (tenantAuthMiddleware loaded it), but a missing row is an
    // omitted key, never an empty object.
    ...(exporter
      ? { [MANIFEST_KEYS.exportedBy]: { [MANIFEST_KEYS.name]: exporter.display, [MANIFEST_KEYS.email]: exporter.email } }
      : {}),
    [MANIFEST_KEYS.counts]: counts,
  };

  const zip = new JSZip();
  zip.file(ARCHIVE_FILES.readme, renderReadme({ workspaceName, exporter, exported, asOf }));
  zip.file(ARCHIVE_FILES.manifest, pretty(manifest));
  zip.file(ARCHIVE_FILES.conversations, pretty({ [SECTION_KEYS.conversations]: conversationEntries }));
  zip.file(ARCHIVE_FILES.teams, pretty({ [SECTION_KEYS.teams]: teamEntries }));
  zip.file(ARCHIVE_FILES.collaborators, pretty({ [SECTION_KEYS.collaborators]: collaboratorEntries }));
  zip.file(ARCHIVE_FILES.knowledge, pretty({ [SECTION_KEYS.knowledge]: knowledgeEntries }));
  zip.file(ARCHIVE_FILES.connections, pretty({ [SECTION_KEYS.connected]: connectionEntries }));
  zip.file(ARCHIVE_FILES.review, pretty({
    [SECTION_KEYS.approvals]: approvalEntries,
    [SECTION_KEYS.clarifications]: clarificationEntries,
  }));
  zip.file(ARCHIVE_FILES.members, pretty({
    [SECTION_KEYS.members]: memberEntries,
    [SECTION_KEYS.invitations]: invitationEntries,
  }));
  for (const file of includedFiles) {
    zip.file(file.path as string, fileBytes.get(file.path as string) as Buffer);
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });

  const filename = `liftoff-${slugify(workspaceName, 'workspace')}-export-${asOf.toISOString().slice(0, 10)}.zip`;
  return { buffer, filename, counts };
}

/** README.txt: what this is, when, as of when, for whom, and what each file
 *  holds. Each line is a precise positive statement of what the file holds;
 *  the archive describes what it holds and does not list what it lacks. */
export function renderReadme(args: {
  workspaceName: string;
  exporter: { display: string; email: string } | undefined;
  exported: Date;
  asOf: Date;
}): string {
  const who = args.exporter ? `${args.exporter.display} (${args.exporter.email})` : 'a workspace administrator';
  const asOf = args.asOf.toISOString();
  return [
    'Liftoff workspace export',
    '',
    `This archive is a copy of what the workspace "${args.workspaceName}" holds. It was exported by ${who} on ${args.exported.toISOString()} and is current as of ${asOf}. ${AS_OF_NOTE}`,
    '',
    `${ARCHIVE_FILES.manifest}: the workspace, who exported it, when, as of when, and how many entries each file holds.`,
    `${ARCHIVE_FILES.conversations}: the messages people and agents exchanged in every conversation open in the workspace, oldest first, as of ${asOf}.`,
    `${ARCHIVE_FILES.teams}: every agent in the workspace, whether awaiting launch, active or paused, with its name, status, description, the answers it was built from, the agents, External Agents and connections it works with, and its Learned Context as the Update Team page shows it.`,
    `${ARCHIVE_FILES.collaborators}: every External Agent in the workspace, with its name, status, description, capabilities, the agents it works with, how it collaborates, and what it can ask each agent to do.`,
    `${ARCHIVE_FILES.knowledge}: every item in the knowledge library, with its title, link, source and section.`,
    `${ARCHIVE_FILES.connections}: every app connected to the workspace, with its status, and every custom MCP server with its endpoint.`,
    `${ARCHIVE_FILES.review}: every approval and clarification the workspace's agents asked for, with the decision or answer recorded for each as of ${asOf}.`,
    `${ARCHIVE_FILES.members}: every member of the workspace with their role and the agents they work with, and every invitation still pending.`,
    `${ARCHIVE_FILES.filesDir}/: every file the agents produced, as bytes, under a folder named for the conversation it was produced in.`,
    '',
  ].join('\n');
}
