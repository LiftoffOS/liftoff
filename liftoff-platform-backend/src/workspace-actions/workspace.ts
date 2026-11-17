// Workspace settings: the name, the Workspace AI vendor, the oversight
// defaults and the audit log. Each write goes through the service the
// settings page's route calls and writes the same audit row that route
// writes, under the person and their surface. Owner/admin throughout
// (workspace:rename, workspace:ai_vendor, oversight:update, audit:read).

import { TenantService } from '../tenants/service';
import { ModelRegistryService } from '../model-registry/service';
import { WORKSPACE_AI_SELECTIONS, isWorkspaceAiSelection, type WorkspaceAiSelection } from '../model-registry/workspace-ai-vendors';
import { oversightService } from '../internal-agent-oversight/service';
import type { OversightSettings, UpdateOversightSettingsInput } from '../internal-agent-oversight/types';
import { auditLogService } from '../audit-log/service';
import { ValidationError } from '../tenant-members/service';
import { requirePermission, type Actor } from './actor';
import { writeAudit } from './audit';

const tenantService = new TenantService();
const modelRegistryService = new ModelRegistryService();

export type WorkspaceRefusal = { refused: 'not_found' | 'validation' | 'enterprise_only'; message: string };

export async function getWorkspace(actor: Actor) {
  const tenant = await tenantService.getById(actor.tenantId);
  if (!tenant) return { refused: 'not_found', message: 'This workspace could not be read.' } as WorkspaceRefusal;
  return { id: tenant.id, name: tenant.name, status: tenant.status, aiVendor: await modelRegistryService.getWorkspaceVendor(actor.tenantId) };
}

export async function renameWorkspace(actor: Actor, name: string) {
  requirePermission(actor, 'workspace:rename');
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 255) {
    return { refused: 'validation', message: 'The workspace name must be between 1 and 255 characters.' } as WorkspaceRefusal;
  }
  const prior = await tenantService.getById(actor.tenantId);
  const tenant = await tenantService.updateName(actor.tenantId, trimmed);
  writeAudit(actor, 'tenant.renamed', {
    resourceType: 'tenant',
    resourceId: actor.tenantId,
    previousState: { name: prior?.name },
    newState: { name: trimmed },
  });
  return { renamed: true, previousName: prior?.name ?? null, name: tenant.name };
}

export async function getAiVendor(actor: Actor) {
  return { aiVendor: await modelRegistryService.getWorkspaceVendor(actor.tenantId), options: [...WORKSPACE_AI_SELECTIONS] };
}

export async function setAiVendor(actor: Actor, selection: string) {
  requirePermission(actor, 'workspace:ai_vendor');
  if (!isWorkspaceAiSelection(selection)) {
    return { refused: 'validation', message: `The Workspace AI vendor must be one of: ${WORKSPACE_AI_SELECTIONS.join(', ')}.` } as WorkspaceRefusal;
  }
  const prior: WorkspaceAiSelection = await modelRegistryService.getWorkspaceVendor(actor.tenantId);
  await modelRegistryService.setWorkspaceVendor(actor.tenantId, selection);
  writeAudit(actor, 'tenant.workspace_ai_changed', {
    resourceType: 'tenant',
    resourceId: actor.tenantId,
    previousState: { workspaceAiVendor: prior },
    newState: { workspaceAiVendor: selection },
  });
  return { changed: true, previousAiVendor: prior, aiVendor: selection };
}

function oversightView(s: OversightSettings) {
  return {
    version: s.currentVersion,
    autonomy: s.autonomy,
    escalation: s.escalation,
    sensitiveWork: s.sensitiveWork,
    communication: s.communication,
    updatedAt: s.updatedAt,
  };
}

export async function getOversight(actor: Actor) {
  return oversightView(await oversightService.getOrCreateOversightSettings(actor.tenantId));
}

export async function setOversight(actor: Actor, patch: UpdateOversightSettingsInput) {
  requirePermission(actor, 'oversight:update');
  const settings = await oversightService.updateOversightSettings(actor.tenantId, patch, actor.accountId);
  writeAudit(actor, 'oversight.updated', { version: settings.currentVersion, changes: patch });
  return { updated: true, ...oversightView(settings) };
}

/** The audit log is an Enterprise feature; everyone else is told so rather
 *  than shown an empty page. */
export async function readAuditLog(
  actor: Actor,
  p: { startDate?: string; endDate?: string; cursor?: string; limit?: number },
) {
  requirePermission(actor, 'audit:read');
  if (!(await auditLogService.isEnterprise(actor.tenantId))) {
    return { refused: 'enterprise_only', message: 'The audit log is part of the Enterprise plan. This workspace is not on it.' } as WorkspaceRefusal;
  }
  const endDate = p.endDate ? new Date(p.endDate) : new Date();
  const startDate = p.startDate ? new Date(p.startDate) : new Date(endDate.getTime() - 30 * 86_400_000);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return { refused: 'validation', message: 'startDate and endDate must be ISO dates.' } as WorkspaceRefusal;
  }
  try {
    const page = await auditLogService.list(actor.tenantId, startDate, endDate, { cursor: p.cursor, limit: p.limit });
    return {
      entries: page.entries,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      range: { startDate: startDate.toISOString(), endDate: endDate.toISOString() },
    };
  } catch (err) {
    if (err instanceof ValidationError) return { refused: 'validation', message: err.message } as WorkspaceRefusal;
    throw err;
  }
}
