// Collaborator tools: read one, connect one (no credential), update its
// settings, pause or resume it, rediscover it, move its endpoint, archive it,
// and wire or unwire it with a team (the reconciler in collaboration.ts).
// All owner/admin (collaborators:update); every write is preview → confirm.

import type { Actor } from '../actor';
import {
  archiveCollaborator,
  collaborationModeSchema,
  collaboratorRequestRuleSchema,
  connectCollaborator,
  getCollaborator,
  rediscoverCollaborator,
  setCollaboratorEndpoint,
  setCollaboratorStatus,
  updateCollaborator,
  WIZARD_DEFAULT_PERMISSIONS,
} from '../collaborator';
import { unwireCollaboration, wireCollaboration } from '../collaboration';
import { findTeamByName, listAiWorkforce, teamDisplayName } from '../teams';
import { internalAgentService } from '../../internal-agents/service';
import type { JSONSchemaProperty } from '../../llm/types';
import { PreviewRefused, type WorkspaceActionTool } from './types';

const RULES_SCHEMA: JSONSchemaProperty = {
  type: 'array',
  maxItems: 100,
  items: {
    type: 'object',
    properties: {
      internalAgentId: { type: 'string' },
      permissions: {
        type: 'object',
        properties: {
          read_summaries: { type: 'string', enum: ['allowed', 'approval_required', 'blocked'] },
          run_analysis: { type: 'string', enum: ['allowed', 'approval_required', 'blocked'] },
          draft_outputs: { type: 'string', enum: ['allowed', 'approval_required', 'blocked'] },
          propose_updates: { type: 'string', enum: ['allowed', 'approval_required', 'blocked'] },
        },
      },
    },
    required: ['internalAgentId', 'permissions'],
  },
};

const MODE: JSONSchemaProperty = { type: 'string', enum: ['request_help', 'receive_delegated', 'two_way', 'observe_only'], description: 'How the external agent works with the agents' };

function relay<T extends { refused: string; message: string; context?: unknown }>(r: T) {
  return { refused: true, reason: r.refused, message: r.message, ...(r.context !== undefined ? { context: r.context } : {}) };
}

async function resolveTeamId(actor: Actor, input: Record<string, unknown>, idKey = 'teamId', nameKey = 'team'): Promise<string | null> {
  if (typeof input[idKey] === 'string' && input[idKey]) {
    const t = await internalAgentService.getById(input[idKey] as string, actor.tenantId);
    return t ? t.id : null;
  }
  if (typeof input[nameKey] === 'string' && input[nameKey]) {
    const { teams } = await listAiWorkforce(actor.tenantId);
    return findTeamByName(teams, input[nameKey] as string)?.id ?? null;
  }
  return null;
}

export const collaboratorGetTool: WorkspaceActionTool = {
  definition: {
    name: 'collaborator_get',
    description: 'One external agent in full: its settings, status, which agents it works with and how, its cost, its capabilities and any capability changes awaiting review.',
    input_schema: { type: 'object', properties: { collaboratorId: { type: 'string' } }, required: ['collaboratorId'] },
  },
  permission: 'collaborators:update',
  async execute(input, actor: Actor) {
    const r = await getCollaborator(actor, String(input.collaboratorId ?? ''));
    return 'refused' in r ? relay(r) : r.collaborator;
  },
};

