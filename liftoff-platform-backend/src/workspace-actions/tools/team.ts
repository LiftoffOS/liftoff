// Team tools: what the Teams page and all three origins of
// /dashboard/agents/update can do. Every write is preview → confirm; the
// server-side distil runs inside team_update, so a change to a team's text
// or bindings lands the way Save lands it (one 'distill' version) and a
// failed distil changes nothing.

import { z } from 'zod';
import type { Actor } from '../actor';
import { findTeamByName, listAiWorkforce, teamDisplayName } from '../teams';
import { applyTeamUpdate, isTeamUpdateRefusal } from '../team-update';
import { setTeamStatus } from '../team-status';
import { teamStartReadiness } from '../team-start-readiness';
import { archiveTeam } from '../team-archive';
import { deleteMemory, listMemories, listSkills, updateMemory } from '../team-memory';
import { getWebhook, setWebhook, webhookDeliveries, webhookPatchSchema } from '../team-webhook';
import { rollbackCollaborator, rollbackTeam } from '../team-rollback';
import { bindingRequestSchema, skillEditSchema } from '../schemas';
import { teamAttachmentsArraySchema } from '../../internal-agents/attachment-schema';
import { internalAgentService } from '../../internal-agents/service';
import type { InternalAgent } from '../../internal-agents/types';
import type { JSONSchemaProperty } from '../../llm/types';
import { PreviewRefused, type WorkspaceActionTool } from './types';

/** A team by id or by name. */
async function resolveTeam(actor: Actor, input: Record<string, unknown>): Promise<InternalAgent | null> {
  if (typeof input.teamId === 'string' && input.teamId) {
    return internalAgentService.getById(input.teamId, actor.tenantId);
  }
  if (typeof input.team === 'string' && input.team) {
    const { teams } = await listAiWorkforce(actor.tenantId);
    return findTeamByName(teams, input.team);
  }
  return null;
}

const TEAM_ADDRESS: Record<string, JSONSchemaProperty> = {
  teamId: { type: 'string', description: 'The agent id (from teams_list)' },
  team: { type: 'string', maxLength: 200, description: 'Or the agent by name' },
};

/** The schedule as the team's page summarises it: the primary cron and the
 *  companion schedules with their labels. */
function triggerSummary(t: InternalAgent) {
  const trigger = (t.triggerConfig ?? null) as
    | (NonNullable<InternalAgent['triggerConfig']> & { companionCrons?: Array<{ label?: string; cronExpr?: string }> })
    | null;
  if (!trigger) return null;
  return {
    type: trigger.type,
    cronExpr: trigger.cronExpr ?? null,
    timezone: trigger.timezone ?? null,
    companions: (trigger.companionCrons ?? []).map((c) => ({ label: c.label ?? null, cronExpr: c.cronExpr ?? null })),
  };
}

function teamView(t: InternalAgent) {
  return {
    id: t.id,
    name: teamDisplayName(t),
    role: t.role,
    status: t.status,
    responsibilities: t.responsibilities,
    additionalContext: t.additionalContext,
    summary: t.summary,
    bindings: t.integrations.map((i) => ({ id: i.id, type: i.type ?? i.integrationId ?? null, selectedObjects: i.selectedObjects })),
    waitingOnConnections: t.pendingIntegrations,
    attachments: (t.attachments ?? []).map((a) => ({ kind: a.kind, name: a.name })),
    autonomyOverride: t.autonomyOverride ?? null,
    aiVendorOverride: t.aiVendorOverride ?? null,
    messagingNickname: t.messagingNickname,
    trigger: triggerSummary(t),
    currentVersion: t.currentVersion,
    skills: (t.skills ?? []).filter((s) => !s.archived).map((s) => ({ id: s.id, name: s.name, provenance: s.provenance ?? 'distilled' })),
  };
}

const NOT_FOUND = { refused: true, reason: 'not_found', message: 'No agent by that id or name in this workspace.' };

/** An agent's own prose, whole: what `team_get` and `team_skills` return and
 *  what `team_update`'s preview shows before anyone confirms it.
 *  Responsibilities, additional context and a skill's instruction are each
 *  capped at 10,000 characters, and every writer takes the current text and
 *  requires it quoted exactly as the read returned it (the Chief AI Officer's
 *  `team__propose_update` says so in as many words). Against the sanitizer's
 *  500-character default an edit anchored past the cut can never match, the
 *  model cannot see what it is rewriting, and a person confirms a before/after
 *  whose two sides are both cut off. */
