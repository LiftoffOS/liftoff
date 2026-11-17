// Workspace administration tools: assignments, members, the workspace's
// name and AI vendor, the oversight defaults, the audit log, and the
// knowledge library. Every write is owner/admin (knowledge is member and
// above) and preview → confirm.

import type { Actor } from '../actor';
import { listAssignments, setAssignments, type AssignmentRequest } from '../assignments';
import { changeRole, inviteMember, listInvitations, listMembers, removeMember, type InviteRole } from '../members';
import {
  getAiVendor,
  getOversight,
  getWorkspace,
  readAuditLog,
  renameWorkspace,
  setAiVendor,
  setOversight,
} from '../workspace';
import { addKnowledgeFile, addKnowledgeUrl, browseKnowledgeSource, listKnowledge, resyncKnowledgeItem } from '../knowledge';
import type { TenantMemberRole } from '../../tenant-members/types';
import type { UpdateOversightSettingsInput } from '../../internal-agent-oversight/types';
import { PreviewRefused, type WorkspaceActionTool } from './types';

function relay<T extends { refused: string; message: string }>(r: T) {
  return { refused: true, reason: r.refused, message: r.message };
}

const INVITE_ROLES: InviteRole[] = ['admin', 'member', 'viewer'];
const MEMBER_ROLES: TenantMemberRole[] = ['owner', 'admin', 'member', 'viewer'];

function assignmentsFromInput(input: Record<string, unknown>): AssignmentRequest[] | null {
  if (!Array.isArray(input.assignments)) return null;
  const out: AssignmentRequest[] = [];
  for (const a of input.assignments) {
    if (!a || typeof a !== 'object') return null;
    const { agentId, agentType } = a as { agentId?: unknown; agentType?: unknown };
    if (typeof agentId !== 'string' || (agentType !== 'internal' && agentType !== 'external')) return null;
    out.push({ agentId, agentType });
  }
  return out;
}

// ─── Assignments ────────────────────────────────────────────────────────────

export const assignmentsListTool: WorkspaceActionTool = {
  definition: {
    name: 'assignments_list',
    description: 'The People page: each person in the workspace and the agents (agentType internal) and collaborators (agentType external) they are assigned to.',
    input_schema: { type: 'object', properties: {} },
  },
  permission: null,
  async execute(_input, actor: Actor) {
    return { people: await listAssignments(actor) };
  },
};

export const assignmentsSetTool: WorkspaceActionTool = {
  definition: {
    name: 'assignments_set',
    description: 'Replace one person\'s assignments with the COMPLETE list given (an empty list clears them). Each entry is { agentId, agentType: "internal" for an agent | "external" for a collaborator }. Preview → confirm.',
    input_schema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'The person, from assignments_list or members_list' },
        assignments: {
          type: 'array', maxItems: 100,
          items: { type: 'object', properties: { agentId: { type: 'string' }, agentType: { type: 'string', enum: ['internal', 'external'] } }, required: ['agentId', 'agentType'] },
        },
        confirmationId: { type: 'string' },
      },
      required: ['accountId', 'assignments'],
    },
  },
  permission: 'assignments:manage',
  mutating: true,
  async preview(input, actor: Actor) {
    const requested = assignmentsFromInput(input);
    if (!requested) throw new PreviewRefused('validation', 'assignments must be a list of { agentId, agentType }');
    const people = await listAssignments(actor);
    const person = people.find((p) => p.accountId === input.accountId);
    if (!person) throw new PreviewRefused('not_found', 'That person is not a member of this workspace.');
    return { person: { accountId: person.accountId, name: person.name }, before: person.assignments, after: requested };
  },
  async execute(input, actor: Actor) {
    const requested = assignmentsFromInput(input) ?? [];
    const r = await setAssignments(actor, String(input.accountId ?? ''), requested);
    return 'refused' in r ? relay(r) : r;
  },
};

// ─── Members ────────────────────────────────────────────────────────────────

export const membersListTool: WorkspaceActionTool = {
  definition: {
    name: 'members_list',
    description: 'The workspace\'s members with their roles, and its pending invitations.',
    input_schema: { type: 'object', properties: { cursor: { type: 'string' }, limit: { type: 'number', minimum: 1, maximum: 100 } } },
  },
  permission: null,
  async execute(input, actor: Actor) {
    const opts = { cursor: typeof input.cursor === 'string' ? input.cursor : null, limit: typeof input.limit === 'number' ? input.limit : undefined };
    const [members, invitations] = await Promise.all([listMembers(actor, opts), listInvitations(actor, { limit: 50 })]);
    return { ...members, invitations: invitations.invitations };
  },
};

