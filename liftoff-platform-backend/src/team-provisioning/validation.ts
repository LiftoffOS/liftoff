// Team-preset provisioning — request validation contract.
//
// Every check is explicit; any failure returns a typed error the route maps to a
// 4xx with NO run row created. Tenant is ALWAYS the authenticated service context,
// never request data. connectorId, scopes, repos, bot_login, and escalation
// recipients are all verified against live tenant data before any agent is created.

import { withTenantScope } from '../infrastructure/database';
import { getTeamPreset } from '../agent-templates/team-preset-loader';
import { getTemplate } from '../agent-templates/loader';
import { CONNECTOR_CAPABILITIES, capabilitiesForRequirement } from '../agent-templates/connector-capabilities';
import { resolveConnectorTypes } from '../connectors/connector-service-client';
import type { TeamPreset } from '../agent-templates/team-preset-validator';

export interface ProvisionBinding {
  roleKey: string;
  connectorId: string;
  repoScope?: string[];
}

export interface ProvisionRequest {
  presetId?: string;
  idempotencyKey: string;
  bindings: ProvisionBinding[];
  escalationRecipientOverrides?: Record<string, string>;
}

export interface ValidationError {
  status: 400 | 404 | 422;
  error: string;
}

export interface ValidatedRole {
  roleKey: string;
  templateId: string;
  roleProse: string;
  connectorId: string;
  connectorType: string;
  repoScope: string[] | null;
  botLogin: string | null;
  escalationRecipient: string | null;
}

export interface ValidatedPlan {
  preset: TeamPreset;
  roles: ValidatedRole[];
}

/** A role whose distilled ambient subscription excludes the team's own events keys
 *  off the connection's bot_login. Version-control roles (github + gitlab) need it —
 *  a missing bot_login FAILS CLOSED so the team can't react to its own PRs/MRs. */
function roleNeedsBotLogin(connectorType: string): boolean {
  return connectorType === 'github' || connectorType === 'gitlab';
}