const TEAM_PROSE_STRING_LIMIT = 12_000;

/** One memory, whole. `team_memory_edit` takes a replacement of up to 4,000
 *  characters, so a memory read at 500 is rewritten half-blind. */
const TEAM_MEMORY_STRING_LIMIT = 6_000;

const teamPatchSchema = z.object({
  role: z.string().min(1).max(255).optional(),
  responsibilities: z.string().max(10000).optional(),
  additionalContext: z.string().max(10000).optional(),
  bindings: z.array(bindingRequestSchema).max(50).optional(),
  attachments: teamAttachmentsArraySchema.optional(),
  skillEdits: z.array(skillEditSchema).max(50).optional(),
  memoryDeletions: z.array(z.string().min(1).max(200)).max(100).optional(),
  messagingNickname: z.string().max(35).optional(),
  autonomyOverride: z.enum(['autonomous', 'balanced', 'controlled']).nullable().optional(),
  aiVendorOverride: z.string().max(100).nullable().optional(),
  temperature: z.number().min(0).max(2).optional(),
});

export const teamGetTool: WorkspaceActionTool = {
  definition: {
    name: 'team_get',
    description: 'One agent in full: its text (role, responsibilities, additional context), what it is bound to, its attachments, overrides, schedule, skills and version.',
    input_schema: { type: 'object', properties: TEAM_ADDRESS },
  },
  permission: null,
  maxResultStringLength: TEAM_PROSE_STRING_LIMIT,
  async execute(input, actor: Actor) {
    const team = await resolveTeam(actor, input);
    return team ? teamView(team) : NOT_FOUND;
  },
};

export const teamUpdateTool: WorkspaceActionTool = {
  definition: {
    name: 'team_update',
    description:
      'Change an agent the way Save on its settings page does. Send only what changes: role, responsibilities and additionalContext (full replacement text, in the person\'s terms), bindings (the COMPLETE list of what the agent should be bound to: connector types, each with its connectorId when the agent already holds one or the person chose one, external agents by id, peer agents by id; team_get shows the current bindings with their ids), attachments, skillEdits (instruction, preserve, archive, restore, by skill id), memoryDeletions (memory ids), messagingNickname, autonomyOverride, aiVendorOverride. Changing role, responsibilities, additionalContext, attachments or bindings rebuilds the agent from the new text before anything is saved, and a rebuild that fails changes nothing; changing only a setting (messagingNickname, autonomyOverride, aiVendorOverride, temperature, skillEdits, memoryDeletions) does not rebuild it. Preview → confirm: without confirmationId you get a before/after preview and a handle; call again with the handle when the person agrees.',
    input_schema: {
      type: 'object',
      properties: {
        ...TEAM_ADDRESS,
        role: { type: 'string', maxLength: 255 },
        responsibilities: { type: 'string', maxLength: 10000 },
        additionalContext: { type: 'string', maxLength: 10000 },
        bindings: {
          type: 'array', maxItems: 50,
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['connector', 'collaborator', 'team'] },
              type: { type: 'string', description: 'Connector type, for kind connector (e.g. google_mail)' },
              connectorId: { type: 'string', description: 'For kind connector: a specific connection of that type (from connections_list or the agent\'s current bindings); omit for the workspace\'s first active one' },
              id: { type: 'string', description: 'The external agent or agent id, for the other kinds' },
              selectedObjects: { type: 'array', items: { type: 'string' } },
            },
            required: ['kind'],
          },
        },
        attachments: { type: 'array', items: { type: 'object' } },
        skillEdits: {
          type: 'array', maxItems: 50,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              instruction: { type: 'string', maxLength: 10000 },
              preserve: { type: 'boolean' },
              archive: { type: 'boolean' },
              restore: { type: 'boolean' },
            },
            required: ['id'],
          },
        },
        memoryDeletions: { type: 'array', items: { type: 'string' }, maxItems: 100 },
        messagingNickname: { type: 'string', maxLength: 35 },
        autonomyOverride: { type: 'string', enum: ['autonomous', 'balanced', 'controlled'] },
        aiVendorOverride: { type: 'string' },
        temperature: { type: 'number', minimum: 0, maximum: 2 },
        confirmationId: { type: 'string' },
      },
    },
  },
  permission: 'teams:update',
  mutating: true,
  steward: 'caio',
  maxResultStringLength: TEAM_PROSE_STRING_LIMIT,
  async preview(input, actor: Actor) {
    const team = await resolveTeam(actor, input);
    if (!team) throw new PreviewRefused(NOT_FOUND.reason, NOT_FOUND.message);
    const { teamId: _id, team: _name, ...rest } = input;
    const parsed = teamPatchSchema.safeParse(rest);
    if (!parsed.success) throw new PreviewRefused('validation', `Validation failed: ${parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')}`);
    const before = teamView(team);
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value === undefined) continue;
      changes[key] = { before: (before as Record<string, unknown>)[key] ?? null, after: value };
    }
    return {
      team: { id: team.id, name: before.name },
      changes,
      note: rebuilds(parsed.data) ? REBUILD_NOTE : SETTING_NOTE,
    };
  },
  async execute(input, actor: Actor) {
    const team = await resolveTeam(actor, input);
    if (!team) return NOT_FOUND;
    const { teamId: _id, team: _name, ...rest } = input;
    const parsed = teamPatchSchema.safeParse(rest);
    if (!parsed.success) return { refused: true, reason: 'validation', message: parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ') };
    const result = await applyTeamUpdate(
      actor,
      team.id,
      parsed.data as Parameters<typeof applyTeamUpdate>[2],
      { distill: rebuilds(parsed.data) ? 'server' : 'none' },
    );
    if (isTeamUpdateRefusal(result)) return { refused: true, reason: result.refused, message: result.message, ...(result.context !== undefined ? { context: result.context } : {}) };
    return {
      updated: true,
      team: teamView(result.agent),
      ...(result.memoryDeletionsFailed ? { memoryDeletionsFailed: result.memoryDeletionsFailed, note: 'Some memories could not be deleted; running the same request again deletes the rest.' } : {}),
    };
  },
};