export const memberInviteTool: WorkspaceActionTool = {
  definition: {
    name: 'member_invite',
    description: 'Invite someone to the workspace by email, as admin, member or viewer (an owner is made by transferring ownership on the People page). The invitation email is sent by the workspace. Preview → confirm.',
    input_schema: {
      type: 'object',
      properties: { email: { type: 'string', maxLength: 255 }, role: { type: 'string', enum: ['admin', 'member', 'viewer'] }, confirmationId: { type: 'string' } },
      required: ['email', 'role'],
    },
  },
  permission: 'members:invite',
  mutating: true,
  async preview(input) {
    const email = String(input.email ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new PreviewRefused('validation', 'email must be a valid address');
    if (!INVITE_ROLES.includes(input.role as InviteRole)) throw new PreviewRefused('validation', 'role must be admin, member or viewer');
    return { email, role: input.role, sends: 'an invitation email' };
  },
  async execute(input, actor: Actor) {
    const r = await inviteMember(actor, String(input.email ?? '').trim(), input.role as InviteRole);
    return 'refused' in r ? relay(r) : r;
  },
};

export const memberRoleTool: WorkspaceActionTool = {
  definition: {
    name: 'member_role',
    description: 'Change a member\'s role. Only an owner may change an owner, and the last owner cannot be demoted. Preview → confirm.',
    input_schema: {
      type: 'object',
      properties: { accountId: { type: 'string' }, role: { type: 'string', enum: ['owner', 'admin', 'member', 'viewer'] }, confirmationId: { type: 'string' } },
      required: ['accountId', 'role'],
    },
  },
  permission: 'members:change_role',
  mutating: true,
  async preview(input, actor: Actor) {
    if (!MEMBER_ROLES.includes(input.role as TenantMemberRole)) throw new PreviewRefused('validation', 'role must be owner, admin, member or viewer');
    const page = await listMembers(actor, { limit: 100 });
    const member = page.members.find((m) => m.accountId === input.accountId);
    if (!member) throw new PreviewRefused('not_found', 'That person is not a member of this workspace.');
    return { person: { accountId: member.accountId, name: member.name }, before: member.role, after: input.role };
  },
  async execute(input, actor: Actor) {
    const r = await changeRole(actor, String(input.accountId ?? ''), input.role as TenantMemberRole);
    return 'refused' in r ? relay(r) : r;
  },
};

export const memberRemoveTool: WorkspaceActionTool = {
  definition: {
    name: 'member_remove',
    description: 'Remove a member from the workspace. Their coding-tool credentials for this workspace are revoked with the membership. Only an owner may remove an owner, and the last owner cannot be removed. Preview → confirm.',
    input_schema: { type: 'object', properties: { accountId: { type: 'string' }, confirmationId: { type: 'string' } }, required: ['accountId'] },
  },
  permission: 'members:remove',
  mutating: true,
  async preview(input, actor: Actor) {
    const page = await listMembers(actor, { limit: 100 });
    const member = page.members.find((m) => m.accountId === input.accountId);
    if (!member) throw new PreviewRefused('not_found', 'That person is not a member of this workspace.');
    return { person: { accountId: member.accountId, name: member.name, role: member.role }, action: 'remove', alsoRevokes: 'their coding-tool credentials for this workspace' };
  },
  async execute(input, actor: Actor) {
    const r = await removeMember(actor, String(input.accountId ?? ''));
    return 'refused' in r ? relay(r) : r;
  },
};

// ─── Workspace settings ─────────────────────────────────────────────────────

export const workspaceGetTool: WorkspaceActionTool = {
  definition: {
    name: 'workspace_get',
    description: 'The workspace\'s name, status, Workspace AI vendor and oversight defaults.',
    input_schema: { type: 'object', properties: {} },
  },
  permission: null,
  async execute(_input, actor: Actor) {
    const w = await getWorkspace(actor);
    if ('refused' in w) return relay(w);
    const [vendor, oversight] = await Promise.all([getAiVendor(actor), getOversight(actor)]);
    return { ...w, aiVendorOptions: vendor.options, oversight };
  },
};

export const workspaceRenameTool: WorkspaceActionTool = {
  definition: {
    name: 'workspace_rename',
    description: 'Rename the workspace. Preview → confirm.',
    input_schema: { type: 'object', properties: { name: { type: 'string', maxLength: 255 }, confirmationId: { type: 'string' } }, required: ['name'] },
  },
  permission: 'workspace:rename',
  mutating: true,
  async preview(input, actor: Actor) {
    const w = await getWorkspace(actor);
    if ('refused' in w) throw PreviewRefused.from(w);
    return { before: w.name, after: String(input.name ?? '').trim() };
  },
  async execute(input, actor: Actor) {
    const r = await renameWorkspace(actor, String(input.name ?? ''));
    return 'refused' in r ? relay(r) : r;
  },
};

export const workspaceAiVendorTool: WorkspaceActionTool = {
  definition: {
    name: 'workspace_ai_vendor',
    description: 'Set the Workspace AI vendor (workspace_get shows the current one and the options; "default" is Liftoff Managed). A vendor\'s own key is entered on the Workspace settings page, never here. Preview → confirm.',
    input_schema: { type: 'object', properties: { vendor: { type: 'string', maxLength: 50 }, confirmationId: { type: 'string' } }, required: ['vendor'] },
  },
  permission: 'workspace:ai_vendor',
  mutating: true,
  async preview(input, actor: Actor) {
    const current = await getAiVendor(actor);
    if (!current.options.includes(input.vendor as (typeof current.options)[number])) throw new PreviewRefused('validation', `vendor must be one of: ${current.options.join(', ')}`);
    return { before: current.aiVendor, after: input.vendor };
  },
  async execute(input, actor: Actor) {
    const r = await setAiVendor(actor, String(input.vendor ?? ''));
    return 'refused' in r ? relay(r) : r;
  },
};

function oversightPatchFromInput(input: Record<string, unknown>): UpdateOversightSettingsInput {
  const patch: UpdateOversightSettingsInput = {};
  if (input.autonomy === 'autonomous' || input.autonomy === 'balanced' || input.autonomy === 'controlled') patch.autonomy = input.autonomy;
  if (input.escalation === 'exceptions' || input.escalation === 'important' || input.escalation === 'sensitive') patch.escalation = input.escalation;
  if (input.communication === 'draft' || input.communication === 'auto' || input.communication === 'review') patch.communication = input.communication;
  if (input.sensitiveWork && typeof input.sensitiveWork === 'object') {
    const sw = input.sensitiveWork as Record<string, unknown>;
    const keys = ['customerCommunication', 'financialActions', 'dataChanges', 'externalPublishing', 'hiringDecisions'] as const;
    const picked: NonNullable<UpdateOversightSettingsInput['sensitiveWork']> = {};
    for (const k of keys) if (typeof sw[k] === 'boolean') picked[k] = sw[k] as boolean;
    if (Object.keys(picked).length > 0) patch.sensitiveWork = picked;
  }
  return patch;
}

export const oversightSetTool: WorkspaceActionTool = {
  definition: {
    name: 'oversight_set',
    description: 'Change the workspace\'s oversight defaults: autonomy (autonomous | balanced | controlled), escalation (exceptions | important | sensitive), sensitiveWork ({ customerCommunication, financialActions, dataChanges, externalPublishing, hiringDecisions } booleans) and communication (draft | auto | review). Send only what changes. New agents follow these defaults. Preview → confirm.',
    input_schema: {
      type: 'object',
      properties: {
        autonomy: { type: 'string', enum: ['autonomous', 'balanced', 'controlled'] },
        escalation: { type: 'string', enum: ['exceptions', 'important', 'sensitive'] },
        sensitiveWork: { type: 'object', properties: { customerCommunication: { type: 'boolean' }, financialActions: { type: 'boolean' }, dataChanges: { type: 'boolean' }, externalPublishing: { type: 'boolean' }, hiringDecisions: { type: 'boolean' } } },
        communication: { type: 'string', enum: ['draft', 'auto', 'review'] },
        confirmationId: { type: 'string' },
      },
    },
  },
  permission: 'oversight:update',
  mutating: true,
  async preview(input, actor: Actor) {
    const patch = oversightPatchFromInput(input);
    if (Object.keys(patch).length === 0) throw new PreviewRefused('validation', 'Nothing to change: send autonomy, escalation, sensitiveWork or communication');
    return { before: await getOversight(actor), changes: patch };
  },
  async execute(input, actor: Actor) {
    return setOversight(actor, oversightPatchFromInput(input));
  },
};

export const auditLogReadTool: WorkspaceActionTool = {
  definition: {
    name: 'audit_log_read',
    description: 'The workspace audit log (Enterprise plan): who did what, when, from where. Defaults to the last 30 days; a range is at most 90 days. Page with cursor.',
    input_schema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'ISO date' },
        endDate: { type: 'string', description: 'ISO date' },
        cursor: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 100 },
      },
    },
  },
  permission: 'audit:read',
  async execute(input, actor: Actor) {
    const r = await readAuditLog(actor, {
      startDate: typeof input.startDate === 'string' ? input.startDate : undefined,
      endDate: typeof input.endDate === 'string' ? input.endDate : undefined,
      cursor: typeof input.cursor === 'string' ? input.cursor : undefined,
      limit: typeof input.limit === 'number' ? input.limit : undefined,
    });
    return 'refused' in r ? relay(r) : r;
  },
};