export const collaboratorConnectTool: WorkspaceActionTool = {
  definition: {
    name: 'collaborator_connect',
    description:
      'Connect an external agent that needs no credential (an MCP endpoint reachable without a token): discover what it serves, then create it with the agents it may work with and how. An external agent that needs a key, a token or a tunnel is connected on the Collaborators page; say so and point there. Preview → confirm.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 255 },
        endpointUrl: { type: 'string', maxLength: 2000 },
        description: { type: 'string', maxLength: 10000 },
        allowedTeamIds: { type: 'array', items: { type: 'string' }, maxItems: 100 },
        collaborationMode: MODE,
        requestRules: RULES_SCHEMA,
        confirmationId: { type: 'string' },
      },
      required: ['name', 'endpointUrl', 'collaborationMode'],
    },
  },
  permission: 'collaborators:update',
  mutating: true,
  steward: 'caio',
  async preview(input) {
    const mode = collaborationModeSchema.safeParse(input.collaborationMode);
    if (!mode.success) throw new PreviewRefused('validation', 'collaborationMode must be one of request_help, receive_delegated, two_way, observe_only.');
    return {
      name: input.name,
      endpointUrl: input.endpointUrl,
      description: input.description ?? null,
      collaborationMode: mode.data,
      allowedTeamIds: Array.isArray(input.allowedTeamIds) ? input.allowedTeamIds : [],
      requestRules: input.requestRules ?? `the connection wizard's defaults for each team: ${JSON.stringify(WIZARD_DEFAULT_PERMISSIONS)}`,
      note: 'The endpoint is read (discovery) before the collaborator is created; nothing needs a credential here.',
    };
  },
  async execute(input, actor: Actor) {
    const mode = collaborationModeSchema.safeParse(input.collaborationMode);
    if (!mode.success) return { refused: true, reason: 'validation', message: 'collaborationMode must be one of request_help, receive_delegated, two_way, observe_only.' };
    const rules = Array.isArray(input.requestRules) ? input.requestRules.map((r) => collaboratorRequestRuleSchema.parse(r)) : undefined;
    const r = await connectCollaborator(actor, {
      name: String(input.name ?? ''),
      endpointUrl: String(input.endpointUrl ?? ''),
      description: typeof input.description === 'string' ? input.description : undefined,
      allowedTeamIds: Array.isArray(input.allowedTeamIds) ? input.allowedTeamIds.filter((v): v is string => typeof v === 'string') : [],
      collaborationMode: mode.data,
      requestRules: rules,
    });
    return 'refused' in r ? relay(r) : { connected: true, collaborator: r.collaborator };
  },
};

export const collaboratorUpdateTool: WorkspaceActionTool = {
  definition: {
    name: 'collaborator_update',
    description: 'Change an external agent\'s settings: name, description, collaborationMode, allowedInternalAgentIds (the agents it may work with), requestRules, costAmount, costType. Preview → confirm.',
    input_schema: {
      type: 'object',
      properties: {
        collaboratorId: { type: 'string' },
        name: { type: 'string', maxLength: 255 },
        description: { type: 'string', maxLength: 10000 },
        collaborationMode: MODE,
        allowedInternalAgentIds: { type: 'array', items: { type: 'string' }, maxItems: 100 },
        requestRules: RULES_SCHEMA,
        costAmount: { type: 'number' },
        costType: { type: 'string', enum: ['per_task', 'per_month'] },
        confirmationId: { type: 'string' },
      },
      required: ['collaboratorId'],
    },
  },
  permission: 'collaborators:update',
  mutating: true,
  steward: 'caio',
  async preview(input, actor: Actor) {
    const current = await getCollaborator(actor, String(input.collaboratorId ?? ''));
    if ('refused' in current) throw PreviewRefused.from(current);
    const { collaboratorId: _id, ...changes } = input;
    return { collaborator: { id: current.collaborator.id, name: current.collaborator.name }, before: current.collaborator, changes };
  },
  async execute(input, actor: Actor) {
    const mode = input.collaborationMode !== undefined ? collaborationModeSchema.safeParse(input.collaborationMode) : null;
    if (mode && !mode.success) return { refused: true, reason: 'validation', message: 'collaborationMode is not one of the four modes.' };
    const r = await updateCollaborator(actor, String(input.collaboratorId ?? ''), {
      ...(typeof input.name === 'string' ? { name: input.name } : {}),
      ...(typeof input.description === 'string' ? { description: input.description } : {}),
      ...(mode?.success ? { collaborationMode: mode.data } : {}),
      ...(Array.isArray(input.allowedInternalAgentIds) ? { allowedInternalAgentIds: input.allowedInternalAgentIds.filter((v): v is string => typeof v === 'string') } : {}),
      ...(Array.isArray(input.requestRules) ? { requestRules: input.requestRules.map((rule) => collaboratorRequestRuleSchema.parse(rule)) } : {}),
      ...(typeof input.costAmount === 'number' || input.costAmount === null ? { costAmount: input.costAmount as number | null } : {}),
      ...(input.costType === 'per_task' || input.costType === 'per_month' || input.costType === null ? { costType: input.costType as 'per_task' | 'per_month' | null } : {}),
    });
    return 'refused' in r ? relay(r) : { updated: true, collaborator: r.collaborator };
  },
};