/** The fields the distiller reads. A patch that touches one of them changes what
 *  the agent is built from, so it is rebuilt before anything is saved; a patch
 *  that touches none of them is a setting, and rebuilding would re-run the
 *  distiller over inputs that did not change — a new distilled slice, a new
 *  version and a model call, for a dropdown. This is the same rule the Update
 *  Team page applies by sending a distill handle only when one of these changed,
 *  so a change made here and the same change made on the page land identically.
 *
 *  `bindings` is the tool's name for what the distiller reads as `integrations`. */
const DISTILLER_INPUTS = [
  'role', 'responsibilities', 'additionalContext', 'attachments', 'bindings', 'pendingIntegrations',
] as const;

function rebuilds(patch: Record<string, unknown>): boolean {
  return DISTILLER_INPUTS.some((k) => patch[k] !== undefined);
}

const REBUILD_NOTE = 'The agent is rebuilt from the new text before it is saved; if the rebuild does not go through, nothing changes.';
const SETTING_NOTE = 'This changes a setting only, so the agent is not rebuilt and what it has learned is untouched.';

export const teamStatusTool: WorkspaceActionTool = {
  definition: {
    name: 'team_status',
    description: 'Start (active), pause (paused) or return to draft an agent. Preview → confirm. Starting an agent needs an active plan; the result carries the workspace\'s own reason when it cannot start.',
    input_schema: {
      type: 'object',
      properties: { ...TEAM_ADDRESS, status: { type: 'string', enum: ['draft', 'active', 'paused'] }, confirmationId: { type: 'string' } },
      required: ['status'],
    },
  },
  permission: 'teams:status',
  mutating: true,
  steward: 'caio',
  async preview(input, actor: Actor) {
    const team = await resolveTeam(actor, input);
    if (!team) throw new PreviewRefused(NOT_FOUND.reason, NOT_FOUND.message);
    return { team: { id: team.id, name: teamDisplayName(team) }, from: team.status, to: input.status };
  },
  async execute(input, actor: Actor) {
    const team = await resolveTeam(actor, input);
    if (!team) return NOT_FOUND;
    const status = input.status === 'active' || input.status === 'paused' || input.status === 'draft' ? input.status : null;
    if (!status) return { refused: true, reason: 'validation', message: 'status must be draft, active or paused.' };
    const result = await setTeamStatus(actor, team.id, status);
    if ('refused' in result) return { refused: true, reason: result.refused, message: result.message, ...(result.context !== undefined ? { context: result.context } : {}) };
    return { updated: true, team: { id: result.agent.id, name: teamDisplayName(result.agent), status: result.agent.status } };
  },
};