// ─── Knowledge library ──────────────────────────────────────────────────────

export const knowledgeListTool: WorkspaceActionTool = {
  definition: {
    name: 'knowledge_list',
    description: 'What is in the workspace\'s knowledge library, as the Knowledge page shows it: the pages, documents and URLs the agents can draw on, each with whether its text was read and, when it was not, the reason on the entry. An entry whose extractionStatus is error holds nothing an agent can use, and syncError says why; relay that reason rather than guessing, and never say the library does not record one.',
    input_schema: { type: 'object', properties: {} },
  },
  permission: null,
  async execute(_input, actor: Actor) {
    return listKnowledge(actor);
  },
};

export const knowledgeAddUrlTool: WorkspaceActionTool = {
  definition: {
    name: 'knowledge_add_url',
    description: 'Add one page to the knowledge library by URL, with a title. The library is workspace-wide context every agent can draw on, so add a page only when the person asks for it, one at a time. Preview → confirm.',
    input_schema: {
      type: 'object',
      properties: { title: { type: 'string', maxLength: 500 }, sourceUrl: { type: 'string', maxLength: 2000 }, confirmationId: { type: 'string' } },
      required: ['title', 'sourceUrl'],
    },
  },
  permission: 'knowledge:write',
  mutating: true,
  async preview(input) {
    return { title: String(input.title ?? '').trim(), sourceUrl: input.sourceUrl, contentType: 'url', scope: 'the whole workspace' };
  },
  async execute(input, actor: Actor) {
    const r = await addKnowledgeUrl(actor, { title: String(input.title ?? ''), sourceUrl: String(input.sourceUrl ?? '') });
    return 'refused' in r ? relay(r) : r;
  },
};

