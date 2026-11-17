// Team-preset provisioning — durable, idempotent, crash-recoverable orchestration.
//
// A run holds a lease and creates one agent per preset role. Per-role progress and
// agent provenance are durable, so a retry with the same idempotencyKey resumes
// without duplicating agents (the crash-safe create key is provenance existence per
// (run_id, role_key)). A failed run compensates by soft-deleting its created agents;
// compensation is idempotent so the sweep can retry it until it succeeds.

import crypto from 'crypto';
import { teamProvisioningRepository as repo, type ProvisioningRun, type RunStatus } from './repository';
import { validateProvisionRequest, type ProvisionRequest, type ValidatedRole } from './validation';
import { withTenantScope } from '../infrastructure/database';
import { internalAgentService } from '../internal-agents/service';
import type { IntegrationPermission } from '../internal-agents/types';
import { distillInternalAgent } from '../internal-agents/distill-service';
import { getTemplate } from '../agent-templates/loader';
import { log } from '../infrastructure/logging';

const LEASE_STALE_MS = 5 * 60_000;       // a lease older than this is reclaimable
const TERMINAL_DEADLINE_MS = 30 * 60_000; // pending past this with no live lease → swept
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/** Persist the bound connector as an agent integration so the role's runtime tool
 *  binding resolves github/gitlab tools — TR's buildBindingsByType reads integrations[]
 *  and returns an empty tool map when it is []. Carry the validated repoScope into the
 *  per-binding config as the repo filter TR narrows PR/MR events by (github:
 *  githubFilter.repos; gitlab: gitlabFilter.projects). Empty repoScope → no filter →
 *  the role sees every repo the connection authorizes. */
function buildRoleIntegration(role: ValidatedRole): IntegrationPermission {
  const perm: IntegrationPermission = {
    id: role.connectorId,
    type: role.connectorType,
    selectedObjects: [],
  };
  if (role.repoScope && role.repoScope.length > 0) {
    perm.config = role.connectorType === 'gitlab'
      ? { gitlabFilter: { projects: role.repoScope } }
      : { githubFilter: { repos: role.repoScope } };
  }
  return perm;
}

export interface ProvisionResult {
  runId: string;
  status: RunStatus;
  createdAgentIds: string[];
  error?: string;
}

export interface ProvisionConflict {
  status: 409;
  error: string;
}

/** Stable hash of the provision body so a retry with a DIFFERENT body is a 409, not a
 *  silent no-op. Keys are sorted; bindings are order-independent. */