export const collaboratorStatusTool: WorkspaceActionTool = {
  definition: {
    name: 'collaborator_status',
    description: 'Pause (disconnected) or resume (connected) an external agent. Preview → confirm.',
    input_schema: { type: 'object', properties: { collaboratorId: { type: 'string' }, status: { type: 'string', enum: ['connected', 'disconnected'] }, confirmationId: { type: 'string' } }, required: ['collaboratorId', 'status'] },
  },
  permission: 'collaborators:update',
  mutating: true,
  steward: 'caio',
  async preview(input, actor: Actor) {
    const current = await getCollaborator(actor, String(input.collaboratorId ?? ''));
    if ('refused' in current) throw PreviewRefused.from(current);
    return { collaborator: { id: current.collaborator.id, name: current.collaborator.name }, from: current.collaborator.status, to: input.status };
  },
  async execute(input, actor: Actor) {
    if (input.status !== 'connected' && input.status !== 'disconnected') return { refused: true, reason: 'validation', message: 'status must be connected or disconnected.' };
    const r = await setCollaboratorStatus(actor, String(input.collaboratorId ?? ''), input.status);
    return 'refused' in r ? relay(r) : { updated: true, collaborator: r.collaborator };
  },
};

export const collaboratorRediscoverTool: WorkspaceActionTool = {
  definition: {
    name: 'collaborator_rediscover',
    description: 'Read an external agent\'s endpoint again and record what changed. A removed or reclassified tool puts the collaborator into review until a person approves. Preview → confirm.',
    input_schema: { type: 'object', properties: { collaboratorId: { type: 'string' }, confirmationId: { type: 'string' } }, required: ['collaboratorId'] },
  },
  permission: 'collaborators:update',
  mutating: true,
  steward: 'caio',
  async preview(input, actor: Actor) {
    const current = await getCollaborator(actor, String(input.collaboratorId ?? ''));
    if ('refused' in current) throw PreviewRefused.from(current);
    return { collaborator: { id: current.collaborator.id, name: current.collaborator.name, endpointHost: current.collaborator.endpointHost }, action: 'rediscover' };
  },
  async execute(input, actor: Actor) {
    const r = await rediscoverCollaborator(actor, String(input.collaboratorId ?? ''));
    return 'refused' in r ? relay(r) : { rediscovered: true, changes: r.changes, requiresReview: r.requiresReview, status: r.collaborator.status, collaborator: r.collaborator };
  },
};

export const collaboratorSetEndpointTool: WorkspaceActionTool = {
  definition: {
    name: 'collaborator_set_endpoint',
    description: 'Move an external agent to a new endpoint URL, then rediscover it. Preview → confirm.',
    input_schema: { type: 'object', properties: { collaboratorId: { type: 'string' }, endpointUrl: { type: 'string', maxLength: 2000 }, confirmationId: { type: 'string' } }, required: ['collaboratorId', 'endpointUrl'] },
  },
  permission: 'collaborators:update',
  mutating: true,
  steward: 'caio',
  async preview(input, actor: Actor) {
    const current = await getCollaborator(actor, String(input.collaboratorId ?? ''));
    if ('refused' in current) throw PreviewRefused.from(current);
    return { collaborator: { id: current.collaborator.id, name: current.collaborator.name }, from: current.collaborator.endpointHost, to: input.endpointUrl };
  },
  async execute(input, actor: Actor) {
    const r = await setCollaboratorEndpoint(actor, String(input.collaboratorId ?? ''), String(input.endpointUrl ?? ''));
    return 'refused' in r ? relay(r) : { moved: true, changes: r.changes, requiresReview: r.requiresReview, collaborator: r.collaborator };
  },
};

export const collaboratorArchiveTool: WorkspaceActionTool = {
  definition: {
    name: 'collaborator_archive',
    description: 'Archive an external agent. Preview → confirm.',
    input_schema: { type: 'object', properties: { collaboratorId: { type: 'string' }, confirmationId: { type: 'string' } }, required: ['collaboratorId'] },
  },
  permission: 'collaborators:update',
  mutating: true,
  steward: 'caio',
  async preview(input, actor: Actor) {
    const current = await getCollaborator(actor, String(input.collaboratorId ?? ''));
    if ('refused' in current) throw PreviewRefused.from(current);
    return { collaborator: { id: current.collaborator.id, name: current.collaborator.name }, action: 'archive' };
  },
  async execute(input, actor: Actor) {
    const r = await archiveCollaborator(actor, String(input.collaboratorId ?? ''));
    return 'refused' in r ? relay(r) : { archived: true };
  },
};