export const knowledgeBrowseTool: WorkspaceActionTool = {
  definition: {
    name: 'knowledge_browse',
    description: 'What a connected app holds, so one thing can be added to the knowledge library by its own id rather than by URL. Works for any connected source, not only file stores: a help centre\'s articles (Zendesk, Intercom), a wiki\'s pages (Confluence, OneNote), a drive\'s files (Google Drive, OneDrive, SharePoint, Dropbox, Box). Takes the connectorId of a connected app from connections_list; `query` searches, `folderId` opens a folder or collection, `entityType` asks a source that holds more than one kind of thing for the kind you want, `cursor` takes the next page. Each result carries the contentType the source itself reports; pass it back to knowledge_add_file unchanged. A result carrying cannotList means the app cannot list this, which is not the same as the account having nothing.',
    input_schema: {
      type: 'object',
      properties: {
        connectorId: { type: 'string', maxLength: 200, description: 'A connected app, from connections_list' },
        query: { type: 'string', maxLength: 200 },
        folderId: { type: 'string', maxLength: 500, description: 'Open a folder or collection, by its externalId from an earlier call' },
        entityType: { type: 'string', maxLength: 60, description: 'For a source that holds more than one kind of thing: which kind to list' },
        mimeTypes: { type: 'string', maxLength: 200, description: 'Narrow a file store to given provider types, comma-separated' },
        cursor: { type: 'string', maxLength: 2000 },
      },
      required: ['connectorId'],
    },
  },
  permission: null,
  async execute(input, actor: Actor) {
    const r = await browseKnowledgeSource(actor, {
      connectorId: String(input.connectorId ?? ''),
      ...(typeof input.query === 'string' ? { query: input.query } : {}),
      ...(typeof input.folderId === 'string' ? { folderId: input.folderId } : {}),
      ...(typeof input.entityType === 'string' ? { entityType: input.entityType } : {}),
      ...(typeof input.mimeTypes === 'string' ? { mimeTypes: input.mimeTypes } : {}),
      ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
    });
    return 'refused' in r ? relay(r) : r;
  },
};