function canonicalHash(req: ProvisionRequest): string {
  const canonical = {
    bindings: [...req.bindings]
      .map((b) => ({ roleKey: b.roleKey, connectorId: b.connectorId, repoScope: [...(b.repoScope ?? [])].sort() }))
      .sort((a, b) => a.roleKey.localeCompare(b.roleKey)),
    escalationRecipientOverrides: Object.fromEntries(Object.entries(req.escalationRecipientOverrides ?? {}).sort()),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** AND-combine a `sender.login != bot_login` exclusion into every connector-event
 *  subscription's filter (predicate AST), so a provisioned team never reacts to its own
 *  events. No-op when bot_login is absent or there are no connector-event subscriptions. */
function injectSelfEventExclusion(
  subs: Array<{ source?: { kind?: string }; filter?: unknown }> | undefined,
  botLogin: string | null,
): void {
  if (!botLogin || !Array.isArray(subs)) return;
  const exclusion = { op: 'ne', path: 'sender.login', value: botLogin };
  for (const sub of subs) {
    if (sub.source?.kind !== 'connector_event') continue;
    sub.filter = sub.filter
      ? { op: 'and', operands: [sub.filter, exclusion] }
      : exclusion;
  }
}

export class TeamProvisioningService {
  async provision(
    tenantId: string,
    pathPresetId: string,
    req: ProvisionRequest,
    workforcePlanId: string | null,
  ): Promise<{ result?: ProvisionResult; conflict?: ProvisionConflict }> {
    const requestHash = canonicalHash(req);

    const existing = await repo.findRun(tenantId, req.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return { conflict: { status: 409, error: 'idempotencyKey reused with a different request body' } };
      }
      // A completed run is a real idempotent success — replay it verbatim.
      if (existing.status === 'completed') {
        return { result: this.toResult(existing) };
      }
      // A failed / compensated run for the SAME request is RETRYABLE: the failure may
      // have been transient or since fixed (e.g. a connector scope / bot_login recorded
      // after the first attempt). Flip it back to pending and re-validate against live
      // data so the reconciler converges — rather than fossilizing the first error forever.
      if (existing.status === 'failed' || existing.status === 'compensated') {
        const retry = await repo.reclaimForRetry(tenantId, existing.id);
        if (!retry) {
          // A concurrent caller already reclaimed it (now pending) — treat as in-progress.
          return { conflict: { status: 409, error: 'provisioning run already in progress' } };
        }
        return { result: await this.runProvisioning(tenantId, retry, pathPresetId, req, workforcePlanId) };
      }
      // Pending: a live lease is in-progress (409); a stale lease is reclaimable.
      if (this.leaseIsLive(existing)) {
        return { conflict: { status: 409, error: 'provisioning run already in progress' } };
      }
      const reclaimed = await repo.reclaimStaleLease(tenantId, existing.id, LEASE_STALE_MS);
      if (!reclaimed) return { conflict: { status: 409, error: 'provisioning run already in progress' } };
      return { result: await this.runProvisioning(tenantId, reclaimed, pathPresetId, req, workforcePlanId) };
    }

    const { run, created } = await repo.createRun({
      tenantId, presetId: pathPresetId, idempotencyKey: req.idempotencyKey, requestHash, workforcePlanId,
    });
    if (!created) {
      // Lost the create race to a concurrent identical request — it holds the lease.
      return { conflict: { status: 409, error: 'provisioning run already in progress' } };
    }
    return { result: await this.runProvisioning(tenantId, run, pathPresetId, req, workforcePlanId) };
  }

  private leaseIsLive(run: ProvisioningRun): boolean {
    return !!run.lockedAt && Date.now() - run.lockedAt.getTime() < LEASE_STALE_MS;
  }

  private toResult(run: ProvisioningRun): ProvisionResult {
    return { runId: run.id, status: run.status, createdAgentIds: run.createdAgentIds, error: run.error ?? undefined };
  }

  private async runProvisioning(
    tenantId: string,
    run: ProvisioningRun,
    pathPresetId: string,
    req: ProvisionRequest,
    workforcePlanId: string | null,
  ): Promise<ProvisionResult> {
    // Re-validate against live tenant data — validation is the source of truth and cheap.
    const validated = await validateProvisionRequest(tenantId, pathPresetId, req);
    if (!validated.ok) {
      await repo.setRunStatus(tenantId, run.id, 'failed', { error: validated.err.error });
      return { runId: run.id, status: 'failed', createdAgentIds: [], error: validated.err.error };
    }

    const prior = new Map((await repo.listRunRoles(tenantId, run.id)).map((r) => [r.roleKey, r]));
    const createdAgentIds: string[] = [];
    try {
      for (const role of validated.plan.roles) {
        const done = prior.get(role.roleKey);
        if (done?.status === 'created' && done.agentId !== ZERO_UUID) {
          createdAgentIds.push(done.agentId); // resume: skip already-created roles
          continue;
        }
        createdAgentIds.push(await this.createOrAdoptRole(tenantId, run.id, role, workforcePlanId));
      }
      await repo.setRunStatus(tenantId, run.id, 'completed', { createdAgentIds });
      return { runId: run.id, status: 'completed', createdAgentIds };
    } catch (err) {
      const message = (err as Error).message;
      await repo.setRunStatus(tenantId, run.id, 'failed', { error: message, createdAgentIds });
      await this.compensate(tenantId, run.id); // soft-delete this run's agents
      const after = await repo.findRun(tenantId, req.idempotencyKey);
      return { runId: run.id, status: after?.status ?? 'failed', createdAgentIds, error: message };
    }
  }

  /** Create-or-adopt one role's agent. The provenance existence check is the crash-safe
   *  create key: an agent already stamped for (run, role) is ADOPTED, never re-created. */
  private async createOrAdoptRole(
    tenantId: string,
    runId: string,
    role: ValidatedRole,
    workforcePlanId: string | null,
  ): Promise<string> {
    const existingAgentId = await withTenantScope(tenantId, (c) => repo.findProvenanceInTx(c, tenantId, runId, role.roleKey));
    if (existingAgentId) {
      await repo.upsertRunRole(tenantId, { runId, roleKey: role.roleKey, agentId: existingAgentId, status: 'created' });
      return existingAgentId;
    }

    await repo.upsertRunRole(tenantId, { runId, roleKey: role.roleKey, agentId: ZERO_UUID, status: 'creating' });
    try {
      const template = getTemplate(role.templateId)!;
      const distilled = await distillInternalAgent({
        role: template.role,
        responsibilities: role.roleProse,
        integrations: [{ id: role.connectorId, name: role.connectorType, type: role.connectorType, selectedObjects: [] }],
        additionalContext: template.additionalContext ?? null,
        tenantId,
        templateId: role.templateId,
      });

      // The distilled triggerConfig carries the distill-emitted reactiveSubscriptions at
      // runtime (nested in the schema, not in the DistillTriggerConfig type). Pass it whole
      // so the ambient subscriptions persist — reconstructing a subset would drop them.
      const triggerConfig = distilled.triggerConfig as unknown as {
        type: 'cron' | 'event' | 'manual';
        cronExpr?: string; eventTopic?: string; reasoning?: string;
        reactiveSubscriptions?: Array<{ source?: { kind?: string }; filter?: unknown }>;
      };
      // Self-event exclusion: inject sender.login != bot_login into every connector-event
      // subscription so the team never reacts to its OWN PRs/commits. The value is the
      // bound connection's recorded bot_login (validated present for github); the LLM can't
      // know it, so provisioning stamps it deterministically onto the distilled subscription.
      injectSelfEventExclusion(triggerConfig.reactiveSubscriptions, role.botLogin);

      const agent = await internalAgentService.create(tenantId, {
        role: template.role,
        responsibilities: role.roleProse,
        additionalContext: template.additionalContext ?? undefined,
        // Bind the connector as an integration so the role has github/gitlab TOOLS at
        // runtime (distillation is told about the tools above, but without this the agent
        // row persists integrations=[] and TR resolves no tools — the team can't act).
        integrations: [buildRoleIntegration(role)],
        summary: distilled.summary,
        systemPrompt: distilled.systemPrompt,
        userInstructions: distilled.userInstructions,
        instructionsMd: distilled.instructionsMd ?? undefined,
        agentType: 'agent',
        triggerConfig: triggerConfig as unknown as import('../internal-agents/types').TriggerConfig,
        // Template layers are schema-validated to the memory-layer union.
        memoryScope: template.defaultMemoryScope as unknown as import('../internal-agents/types').MemoryScope,
        skills: distilled.skills,
        resultRules: distilled.resultRules,
        status: 'active',
        escalationRecipient: role.escalationRecipient ?? undefined,
        workforcePlanId: workforcePlanId ?? undefined,
        // Stamped in the SAME transaction as the agent row — the crash-safe create key.
        provenance: { provisioningRunId: runId, roleKey: role.roleKey, workforcePlanId },
      });

      await repo.upsertRunRole(tenantId, { runId, roleKey: role.roleKey, agentId: agent.id, status: 'created' });
      return agent.id;
    } catch (err) {
      await repo.upsertRunRole(tenantId, { runId, roleKey: role.roleKey, agentId: ZERO_UUID, status: 'failed', error: (err as Error).message });
      throw err;
    }
  }

  /** Soft-delete this run's created agents. Idempotent (deleting an already-gone agent is
   *  a no-op), so the sweep can retry until every role reaches 'compensated'.
   *
   *  PROVENANCE is authoritative for what was actually created: a role that crashed between the
   *  agent insert (which stamps provenance) and its run-role mark carries agent_id ZERO on the
   *  role but a real agent in provenance. Resolving the delete target from provenance when the
   *  run-role shows ZERO is what guarantees no orphaned agent (plan C2: provenance-verified). */
  private async compensate(tenantId: string, runId: string): Promise<void> {
    const roles = await repo.listRunRoles(tenantId, runId);
    const provByRole = new Map(
      (await repo.listProvenanceAgents(tenantId, runId)).map((p) => [p.roleKey, p.agentId]),
    );
    let allCompensated = true;
    for (const r of roles) {
      if (r.status === 'compensated') continue;
      const agentId = r.agentId !== ZERO_UUID ? r.agentId : (provByRole.get(r.roleKey) ?? ZERO_UUID);
      if (agentId === ZERO_UUID) {
        // Nothing was ever created for this role (no run-role agent, no provenance).
        await repo.upsertRunRole(tenantId, { runId, roleKey: r.roleKey, agentId: r.agentId, status: 'compensated', error: r.error });
        continue;
      }
      try {
        await internalAgentService.delete(agentId, tenantId, 'system:provisioning-compensation');
        await repo.upsertRunRole(tenantId, { runId, roleKey: r.roleKey, agentId, status: 'compensated' });
      } catch (err) {
        allCompensated = false;
        log.warn({ runId, roleKey: r.roleKey, err: (err as Error).message }, 'provisioning compensation step failed — sweep will retry');
      }
    }
    if (allCompensated) await repo.setRunStatus(tenantId, runId, 'compensated');
  }

  /** Sweep: compensate runs stranded 'pending' past the terminal deadline with no live
   *  lease, and alert. Called from PB's maintenance cron. */
  async sweepStrandedRuns(tenantId: string): Promise<number> {
    const stranded = await repo.findStrandedRuns(tenantId, TERMINAL_DEADLINE_MS);
    let compensated = 0;
    for (const run of stranded) {
      if (this.leaseIsLive(run)) continue; // a worker still holds it
      log.error({ runId: run.id, tenantId }, 'provisioning run stranded past terminal deadline — compensating + alerting');
      await this.compensate(tenantId, run.id);
      compensated++;
    }
    return compensated;
  }
}

export const teamProvisioningService = new TeamProvisioningService();