export const collaborationWireTool: WorkspaceActionTool = {
  definition: {
    name: 'collaboration_wire',
    description: 'Let an agent work with an external agent: the collaborator allows the agent (with request rules; the wizard\'s defaults unless rules are given) and the agent is bound to the collaborator (a rebuild of the agent). Preview → confirm. If the result is partial, run it again: nothing is granted in that state and a re-run finishes it.',
    input_schema: {
      type: 'object',
      properties: {
        teamId: { type: 'string' },
        team: { type: 'string', maxLength: 200, description: 'Or the agent by name' },
        collaboratorId: { type: 'string' },
        rules: {
          type: 'object',
          properties: {
            read_summaries: { type: 'string', enum: ['allowed', 'approval_required', 'blocked'] },
            run_analysis: { type: 'string', enum: ['allowed', 'approval_required', 'blocked'] },
            draft_outputs: { type: 'string', enum: ['allowed', 'approval_required', 'blocked'] },
            propose_updates: { type: 'string', enum: ['allowed', 'approval_required', 'blocked'] },
          },
        },
        confirmationId: { type: 'string' },
      },
      required: ['collaboratorId'],
    },
  },
  permission: 'collaborators:update',
  mutating: true,
  steward: 'caio',
  async preview(input, actor: Actor) {
    const teamId = await resolveTeamId(actor, input);
    if (!teamId) throw new PreviewRefused('not_found', 'No team by that id or name in this workspace.');
    const team = await internalAgentService.getById(teamId, actor.tenantId);
    const collaborator = await getCollaborator(actor, String(input.collaboratorId ?? ''));
    if ('refused' in collaborator) throw PreviewRefused.from(collaborator);
    return {
      team: { id: teamId, name: team ? teamDisplayName(team) : teamId },
      collaborator: { id: collaborator.collaborator.id, name: collaborator.collaborator.name },
      rules: input.rules ?? WIZARD_DEFAULT_PERMISSIONS,
      note: 'The collaborator will allow the agent, and the agent will be rebuilt with the collaborator among its bindings.',
    };
  },
  async execute(input, actor: Actor) {
    const teamId = await resolveTeamId(actor, input);
    if (!teamId) return { refused: true, reason: 'not_found', message: 'No team by that id or name in this workspace.' };
    const rules = input.rules && typeof input.rules === 'object' ? collaboratorRequestRuleSchema.shape.permissions.parse(input.rules) : undefined;
    const r = await wireCollaboration(actor, teamId, String(input.collaboratorId ?? ''), rules);
    if ('refused' in r) return relay(r);
    if ('partial' in r) return { partial: r.partial, retry: true, message: r.message };
    return r;
  },
};

export const collaborationUnwireTool: WorkspaceActionTool = {
  definition: {
    name: 'collaboration_unwire',
    description: 'Stop an agent working with an external agent: the agent is rebuilt without the binding, then the collaborator stops allowing the agent. Preview → confirm.',
    input_schema: { type: 'object', properties: { teamId: { type: 'string' }, team: { type: 'string', maxLength: 200 }, collaboratorId: { type: 'string' }, confirmationId: { type: 'string' } }, required: ['collaboratorId'] },
  },
  permission: 'collaborators:update',
  mutating: true,
  steward: 'caio',
  async preview(input, actor: Actor) {
    const teamId = await resolveTeamId(actor, input);
    if (!teamId) throw new PreviewRefused('not_found', 'No team by that id or name in this workspace.');
    const collaborator = await getCollaborator(actor, String(input.collaboratorId ?? ''));
    if ('refused' in collaborator) throw PreviewRefused.from(collaborator);
    return { teamId, collaborator: { id: collaborator.collaborator.id, name: collaborator.collaborator.name }, action: 'unwire' };
  },
  async execute(input, actor: Actor) {
    const teamId = await resolveTeamId(actor, input);
    if (!teamId) return { refused: true, reason: 'not_found', message: 'No team by that id or name in this workspace.' };
    const r = await unwireCollaboration(actor, teamId, String(input.collaboratorId ?? ''));
    if ('refused' in r) return relay(r);
    if ('partial' in r) return { partial: r.partial, retry: true, message: r.message };
    return r;
  },
};

export const collaboratorTools: WorkspaceActionTool[] = [
  collaboratorGetTool,
  collaboratorConnectTool,
  collaboratorUpdateTool,
  collaboratorStatusTool,
  collaboratorRediscoverTool,
  collaboratorSetEndpointTool,
  collaboratorArchiveTool,
  collaborationWireTool,
  collaborationUnwireTool,
];