export async function validateProvisionRequest(
  tenantId: string,
  pathPresetId: string,
  req: ProvisionRequest,
): Promise<{ ok: true; plan: ValidatedPlan } | { ok: false; err: ValidationError }> {
  // IDENTITY: the path id is the SOLE preset identifier; a body presetId is accepted
  // only if it EXACTLY equals the path id.
  if (req.presetId !== undefined && req.presetId !== pathPresetId) {
    return { ok: false, err: { status: 400, error: `Body presetId "${req.presetId}" does not match path id "${pathPresetId}"` } };
  }
  const preset = getTeamPreset(pathPresetId);
  if (!preset) return { ok: false, err: { status: 404, error: `Team preset "${pathPresetId}" not found` } };

  // ROLE BINDINGS: exactly ONE binding per REQUIRED preset role — reject missing,
  // duplicate, or unknown role keys.
  const requiredKeys = new Set(preset.roles.map((r) => r.key));
  const seen = new Set<string>();
  for (const b of req.bindings) {
    if (!requiredKeys.has(b.roleKey)) {
      return { ok: false, err: { status: 422, error: `Unknown role key "${b.roleKey}"` } };
    }
    if (seen.has(b.roleKey)) {
      return { ok: false, err: { status: 422, error: `Duplicate binding for role key "${b.roleKey}"` } };
    }
    seen.add(b.roleKey);
  }
  for (const r of preset.roles) {
    if (!seen.has(r.key)) {
      return { ok: false, err: { status: 422, error: `Missing binding for required role "${r.key}"` } };
    }
  }

  // Resolve every bound connector from the connector-service — the source of truth for OAuth
  // connections. platform-backend's own `connectors` table only holds custom_mcp rows, so github/
  // gitlab connections (and their scopes/bot_login/authorized_repos binding contract) must come from
  // the service. One batched call; each role looks its connector up in the map below.
  const bindingConnectorIds = [...new Set(req.bindings.map((b) => b.connectorId))];
  let connById: Map<string, Awaited<ReturnType<typeof resolveConnectorTypes>>[number]>;
  try {
    const resolved = await resolveConnectorTypes(tenantId, bindingConnectorIds);
    connById = new Map(resolved.map((c) => [c.id, c]));
  } catch (err) {
    return { ok: false, err: { status: 422, error: `Could not resolve bound connectors: ${(err as Error).message}` } };
  }

  // Resolve each role's required connectorType + scopes from its catalog template.
  const roles: ValidatedRole[] = [];
  for (const presetRole of preset.roles) {
    const binding = req.bindings.find((b) => b.roleKey === presetRole.key)!;
    const template = getTemplate(presetRole.templateId);
    if (!template) {
      return { ok: false, err: { status: 422, error: `Role "${presetRole.key}" references unknown template "${presetRole.templateId}"` } };
    }
    // A role's required connector is either a bare connectorType OR a capability (version_control,
    // …). A capability accepts ANY connector tagged with it — github OR gitlab — each carrying its
    // own required scopes, so the SWE team stands up on whichever version-control host is connected.
    // A requirement may also name SEVERAL capabilities, any one of which does:
    // a document reaches the team as a storage file or as a workspace page.
    const requiredConnector = (template.requiredConnectors ?? []).find(
      (rc) => rc.connectorType || rc.capability || rc.capabilities?.length,
    );
    if (!requiredConnector) {
      return { ok: false, err: { status: 422, error: `Role "${presetRole.key}" template has no required connector to bind` } };
    }
    const requiredCapabilities = capabilitiesForRequirement(requiredConnector);
    // Deduplicated by type: one connector can carry two of the capabilities a
    // requirement accepts, and the first entry's scopes are the ones checked.
    const acceptableByType = new Map<string, { connectorType: string; requiredScopes: string[] }>();
    if (requiredCapabilities.length > 0) {
      for (const cap of requiredCapabilities) {
        for (const a of CONNECTOR_CAPABILITIES[cap] ?? []) {
          if (!acceptableByType.has(a.connectorType)) {
            acceptableByType.set(a.connectorType, { connectorType: a.connectorType, requiredScopes: [...a.requiredScopes] });
          }
        }
      }
    } else {
      acceptableByType.set(requiredConnector.connectorType!, {
        connectorType: requiredConnector.connectorType!,
        requiredScopes: requiredConnector.requiredScopes ?? [],
      });
    }
    const acceptable: Array<{ connectorType: string; requiredScopes: string[] }> = [...acceptableByType.values()];
    if (acceptable.length === 0) {
      return { ok: false, err: { status: 422, error: `Role "${presetRole.key}" requires ${requiredCapabilities.length > 1 ? 'one of the capabilities' : 'capability'} "${requiredCapabilities.join('", "')}" but no connector currently provides it` } };
    }

    // CONNECTOR: resolved from the connector-service, satisfies the requirement, active, has scopes.
    const conn = connById.get(binding.connectorId) ?? null;
    if (!conn) {
      return { ok: false, err: { status: 422, error: `Connector "${binding.connectorId}" (role "${presetRole.key}") not found in this workspace` } };
    }
    const match = acceptable.find((a) => a.connectorType === conn.type);
    if (!match) {
      const accepted = acceptable.map((a) => a.connectorType).join(', ');
      return { ok: false, err: { status: 422, error: `Connector "${binding.connectorId}" is "${conn.type}", role "${presetRole.key}" requires one of: ${accepted}` } };
    }
    // The bound connector's own required scopes (github repo vs gitlab api).
    const requiredType = conn.type;
    const requiredScopes = match.requiredScopes;
    // Must be the working state ('active'); a 'pending'/'error'/'disabled' connector (migration
    // 013 vocabulary) would provision a team bound to a dead connection.
    if (conn.status !== 'active') {
      return { ok: false, err: { status: 422, error: `Connector "${binding.connectorId}" (role "${presetRole.key}") is not active (status "${conn.status}")` } };
    }
    const grantedScopes = new Set(conn.scopes ?? []);
    const missingScope = requiredScopes.find((s) => !grantedScopes.has(s));
    if (missingScope) {
      return { ok: false, err: { status: 422, error: `Connector "${binding.connectorId}" is missing required scope "${missingScope}" for role "${presetRole.key}"` } };
    }

    // repoScope, if given, must be a SUBSET of the connection's authorized repositories.
    let repoScope: string[] | null = null;
    if (binding.repoScope && binding.repoScope.length > 0) {
      const authorized = conn.authorizedRepos;
      if (!Array.isArray(authorized)) {
        return { ok: false, err: { status: 422, error: `Connector "${binding.connectorId}" has no recorded authorized repositories; cannot scope role "${presetRole.key}"` } };
      }
      const authSet = new Set(authorized);
      const outside = binding.repoScope.find((repo) => !authSet.has(repo));
      if (outside) {
        return { ok: false, err: { status: 422, error: `repoScope "${outside}" (role "${presetRole.key}") is outside the connection's authorized repositories` } };
      }
      repoScope = binding.repoScope;
    }

    // SELF-EVENT EXCLUSION: a role that will exclude its own events needs bot_login.
    const botLogin = conn.botLogin ?? null;
    if (roleNeedsBotLogin(requiredType) && !botLogin) {
      return { ok: false, err: { status: 422, error: `Connector "${binding.connectorId}" has no recorded bot_login; role "${presetRole.key}" would react to its own events (fail closed)` } };
    }

    // ESCALATION RECIPIENT: preset default OR override; must be an active tenant member.
    const recipient = req.escalationRecipientOverrides?.[presetRole.key] ?? presetRole.escalationRecipient ?? null;
    if (recipient) {
      const active = await withTenantScope(tenantId, async (c) => {
        const r = await c.query(
          `SELECT 1 FROM tenant_members WHERE tenant_id = $1 AND account_id = $2`,
          [tenantId, recipient],
        );
        return r.rows.length > 0;
      });
      if (!active) {
        return { ok: false, err: { status: 422, error: `Escalation recipient "${recipient}" (role "${presetRole.key}") is not an active member of this workspace` } };
      }
    }

    roles.push({
      roleKey: presetRole.key,
      templateId: presetRole.templateId,
      roleProse: presetRole.roleProse,
      connectorId: binding.connectorId,
      connectorType: requiredType,
      repoScope,
      botLogin,
      escalationRecipient: recipient,
    });
  }

  return { ok: true, plan: { preset, roles } };
}