export const knowledgeAddFileTool: WorkspaceActionTool = {
  definition: {
    name: 'knowledge_add_file',
    description: 'Add one thing from a connected app to the knowledge library, the way the Knowledge page\'s picker does: the entry carries the thing itself, so its text is read from the source rather than fetched from a web address. Use this for anything held in a connected app — a Google Doc or Sheet, a Drive or Dropbox file, a Zendesk or Intercom article, a Confluence or OneNote page — and knowledge_add_url only for a public web page. externalId, title, contentType and mimeType all come from knowledge_browse, and contentType must be passed back exactly as it came: it is what decides how the text is read. Preview → confirm.',
    input_schema: {
      type: 'object',
      properties: {
        connectorId: { type: 'string', maxLength: 200 },
        externalId: { type: 'string', maxLength: 500, description: 'The file\'s own id, from knowledge_browse' },
        title: { type: 'string', maxLength: 500 },
        contentType: { type: 'string', maxLength: 40, description: 'What the source called it, from knowledge_browse: article, document, page, folder or collection. Pass it back unchanged; document is assumed when absent' },
        sourceUrl: { type: 'string', maxLength: 2000, description: 'The file\'s link, from knowledge_browse; shown on the row' },
        mimeType: { type: 'string', maxLength: 200, description: 'The provider\'s own type, from knowledge_browse' },
        confirmationId: { type: 'string' },
      },
      required: ['connectorId', 'externalId', 'title'],
    },
  },
  permission: 'knowledge:write',
  mutating: true,
  async preview(input) {
    return {
      title: String(input.title ?? '').trim(),
      from: 'a connected app',
      contentType: typeof input.contentType === 'string' ? input.contentType : 'document',
      scope: 'the whole workspace',
    };
  },
  async execute(input, actor: Actor) {
    const r = await addKnowledgeFile(actor, {
      connectorId: String(input.connectorId ?? ''),
      externalId: String(input.externalId ?? ''),
      title: String(input.title ?? ''),
      ...(typeof input.contentType === 'string' ? { contentType: input.contentType } : {}),
      ...(typeof input.sourceUrl === 'string' ? { sourceUrl: input.sourceUrl } : {}),
      ...(typeof input.mimeType === 'string' ? { mimeType: input.mimeType } : {}),
    });
    return 'refused' in r ? relay(r) : r;
  },
};

export const knowledgeResyncTool: WorkspaceActionTool = {
  definition: {
    name: 'knowledge_resync',
    description: 'Read one library entry again, in place, for an entry whose text could not be read. Use this rather than adding the same file a second time: it leaves one entry either way, and when the file genuinely holds nothing to read the result carries the reason. Only for an entry that came from a connected app. Preview → confirm.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', maxLength: 200, description: 'The entry id from knowledge_list' }, confirmationId: { type: 'string' } },
      required: ['id'],
    },
  },
  permission: 'knowledge:write',
  mutating: true,
  async preview(input) {
    return { id: input.id, action: 'read the file again and replace what the entry holds' };
  },
  async execute(input, actor: Actor) {
    const r = await resyncKnowledgeItem(actor, { id: String(input.id ?? '') });
    return 'refused' in r ? relay(r) : r;
  },
};

export const workspaceAdminTools: WorkspaceActionTool[] = [
  assignmentsListTool,
  assignmentsSetTool,
  membersListTool,
  memberInviteTool,
  memberRoleTool,
  memberRemoveTool,
  workspaceGetTool,
  workspaceRenameTool,
  workspaceAiVendorTool,
  oversightSetTool,
  auditLogReadTool,
  knowledgeListTool,
  knowledgeBrowseTool,
  knowledgeAddFileTool,
  knowledgeResyncTool,
  knowledgeAddUrlTool,
];