export const teamStartReadinessTool: WorkspaceActionTool = {
  definition: {
    name: 'team_start_readiness',
    description:
      'Whether agents could start right now, read BEFORE asking the person to decide: canRun (the workspace has an active plan and credit) with the workspace\'s own reason when not, activeTeams (starting adds to that count on the subscription), which of the given connector types are not connected yet, and chatWorkspaces (whether the Liftoff app is installed in Slack and in Microsoft Teams, which is what lets an agent post there and a person read it there). Read it before offering to launch the agents a plan is about to build, and before offering a destination; setTeamStatus checks the same facts again when each agent starts.',
    input_schema: {
      type: 'object',
      properties: {
        connectorTypes: { type: 'array', items: { type: 'string', maxLength: 100 }, maxItems: 50, description: 'The connector types the plan\'s agents need (e.g. "gmail", "google_sheets"). Optional.' },
      },
    },
  },
  permission: null,
  mutating: false,
  async execute(input, actor: Actor) {
    const types = Array.isArray(input.connectorTypes)
      ? input.connectorTypes.filter((t): t is string => typeof t === 'string' && t.length > 0).slice(0, 50)
      : [];
    return teamStartReadiness(actor, types);
  },
};

export const teamArchiveTool: WorkspaceActionTool = {
  definition: {
    name: 'team_archive',
    description: 'Remove an agent: the one removal action there is, and what "delete", "remove" and "archive" all name (the Teams page\'s Archive action). Preview → confirm.',
    input_schema: { type: 'object', properties: { ...TEAM_ADDRESS, confirmationId: { type: 'string' } } },
  },
  permission: 'teams:delete',
  mutating: true,
  steward: 'caio',
  async preview(input, actor: Actor) {
    const team = await resolveTeam(actor, input);
    if (!team) throw new PreviewRefused(NOT_FOUND.reason, NOT_FOUND.message);
    return { team: { id: team.id, name: teamDisplayName(team), status: team.status }, action: 'archive' };
  },
  async execute(input, actor: Actor) {
    const team = await resolveTeam(actor, input);
    if (!team) return NOT_FOUND;
    const result = await archiveTeam(actor, team.id);
    if ('refused' in result) return { refused: true, reason: result.refused, message: result.message };
    return { archived: true, team: { id: team.id, name: teamDisplayName(team) } };
  },
};

export const teamMemoriesTool: WorkspaceActionTool = {
  definition: {
    name: 'team_memories',
    description: 'What an agent remembers: its runtime memories, newest first, with an optional search. Delete or edit one with team_memory_delete / team_memory_edit.',
    input_schema: { type: 'object', properties: { ...TEAM_ADDRESS, search: { type: 'string', maxLength: 200 }, limit: { type: 'number', minimum: 1, maximum: 100 }, cursor: { type: 'string' } } },
  },
  permission: null,
  maxResultStringLength: TEAM_MEMORY_STRING_LIMIT,
  async execute(input, actor: Actor) {
    const team = await resolveTeam(actor, input);
    if (!team) return NOT_FOUND;
    const result = await listMemories(actor, team.id, {
      search: typeof input.search === 'string' ? input.search : undefined,
      limit: typeof input.limit === 'number' ? input.limit : undefined,
      cursor: typeof input.cursor === 'string' ? input.cursor : undefined,
    });
    if ('refused' in result) return { refused: true, reason: result.refused, message: result.message };
    return result;
  },
};

export const teamMemoryDeleteTool: WorkspaceActionTool = {
  definition: {
    name: 'team_memory_delete',
    description: 'Delete one of an agent\'s memories. Preview → confirm.',
    input_schema: { type: 'object', properties: { ...TEAM_ADDRESS, memoryId: { type: 'string' }, confirmationId: { type: 'string' } }, required: ['memoryId'] },
  },
  permission: 'teams:update',
  mutating: true,
  steward: 'caio',
  async preview(input, actor: Actor) {
    const team = await resolveTeam(actor, input);
    if (!team) throw new PreviewRefused(NOT_FOUND.reason, NOT_FOUND.message);
    return { team: { id: team.id, name: teamDisplayName(team) }, memoryId: input.memoryId, action: 'delete' };
  },
  async execute(input, actor: Actor) {
    const team = await resolveTeam(actor, input);
    if (!team) return NOT_FOUND;
    const result = await deleteMemory(actor, team.id, String(input.memoryId ?? ''));
    if ('refused' in result) return { refused: true, reason: result.refused, message: result.message };
    return { deleted: true, memoryId: input.memoryId };
  },
};

export const teamMemoryEditTool: WorkspaceActionTool = {
  definition: {
    name: 'team_memory_edit',
    description: 'Rewrite one of an agent\'s memories. Preview → confirm.',
    input_schema: { type: 'object', properties: { ...TEAM_ADDRESS, memoryId: { type: 'string' }, content: { type: 'string', maxLength: 4000 }, confirmationId: { type: 'string' } }, required: ['memoryId', 'content'] },
  },
  permission: 'teams:update',
  mutating: true,
  steward: 'caio',
  maxResultStringLength: TEAM_MEMORY_STRING_LIMIT,
  async preview(input, actor: Actor) {
    const team = await resolveTeam(actor, input);
    if (!team) throw new PreviewRefused(NOT_FOUND.reason, NOT_FOUND.message);
    return { team: { id: team.id, name: teamDisplayName(team) }, memoryId: input.memoryId, content: input.content };
  },
  async execute(input, actor: Actor) {
    const team = await resolveTeam(actor, input);
    if (!team) return NOT_FOUND;
    const content = typeof input.content === 'string' ? input.content.trim() : '';
    if (!content) return { refused: true, reason: 'validation', message: 'content is required.' };
    const result = await updateMemory(actor, team.id, String(input.memoryId ?? ''), content);
    if ('refused' in result) return { refused: true, reason: result.refused, message: result.message };
    return { updated: true, memory: result.memory };
  },
};

export const teamSkillsTool: WorkspaceActionTool = {
  definition: {
    name: 'team_skills',
    description: 'An agent\'s skills with their provenance (distilled, learned, operator), protection and archived state. Change them with team_update\'s skillEdits.',
    input_schema: { type: 'object', properties: TEAM_ADDRESS },
  },
  permission: null,
  maxResultStringLength: TEAM_PROSE_STRING_LIMIT,
  async execute(input, actor: Actor) {
    const team = await resolveTeam(actor, input);
    if (!team) return NOT_FOUND;
    const result = await listSkills(actor, team.id);
    if ('refused' in result) return { refused: true, reason: result.refused, message: result.message };
    return result;
  },
};

export const teamWebhookGetTool: WorkspaceActionTool = {
  definition: {
    name: 'team_webhook_get',
    description: 'An agent\'s inbound webhook settings (never its URL or secret; those are on the agent\'s Settings page) and its recent deliveries.',
    input_schema: { type: 'object', properties: { ...TEAM_ADDRESS, deliveries: { type: 'number', minimum: 1, maximum: 50, description: 'How many recent deliveries to include (default 5)' } } },
  },
  permission: null,
  async execute(input, actor: Actor) {
    const team = await resolveTeam(actor, input);
    if (!team) return NOT_FOUND;
    const settings = await getWebhook(actor, team.id);
    if ('refused' in settings) return { refused: true, reason: settings.refused, message: settings.message };
    const deliveries = await webhookDeliveries(actor, team.id, typeof input.deliveries === 'number' ? input.deliveries : 5);
    return { ...settings, ...('deliveries' in deliveries ? { deliveries: deliveries.deliveries } : {}) };
  },
};

export const teamWebhookSetTool: WorkspaceActionTool = {
  definition: {
    name: 'team_webhook_set',
    description: 'Change an agent\'s inbound webhook settings: enabled, hmacRequired, rateLimitPerMinute, contentFilterEnabled, piiHashMode. Provisioning a webhook and resetting its secret are done on the agent\'s Settings page. Preview → confirm.',
    input_schema: {
      type: 'object',
      properties: {
        ...TEAM_ADDRESS,
        enabled: { type: 'boolean' },
        hmacRequired: { type: 'boolean' },
        rateLimitPerMinute: { type: 'number', minimum: 1, maximum: 10000 },
        contentFilterEnabled: { type: 'boolean' },
        piiHashMode: { type: 'boolean' },
        confirmationId: { type: 'string' },
      },
    },
  },
  permission: 'teams:update',
  mutating: true,
  steward: 'caio',
  async preview(input, actor: Actor) {
    const team = await resolveTeam(actor, input);
    if (!team) throw new PreviewRefused(NOT_FOUND.reason, NOT_FOUND.message);
    const { teamId: _id, team: _name, ...rest } = input;
    const patch = webhookPatchSchema.safeParse(rest);
    if (!patch.success) throw new PreviewRefused('validation', 'Validation failed: ' + patch.error.errors.map((e) => e.message).join('; '));
    const current = await getWebhook(actor, team.id);
    if ('refused' in current) throw PreviewRefused.from(current);
    return { team: { id: team.id, name: teamDisplayName(team) }, before: current.webhook, changes: patch.data };
  },
  async execute(input, actor: Actor) {
    const team = await resolveTeam(actor, input);
    if (!team) return NOT_FOUND;
    const { teamId: _id, team: _name, ...rest } = input;
    const patch = webhookPatchSchema.safeParse(rest);
    if (!patch.success) return { refused: true, reason: 'validation', message: patch.error.errors.map((e) => e.message).join('; ') };
    const result = await setWebhook(actor, team.id, patch.data);
    if ('refused' in result) return { refused: true, reason: result.refused, message: result.message };
    return { updated: true, webhook: result.webhook };
  },
};

export const teamRollbackTool: WorkspaceActionTool = {
  definition: {
    name: 'team_rollback',
    description: 'Restore a previous version of an agent (a new version is written; the restore is itself undoable). Preview → confirm.',
    input_schema: { type: 'object', properties: { ...TEAM_ADDRESS, version: { type: 'number', minimum: 1 }, confirmationId: { type: 'string' } }, required: ['version'] },
  },
  permission: 'teams:update',
  mutating: true,
  steward: 'caio',
  async preview(input, actor: Actor) {
    const team = await resolveTeam(actor, input);
    if (!team) throw new PreviewRefused(NOT_FOUND.reason, NOT_FOUND.message);
    return { team: { id: team.id, name: teamDisplayName(team), currentVersion: team.currentVersion }, restoreVersion: input.version };
  },
  async execute(input, actor: Actor) {
    const team = await resolveTeam(actor, input);
    if (!team) return NOT_FOUND;
    const version = typeof input.version === 'number' ? Math.floor(input.version) : NaN;
    if (!(version >= 1)) return { refused: true, reason: 'validation', message: 'version must be a positive number.' };
    const result = await rollbackTeam(actor, team.id, version);
    if ('refused' in result) return { refused: true, reason: result.refused, message: result.message };
    return { restored: true, team: teamView(result.agent) };
  },
};

export const collaboratorRollbackTool: WorkspaceActionTool = {
  definition: {
    name: 'collaborator_rollback',
    description: 'Restore a previous version of an external agent. Preview → confirm.',
    input_schema: { type: 'object', properties: { collaboratorId: { type: 'string' }, version: { type: 'number', minimum: 1 }, confirmationId: { type: 'string' } }, required: ['collaboratorId', 'version'] },
  },
  permission: 'collaborators:update',
  mutating: true,
  steward: 'caio',
  async preview(input) {
    return { collaboratorId: input.collaboratorId, restoreVersion: input.version };
  },
  async execute(input, actor: Actor) {
    const version = typeof input.version === 'number' ? Math.floor(input.version) : NaN;
    if (!(version >= 1)) return { refused: true, reason: 'validation', message: 'version must be a positive number.' };
    const result = await rollbackCollaborator(actor, String(input.collaboratorId ?? ''), version);
    if ('refused' in result) return { refused: true, reason: result.refused, message: result.message };
    return { restored: true, collaborator: { id: result.collaborator.id, name: result.collaborator.name, currentVersion: result.collaborator.currentVersion } };
  },
};

export const teamTools: WorkspaceActionTool[] = [
  teamGetTool,
  teamUpdateTool,
  teamStatusTool,
  teamStartReadinessTool,
  teamArchiveTool,
  teamMemoriesTool,
  teamMemoryDeleteTool,
  teamMemoryEditTool,
  teamSkillsTool,
  teamWebhookGetTool,
  teamWebhookSetTool,
  teamRollbackTool,
  collaboratorRollbackTool,
];
