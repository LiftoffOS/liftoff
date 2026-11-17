// Internal Agents Service
// Manages internal agent configurations (UI: "Agents")
//
// Event-publish invariant (plan §5.4 — "shape 3"): for every entity mutation
// the service exposes (create/update/updateStatus/delete/rollback), the
// internal_agents row update AND the outbox row are committed in the SAME
// transaction via mutateAndPublishEvent. After commit the service publishes
// the outbox row inline. If the user got a 2xx from the request handler, the
// outbox row exists in PB — there is no cross-tx atomicity gap.
//
// Side effects that are not load-bearing for the entity state (audit log,
// idempotency-key write, slack-app upsert, capability re-embedding, workflow-
// visualization regeneration) stay OUTSIDE the tx as post-commit best-effort
// work. Their failure does not invalidate the entity write or the published
// event.

import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { pool, withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { distillInputFingerprint } from './distill-input-fingerprint';
import { DEFAULT_MEMORY_SCOPE, normalizeMemoryScope } from './memory-scope';
import { withNormalizedTier } from '../llm/types';
import { normalizeEscalationRecipient } from '../notifications/escalation-recipient';
import {
  InternalAgent,
  InternalAgentStatus,
  CreateInternalAgentInput,
  UpdateInternalAgentInput,
  PaginatedInternalAgentsResponse,
  IntegrationPermission,
  InternalAgentVersion,
  VersionSource,
  AgentType,
  ModelConfig,
  MemoryScope,
  ExecConfig,
  WorkflowStep,
  TriggerConfig,
  WorkflowVisualizationStep,
  Skill,
  CapabilityTier,
  TeamAttachment,
} from './types';
import type { AutonomyLevel } from '../internal-agent-oversight/types';
import {
  effectiveModelConfig,
  type WorkspaceAiSelection,
} from '../model-registry/workspace-ai-vendors';
import { getDefaultHitlLevel, resolveAgentHitlLevel } from '../internal-agent-oversight/types';
import { oversightService } from '../internal-agent-oversight/service';
import { mutateAndPublishEvent } from '../events/publisher';
import { enqueueInternalAgentOutbox, publishOutboxRowInline, type OutboxRowRef } from './outbox';
import { validateRuntimeConfigUpdatedPayload } from './runtime-config-validator';
import { buildInternalAgentEventPayload } from './event-payload';
import { mergeSkillsByProvenance } from './skill-provenance';
import { mapInternalAgentRow } from './row-mapper';
import { templateSourceHash } from './template-provenance';

// Minimal Querier shape — pool or PoolClient. Both expose .query().
type Querier = { query: PoolClient['query'] };
import { TenantRepository } from '../tenants/repository';
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import { getAllAgentsCosts, getAgentCostSummary } from '../cost-attribution/attribution-service';
import { generateWorkflowVisualizationSteps } from './workflow-visualization-steps-service';
import { assertWorkflowStepsExecutable, eventSourcesForAgent } from './workflow-steps-executable';

const tenantRepository = new TenantRepository();

export class InternalAgentService {
  // List internal agents with pagination (BE-001)
  async listByTenant(
    tenantId: string,
    options?: { cursor?: string; limit?: number; status?: InternalAgentStatus }
  ): Promise<PaginatedInternalAgentsResponse> {
    const limit = Math.min(options?.limit || 20, 100);
    const status = options?.status;

    let query = `
      SELECT *, COUNT(*) OVER() as total_count
      FROM internal_agents
      WHERE tenant_id = $1 AND deleted_at IS NULL
    `;
    const params: (string | number)[] = [tenantId];
    let paramIndex = 2;

    if (status) {
      query += ` AND status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (options?.cursor) {
      query += ` AND created_at < $${paramIndex}`;
      params.push(options.cursor);
      paramIndex++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex}`;
    params.push(limit + 1); // Fetch one extra to check if there are more

    const result = await withTenantScope(tenantId, (client) => client.query(query, params));
    const rows = result.rows;

    const hasMore = rows.length > limit;
    const internalAgents = rows.slice(0, limit).map(row => this.mapInternalAgent(row));
    const total = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const until = new Date();
    try {
      const agentCosts = await getAllAgentsCosts(tenantId, since, until);
      const costMap = new Map(agentCosts.map(c => [c.agentId, c]));
      for (const agent of internalAgents) {
        const cost = costMap.get(agent.id);
        if (cost) {
          agent.monthlyCost = cost.totalCostUsd;
          agent.tasks30d = cost.invocationCount;
        }
      }
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'cost-attribution: failed to fetch cost summary for agent list');
    }

    return {
      internalAgents,
      cursor: hasMore && internalAgents.length > 0 ? internalAgents[internalAgents.length - 1].createdAt.toISOString() : null,
      hasMore,
      total,
    };
  }

  /** Unpaginated variant for internal aggregation — do not expose on the public paginated API. Hard cap 500.
   *  `includeCosts: false` skips the 30-day cost-attribution rollup for callers that only need the
   *  roster, which would otherwise pay for a join they never read. */
  async listAllByTenant(
    tenantId: string,
    options?: { includeCosts?: boolean },
  ): Promise<InternalAgent[]> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM internal_agents
       WHERE tenant_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 500`,
      [tenantId],
    ));
    const agents = result.rows.map(row => this.mapInternalAgent(row));

    if (options?.includeCosts === false) {
      return agents;
    }

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const until = new Date();
    try {
      const agentCosts = await getAllAgentsCosts(tenantId, since, until);
      const costMap = new Map(agentCosts.map(c => [c.agentId, c]));
      for (const agent of agents) {
        const cost = costMap.get(agent.id);
        if (cost) {
          agent.monthlyCost = cost.totalCostUsd;
          agent.tasks30d = cost.invocationCount;
        }
      }
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'cost-attribution: failed to fetch cost summary for agent list');
    }
    return agents;
  }

  // Get a single internal agent by ID
  async getById(internalAgentId: string, tenantId: string): Promise<InternalAgent | null> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM internal_agents WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [internalAgentId, tenantId]
    ));

    if (result.rows.length === 0) {
      return null;
    }

    const agent = this.mapInternalAgent(result.rows[0]);

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const until = new Date();
    try {
      const costSummary = await getAgentCostSummary(tenantId, agent.id, since, until);
      agent.monthlyCost = costSummary.totalCostUsd;
      agent.tasks30d = costSummary.totalInvocations;
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'cost-attribution: failed to fetch cost summary for agent list');
    }

    return agent;
  }

  // Create a new internal agent with idempotency (DE-001)
  async create(
    tenantId: string,
    input: CreateInternalAgentInput,
    idempotencyKey?: string,
    actorId?: string,
    source: VersionSource = 'create'
  ): Promise<InternalAgent> {
    // Check for existing idempotency key (if provided)
    if (idempotencyKey) {
      const existingKey = await withTenantScope(tenantId, (client) => client.query(
        `SELECT response FROM internal_agent_idempotency_keys WHERE key = $1::varchar AND tenant_id = $2 AND expires_at > NOW()`,
        [idempotencyKey, tenantId]
      ));

      if (existingKey.rows.length > 0) {
        log.info({ idempotencyKey }, 'Returning cached internal agent from idempotency key');
        return existingKey.rows[0].response as InternalAgent;
      }
    }

    // Resolve the template's placeholders into the text this row will STORE.
    //
    // Deliberately here rather than in the route. There are four callers of
    // create(): the UI hire, the HRBP's teambuilder__create, team provisioning
    // and the provisioning helper. Resolving in one route left the other three
    // writing raw `{{pick:...}}` and `{{connector:...}}` into an agent's
    // responsibilities — the same defect, reachable by a different door. The
    // text an agent stores is this layer's concern, so the guarantee belongs
    // at this layer.
    if (input.templateId) {
      // A required connector must actually be bound before this team runs. The
      // guarantee belongs at this layer for the same reason placeholder
      // resolution does: four callers reach create(), and a check in one route
      // leaves the other three able to hire a team with nothing to work with.
      const { getTemplate } = await import('../agent-templates/loader');
      const tmpl = getTemplate(input.templateId);
      if (tmpl) {
        const { assertRequiredConnectorsBound } = await import('./required-connector-guard');
        const { connectorTypesForRequirement } = await import('../agent-templates/connector-capabilities');
        assertRequiredConnectorsBound({
          template: tmpl,
          bindings: (input.integrations ?? []) as Array<{ type?: string; integrationId?: string }>,
          status: input.status,
          connectorTypesFor: connectorTypesForRequirement,
        });
      }

      const { resolveTemplatePlaceholders } = await import('./template-placeholders');
      const resolved = resolveTemplatePlaceholders(
        input.templateId,
        { responsibilities: input.responsibilities, additionalContext: input.additionalContext ?? undefined },
        input.templatePicks,
        // `integrationId` is the connector TYPE; the row id is the connection.
        new Set(
          (input.integrations ?? [])
            .map((i) => (i as { integrationId?: string }).integrationId)
            .filter((t): t is string => !!t),
        ),
      );
      input = { ...input, responsibilities: resolved.responsibilities, additionalContext: resolved.additionalContext };
    }

    // Canonical shape-3 (plan §5.4): INSERT internal_agents + (optional)
    // pinWorkflowIntegrity UPDATE + createVersion INSERT + outbox enqueue are
    // committed atomically. publishOutboxRowInline runs post-commit and never
    // throws — failures leave the outbox row pending for the worker.
    const internalAgent = await mutateAndPublishEvent<InternalAgent>(
      { caller: 'InternalAgentService.create', actor: actorId, reason: 'create internal_agent + tenant.internal_agent.created event' },
      async (client) => {
        // Caller's resolved capability tier (defaults to 'connector_only').
        // Used in both the INSERT and the derived sandbox_capabilities below.
        const resolvedCapabilityTier = input.capabilityTier ?? 'connector_only';
        // sandbox_capabilities mirrors capability_tier on the create path
        // for the same reason update() does on the update path: the table
        // default (`{shell,file,browser,vscode}` from migration 264) would
        // otherwise stick to every new connector_only agent, leaving the
        // caps-gated consumers (autonomous tool catalog) thinking the agent
        // has full sandbox access while the tier-gated consumers (interactive
        // chat) correctly hide code tools. See the matching block in update()
        // for the full context.
        const insertedSandboxCapabilities =
          resolvedCapabilityTier === 'execution_enabled'
            ? ['shell', 'file', 'browser', 'vscode']
            : [];
        const inserted = await client.query(
          `INSERT INTO internal_agents (tenant_id, role, responsibilities, integrations, pending_integrations, additional_context, summary, system_prompt, user_instructions, temperature, status, current_version,
            agent_type, model_config, memory_scope, exec_config, workflow_steps, trigger_config, instructions_md, pinned_knowledge_ids,
            skills, capability_tier, sandbox_capabilities, attachments, result_rules, template_id, template_source_hash,
            tool_description_overrides, decision_record, grounds_on, capability_states)
           VALUES ($1, $2::varchar, $3, $4, $5, $6, $7, $8, $9, $10, $11::varchar, 1, $12::varchar, $13, $14, $15, $16, $17, $18, $19, $20, $21::varchar, $22::text[], $23, $24::jsonb, $25, $26, $27::jsonb, $28::jsonb, $29::jsonb, $30::jsonb)
           RETURNING *`,
          [
            tenantId,
            input.role,
            input.responsibilities || null,
            JSON.stringify(input.integrations || []),
            JSON.stringify(input.pendingIntegrations || []),
            input.additionalContext || null,
            input.summary || null,
            input.systemPrompt || null,
            input.userInstructions || null,
            input.temperature ?? 0.3,
            input.status || 'draft',
            input.agentType || 'agent',
            // Tier policy: every agent gets tier='medium' unless an admin
            // caller explicitly overrides. Defense-in-depth — the router's
            // Zod gate is the first line; this spread guards against
            // non-router callers reaching the service layer without
            // modelConfig.
            JSON.stringify({ tier: 'medium' as const, ...input.modelConfig }),
            // The shared constant, in the ONE spelling every reader uses. This
            // wrote snake_case, which nothing reads: the type, the router's Zod
            // gate, the template catalog and both runtimes are all camelCase, so
            // every agent created here got a scope the tenant runtime could not
            // see and silently fell back to a hard-coded list. See
            // memory-scope.ts.
            JSON.stringify(input.memoryScope ?? DEFAULT_MEMORY_SCOPE),
            JSON.stringify(input.execConfig || {}),
            input.workflowSteps ? JSON.stringify(input.workflowSteps) : null,
            input.triggerConfig ? JSON.stringify(input.triggerConfig) : null,
            input.instructionsMd ?? null,
            input.pinnedKnowledgeIds ?? [],
            JSON.stringify(input.skills ?? []),
            resolvedCapabilityTier,
            insertedSandboxCapabilities,
            JSON.stringify(input.attachments ?? []),
            JSON.stringify(input.resultRules ?? []),
            input.templateId || null,
            // The authored text as this hire created it. A redistill compares
            // the row against this before reusing the template id: equal means
            // the text is still the template's, different means the owner has
            // edited the agent and it is theirs to keep.
            //
            // `templateTextEdited` records NO baseline, and that is the whole
            // point of it existing. Text rewritten on the explore detail step
            // arrives here already changed, so fingerprinting it would make it
            // its own baseline — permanently equal to itself, so every later
            // redistill would treat their wording as the template's and pull it
            // back toward ours. A null hash means what it has always meant:
            // this text is the owner's, seed nothing from the catalog.
            input.templateId && !input.templateTextEdited
              ? templateSourceHash(input.responsibilities, input.additionalContext)
              : null,
            JSON.stringify(input.toolDescriptionOverrides ?? {}),
            JSON.stringify(input.decisionRecord ?? {}),
            JSON.stringify(input.groundsOn ?? []),
            JSON.stringify(input.capabilityStates ?? {}),
          ],
        );
        let agent = this.mapInternalAgent(inserted.rows[0]);

        // Team-preset provisioning: stamp the escalation recipient + agent provenance
        // in the SAME transaction as the agent row, so a crash never leaves an agent
        // without provenance (which the crash-safe create key relies on).
        if (input.escalationRecipient) {
          // Stored in the documented selector form. Provisioning validates the
          // value as a bare accounts.id, which matches none of the prefixes the
          // consumers parse — storing it raw is what made escalations resolve
          // to nobody.
          const recipient = normalizeEscalationRecipient(input.escalationRecipient);
          if (recipient) {
            await client.query(
              `UPDATE internal_agents SET escalation_recipient = $3 WHERE id = $1 AND tenant_id = $2`,
              [agent.id, tenantId, recipient],
            );
          } else {
            log.warn('ignoring unrecognised escalation recipient', {
              tenantId, agentId: agent.id, value: input.escalationRecipient,
            });
          }
        }
        if (input.provenance) {
          await client.query(
            `INSERT INTO internal_agent_provenance (agent_id, tenant_id, provisioning_run_id, role_key, workforce_plan_id)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (agent_id) DO NOTHING`,
            [agent.id, tenantId, input.provenance.provisioningRunId, input.provenance.roleKey, input.provenance.workforcePlanId ?? null],
          );
        }

        // Pin workflow integrity inline so the version-history row + event
        // payload reflect the post-pin state.
        if (input.workflowSteps && input.workflowSteps.length > 0) {
          // Refuse to store a workflow the runtime cannot run. The distiller
          // validates its own output; every other writer reaching this method
          // did not, which is how typeless steps were persisted.
          assertWorkflowStepsExecutable(
            input.workflowSteps,
            eventSourcesForAgent(input.triggerConfig, input.integrations),
          );
          await this.pinWorkflowIntegrity(
            agent.id,
            tenantId,
            input.workflowSteps,
            'system:platform-backend',
            client,
          );
          const refreshed = await client.query(
            `SELECT * FROM internal_agents WHERE id = $1 AND tenant_id = $2`,
            [agent.id, tenantId],
          );
          if (refreshed.rows.length > 0) {
            agent = this.mapInternalAgent(refreshed.rows[0]);
          }
        }

        // Initial version row in the same tx — the entity's version history
        // is part of its canonical state.
        await this.createVersion(agent, source, actorId, client);

        // Build the event payload from the post-pin agent state and enqueue
        // the outbox row in the same tx.
        const payload = await buildInternalAgentEventPayload(agent, 'tenant.internal_agent.created', { actorId });
        return {
          entity: agent,
          eventInput: {
            entityType: 'internal_agent',
            entityId: agent.id,
            eventType: 'tenant.internal_agent.created',
            entityVersion: agent.currentVersion,
            eventVersion: 1,
            tenantId,
            payload,
          },
        };
      },
    );

    // Generate display-only workflow visualization steps for AgentWorkflowViz UI (fire-and-forget)
    generateWorkflowVisualizationSteps(
      internalAgent.id, tenantId, input.role,
      input.systemPrompt ?? null, input.userInstructions ?? null,
      // The graph, so the diagram describes it rather than imagining it.
      input.workflowSteps ?? null,
    ).catch(err => log.warn({ err, agentId: internalAgent.id }, 'generateWorkflowVisualizationSteps failed'));

    // Store idempotency key (24h TTL) if provided
    if (idempotencyKey) {
      await withTenantScope(tenantId, (client) => client.query(
        `INSERT INTO internal_agent_idempotency_keys (key, tenant_id, internal_agent_id, response, expires_at)
         VALUES ($1::varchar, $2, $3, $4, NOW() + INTERVAL '24 hours')`,
        [idempotencyKey, tenantId, internalAgent.id, JSON.stringify(internalAgent)]
      ));
    }

    // Log audit (DE-004)
    await this.logAudit(internalAgent.id, tenantId, 'created', { ...input, workflowStepsHash: internalAgent.workflowStepsHash }, actorId);

    // Mark tenant as having created an internal agent (for onboarding UX)
    await tenantRepository.markHasCreatedInternalAgent(tenantId);

    // Per-agent Slack app creation is retired (ADR-040): agents reach Slack
    // through the single Liftoff workspace app, so no per-agent app is minted
    // here. Existing agents' apps are still maintained by the update/delete
    // hooks below until the per-agent tables are cleaned up.

    log.info({ internalAgentId: internalAgent.id, tenantId, version: 1, agentType: input.agentType || 'agent' }, 'Internal agent created');

    // Generate capability embedding for semantic find_teammates search (fire-and-forget)
    import('./embedding-service').then(({ generateAndStoreEmbedding }) => {
      generateAndStoreEmbedding(internalAgent.id, tenantId).catch((err: Error) =>
        log.error({ internalAgentId: internalAgent.id, error: err.message }, 'Capability embedding failed (non-blocking)'));
    }).catch(() => {});

    return internalAgent;
  }

  // Update an internal agent
  async update(
    internalAgentId: string,
    tenantId: string,
    input: UpdateInternalAgentInput,
    actorId?: string,
    source: VersionSource = 'manual'
  ): Promise<InternalAgent | null> {
    // Get current state for audit
    const current = await this.getById(internalAgentId, tenantId);
    if (!current) {
      return null;
    }

    // Skill provenance merge (P1.0). Every writer of `skills` funnels through
    // here — redistill (source='distill'), the PUT edit / distill-then-save
    // path, and the skill steering verbs — so this one seam is what stops a
    // redistill from discarding skills the reflection flywheel or a human
    // authored. `source` identifies the caller: only a distill re-authors the
    // distilled slice; everything else is an operator edit.
    //
    // `input` is REBOUND to a copy carrying the merged set, because every
    // downstream consumer in this method (the SET clause, the version snapshot,
    // the event payload) reads `input.skills` and must see the merge. A copy
    // rather than a mutation so the caller's object is left alone.
    if (input.skills !== undefined) {
      const merged = await mergeSkillsByProvenance(
        current.skills ?? [],
        input.skills,
        {
          incomingProvenance: source === 'distill' ? 'distilled' : 'operator',
          tenantId,
          agentId: internalAgentId,
        },
      );
      input = { ...input, skills: merged.skills };
      log.info(
        { internalAgentId, tenantId, source, ...merged.stats },
        'internal-agents: skill provenance merge applied',
      );
    }

    const updates: string[] = [];
    const params: (string | number | null | string[])[] = [];
    let paramIndex = 1;

    // Track if versioned fields changed (includes runtime config fields per plan)
    const versionedFieldsChanged =
      (input.role !== undefined && input.role !== current.role) ||
      (input.responsibilities !== undefined && input.responsibilities !== current.responsibilities) ||
      (input.integrations !== undefined && JSON.stringify(input.integrations) !== JSON.stringify(current.integrations)) ||
      (input.pendingIntegrations !== undefined && JSON.stringify(input.pendingIntegrations) !== JSON.stringify(current.pendingIntegrations)) ||
      (input.additionalContext !== undefined && input.additionalContext !== current.additionalContext) ||
      (input.systemPrompt !== undefined && input.systemPrompt !== current.systemPrompt) ||
      (input.userInstructions !== undefined && input.userInstructions !== current.userInstructions) ||
      (input.instructionsMd !== undefined && input.instructionsMd !== current.instructionsMd) ||
      // Runtime config fields also trigger versioning
      (input.agentType !== undefined && input.agentType !== current.agentType) ||
      (input.modelConfig !== undefined && JSON.stringify(input.modelConfig) !== JSON.stringify(current.modelConfig)) ||
      (input.memoryScope !== undefined && JSON.stringify(input.memoryScope) !== JSON.stringify(current.memoryScope)) ||
      (input.execConfig !== undefined && JSON.stringify(input.execConfig) !== JSON.stringify(current.execConfig)) ||
      (input.workflowSteps !== undefined && JSON.stringify(input.workflowSteps) !== JSON.stringify(current.workflowSteps)) ||
      (input.triggerConfig !== undefined && JSON.stringify(input.triggerConfig) !== JSON.stringify(current.triggerConfig)) ||
      (input.autonomyOverride !== undefined && input.autonomyOverride !== current.autonomyOverride) ||
      (input.aiVendorOverride !== undefined && input.aiVendorOverride !== current.aiVendorOverride) ||
      (input.pinnedKnowledgeIds !== undefined &&
        JSON.stringify(input.pinnedKnowledgeIds) !== JSON.stringify(current.pinnedKnowledgeIds)) ||
      (input.skills !== undefined && JSON.stringify(input.skills) !== JSON.stringify(current.skills)) ||
      (input.capabilityTier !== undefined && input.capabilityTier !== current.capabilityTier) ||
      (input.resultRules !== undefined && JSON.stringify(input.resultRules) !== JSON.stringify(current.resultRules)) ||
      (input.attachments !== undefined && JSON.stringify(input.attachments) !== JSON.stringify(current.attachments));

    // Track if runtime config specifically changed (for event publishing).
    // capabilityTier is included so the runtime can re-evaluate gate decisions
    // via the secondary runtime_config_updated event without waiting for the
    // primary `updated` envelope. skills stays OUT — it's behavioral and rides
    // through the primary envelope (which the runtime already processes).
    // aiVendorOverride IS in: it changes the provider/model the payload stamps
    // (event-payload.ts), and leaving it out would persist the override while
    // the runtime kept re-resolving the old route — a second dead switch one
    // layer below the one this feature exists to fix.
    // autonomyOverride IS in, for exactly that reason one layer further down.
    // The runtime_config_updated payload resolves hitlLevel from it, and that
    // publish is the ONLY carrier of the override into the runtime — TR never
    // reads autonomy_override itself. Omitting it here meant an autonomy-only
    // save (the common case: an operator tightening one team on
    // /dashboard/agents/update, touching nothing else) failed this predicate,
    // skipped the publish entirely, and left agents.hitl_level stale until some
    // unrelated later edit happened to touch one of the other fields. The
    // attended surfaces hid it because chat/A2A/MCP/workflow steps re-resolve
    // the level per request in this repo; the unattended ones — scheduled runs,
    // cron, event triggers, inbound webhooks, reactive subscriptions — read the
    // stale runtime column and silently kept the old autonomy.
    const runtimeConfigChanged =
      (input.agentType !== undefined && input.agentType !== current.agentType) ||
      (input.modelConfig !== undefined && JSON.stringify(input.modelConfig) !== JSON.stringify(current.modelConfig)) ||
      (input.memoryScope !== undefined && JSON.stringify(input.memoryScope) !== JSON.stringify(current.memoryScope)) ||
      (input.execConfig !== undefined && JSON.stringify(input.execConfig) !== JSON.stringify(current.execConfig)) ||
      (input.aiVendorOverride !== undefined && input.aiVendorOverride !== current.aiVendorOverride) ||
      (input.autonomyOverride !== undefined && input.autonomyOverride !== current.autonomyOverride) ||
      (input.capabilityTier !== undefined && input.capabilityTier !== current.capabilityTier);
    // resultRules is deliberately NOT here. The secondary runtime_config_updated
    // event does not carry it and the runtime does not recompile an instruction
    // from that event — it recompiles from the primary `updated` envelope, which
    // fires on every save. Adding it would emit a second event whose payload
    // says nothing about what changed.

    if (input.role !== undefined) {
      updates.push(`role = $${paramIndex}::varchar`);
      params.push(input.role);
      paramIndex++;
    }
    if (input.responsibilities !== undefined) {
      updates.push(`responsibilities = $${paramIndex}`);
      params.push(input.responsibilities);
      paramIndex++;
    }
    if (input.integrations !== undefined) {
      updates.push(`integrations = $${paramIndex}`);
      params.push(JSON.stringify(input.integrations));
      paramIndex++;
    }
    if (input.pendingIntegrations !== undefined) {
      updates.push(`pending_integrations = $${paramIndex}::jsonb`);
      params.push(JSON.stringify(input.pendingIntegrations));
      paramIndex++;
    }
    if (input.additionalContext !== undefined) {
      updates.push(`additional_context = $${paramIndex}`);
      params.push(input.additionalContext);
      paramIndex++;
    }
    if (input.summary !== undefined) {
      updates.push(`summary = $${paramIndex}`);
      params.push(input.summary);
      paramIndex++;
    }
    if (input.systemPrompt !== undefined) {
      updates.push(`system_prompt = $${paramIndex}`);
      params.push(input.systemPrompt);
      paramIndex++;
    }
    if (input.userInstructions !== undefined) {
      updates.push(`user_instructions = $${paramIndex}`);
      params.push(input.userInstructions);
      paramIndex++;
    }
    if (input.instructionsMd !== undefined) {
      updates.push(`instructions_md = $${paramIndex}`);
      params.push(input.instructionsMd);
      paramIndex++;
    }
    if (input.temperature !== undefined) {
      updates.push(`temperature = $${paramIndex}`);
      params.push(input.temperature);
      paramIndex++;
    }
    if (input.messagingNickname !== undefined) {
      // Validate uniqueness within the tenant, case-INSENSITIVELY. Nicknames
      // are how people address a teammate ("Sarah: take a look"), and that
      // lookup is case-insensitive, so "Sarah" and "sarah" coexisting would
      // make addressing ambiguous with no way for the sender to tell which
      // one answered. The check-nickname endpoint uses the same comparison,
      // so the UI never reports available for a name that then 409s.
      const nicknameConflict = await withTenantScope(tenantId, (client) => client.query(
        `SELECT id FROM internal_agents
         WHERE tenant_id = $1 AND LOWER(messaging_nickname) = LOWER($2)
           AND id != $3 AND deleted_at IS NULL`,
        [tenantId, input.messagingNickname, internalAgentId],
      ));
      if (nicknameConflict.rows.length > 0) {
        const error = new Error('This nickname is already used by another team member');
        (error as any).code = 'NICKNAME_CONFLICT';
        (error as any).statusCode = 409;
        throw error;
      }
      updates.push(`messaging_nickname = $${paramIndex}`);
      params.push(input.messagingNickname);
      paramIndex++;
    }
    // Runtime config fields
    if (input.agentType !== undefined) {
      updates.push(`agent_type = $${paramIndex}::varchar`);
      params.push(input.agentType);
      paramIndex++;
    }
    if (input.modelConfig !== undefined) {
      updates.push(`model_config = $${paramIndex}`);
      params.push(JSON.stringify(input.modelConfig));
      paramIndex++;
    }
    if (input.memoryScope !== undefined) {
      updates.push(`memory_scope = $${paramIndex}`);
      params.push(JSON.stringify(input.memoryScope));
      paramIndex++;
    }
    if (input.execConfig !== undefined) {
      updates.push(`exec_config = $${paramIndex}`);
      params.push(JSON.stringify(input.execConfig));
      paramIndex++;
    }
    if (input.workflowSteps !== undefined) {
      updates.push(`workflow_steps = $${paramIndex}`);
      params.push(input.workflowSteps ? JSON.stringify(input.workflowSteps) : null);
      paramIndex++;

      // Stamp what this graph was built from, in the SAME statement that writes
      // it. Two writes could not both fail, and a graph whose provenance went
      // missing is exactly the state the sweep cannot interpret.
      //
      // Written here rather than in the distiller because this is the only
      // place a graph reaches the column — every writer passes through it, so
      // no future caller can persist steps without provenance.
      //
      // The inputs are taken from the merged post-update view: `input` when the
      // caller supplied a field, `current` otherwise. A redistill that rewrites
      // the graph while leaving `responsibilities` alone must fingerprint the
      // responsibilities the graph was actually built from, which are the
      // existing ones.
      updates.push(`distill_input_fingerprint = $${paramIndex}`);
      params.push(input.workflowSteps
        ? distillInputFingerprint({
          role: input.role ?? current.role ?? '',
          responsibilities: input.responsibilities ?? current.responsibilities ?? '',
          integrationTypes: (input.integrations ?? current.integrations ?? [])
            .map((i) => (i as { type?: string; integrationId?: string }).type
              ?? (i as { integrationId?: string }).integrationId ?? ''),
        })
        : null);
      paramIndex++;
    }
    if (input.triggerConfig !== undefined) {
      updates.push(`trigger_config = $${paramIndex}`);
      params.push(input.triggerConfig ? JSON.stringify(input.triggerConfig) : null);
      paramIndex++;
    }
    if (input.autonomyOverride !== undefined) {
      updates.push(`autonomy_override = $${paramIndex}`);
      params.push(input.autonomyOverride);
      paramIndex++;
    }
    // null is a real value here (clear the override, back to inherit), which is
    // why the guard is `!== undefined` rather than a truthiness check.
    if (input.aiVendorOverride !== undefined) {
      updates.push(`ai_vendor_override = $${paramIndex}::varchar`);
      params.push(input.aiVendorOverride);
      paramIndex++;
    }
    if (input.pinnedKnowledgeIds !== undefined) {
      updates.push(`pinned_knowledge_ids = $${paramIndex}`);
      params.push(input.pinnedKnowledgeIds);
      paramIndex++;
    }
    if (input.skills !== undefined) {
      updates.push(`skills = $${paramIndex}`);
      params.push(JSON.stringify(input.skills));
      paramIndex++;
    }
    if (input.attachments !== undefined) {
      updates.push(`attachments = $${paramIndex}`);
      params.push(JSON.stringify(input.attachments));
      paramIndex++;
    }
    if (input.resultRules !== undefined) {
      // Full-list replace: `[]` clears, absent leaves alone. The rules describe
      // the workflow the same distillation produced, so a redistill that names
      // no tool must be able to retire the previous run's policy.
      updates.push(`result_rules = $${paramIndex}::jsonb`);
      params.push(JSON.stringify(input.resultRules));
      paramIndex++;
    }
    if (input.toolDescriptionOverrides !== undefined) {
      // Full-map replace, same reasoning as resultRules above: the overrides
      // describe the tools THIS distillation reasoned about, so a redistill
      // that names none must be able to retire the previous run's rules.
      // Provenance merging happens before this point, in the redistill path.
      updates.push(`tool_description_overrides = $${paramIndex}::jsonb`);
      params.push(JSON.stringify(input.toolDescriptionOverrides));
      paramIndex++;
    }
    if (input.decisionRecord !== undefined) {
      updates.push(`decision_record = $${paramIndex}::jsonb`);
      params.push(JSON.stringify(input.decisionRecord));
      paramIndex++;
    }
    if (input.capabilityStates !== undefined) {
      updates.push(`capability_states = $${paramIndex}::jsonb`);
      params.push(JSON.stringify(input.capabilityStates));
      paramIndex++;
    }
    if (input.groundsOn !== undefined) {
      // Full-list replace, same as resultRules: the rules describe the tools
      // THIS distillation saw bound, so a redistill that derives none must be
      // able to retire the previous run's.
      updates.push(`grounds_on = $${paramIndex}::jsonb`);
      params.push(JSON.stringify(input.groundsOn));
      paramIndex++;
    }
    if (input.capabilityTier !== undefined) {
      updates.push(`capability_tier = $${paramIndex}::varchar`);
      params.push(input.capabilityTier);
      paramIndex++;
      // Keep sandbox_capabilities in lockstep with capability_tier on every
      // write. Same mapping as migration 264 (execution_enabled → all four
      // capability families; connector_only → empty array), now enforced
      // per-update instead of once-at-migration. Without this sync, any
      // caller that changes the tier silently leaves a stale caps array
      // behind, splitting downstream gating across the two signals:
      // tier-gated consumers (chat-turn-handler at chat-turn-handler.ts:741)
      // make one decision while caps-gated consumers (the autonomous tool
      // catalog at service.ts:2849 in tenant-runtime, post-Fix A) make
      // another. For example, a redistill that demotes tier from
      // execution_enabled to connector_only would leave caps at {shell,file,
      // browser,vscode} if update() didn't touch caps: the agent's interactive
      // chat correctly hides code tools (tier-based check), but its autonomous
      // path still sees them (caps-based check). Same fix needs to mirror in
      // create() below — the table default is {shell,file,browser,vscode}, so
      // a connector_only agent inserted without explicit caps would start
      // with the wrong array.
      updates.push(`sandbox_capabilities = $${paramIndex}::text[]`);
      params.push(
        input.capabilityTier === 'execution_enabled'
          ? ['shell', 'file', 'browser', 'vscode']
          : [],
      );
      paramIndex++;
    }

    if (updates.length === 0) {
      return current;
    }

    // Increment version if versioned fields changed
    let newVersion = current.currentVersion;
    if (versionedFieldsChanged) {
      newVersion = current.currentVersion + 1;
      updates.push(`current_version = $${paramIndex}`);
      params.push(newVersion);
      paramIndex++;
    }

    updates.push(`updated_at = NOW()`);

    // Canonical shape-3: the UPDATE, workflow re-pinning, version-history
    // INSERT, and outbox enqueue commit in the same tx. Inline publish runs
    // post-commit; failures leave the outbox row pending for the worker.
    const workflowStepsChanged = input.workflowSteps !== undefined &&
      JSON.stringify(input.workflowSteps) !== JSON.stringify(current.workflowSteps);

    // Validate only what this caller is CHANGING. An operator renaming an agent
    // sends the whole payload back, including steps somebody else stored badly
    // — blocking that edit would punish the wrong person and fix nothing. A
    // caller who actually rewrites the steps owns what they write.
    if (workflowStepsChanged) {
      // The POST-update trigger and bindings, since those are what the new
      // steps will run against. A caller that rewrites the steps and repoints
      // the trigger in one call must be checked against where it is going.
      assertWorkflowStepsExecutable(
        input.workflowSteps,
        eventSourcesForAgent(
          input.triggerConfig !== undefined ? input.triggerConfig : current.triggerConfig,
          input.integrations !== undefined ? input.integrations : current.integrations,
        ),
      );
    }

    // Co-located runtime_config_updated row: enqueued in the SAME tx as the
    // primary `updated` event so a Pub/Sub blip can never split the two. After
    // the helper returns we inline-publish this secondary row too. Plan §5.4.
    let secondaryRuntimeConfigRow: OutboxRowRef | null = null;

    const mutation = await mutateAndPublishEvent<{ entity: InternalAgent } | { entity: null }>(
      { caller: 'InternalAgentService.update', actor: actorId, reason: 'update internal_agent + tenant.internal_agent.updated event' },
      async (client) => {
        const result = await client.query(
          `UPDATE internal_agents SET ${updates.join(', ')} WHERE id = $${paramIndex} AND tenant_id = $${paramIndex + 1} AND deleted_at IS NULL RETURNING *`,
          [...params, internalAgentId, tenantId],
        );
        if (result.rows.length === 0) {
          // No row found (concurrent delete race, or never existed for this
          // tenant). Skip the publish entirely — eventInput=null tells
          // mutateAndPublishEvent not to enqueue any outbox row. Caller maps
          // entity=null to a 404 response.
          return {
            entity: { entity: null } as { entity: null },
            eventInput: null,
          };
        }

        let agent = this.mapInternalAgent(result.rows[0]);

        // Re-pin workflow integrity in the same tx so the version row and
        // event payload reflect the post-pin state.
        if (workflowStepsChanged && input.workflowSteps && input.workflowSteps.length > 0) {
          await this.pinWorkflowIntegrity(agent.id, tenantId, input.workflowSteps, 'system:platform-backend', client);
          const refreshed = await client.query(
            `SELECT * FROM internal_agents WHERE id = $1 AND tenant_id = $2`,
            [agent.id, tenantId],
          );
          if (refreshed.rows.length > 0) agent = this.mapInternalAgent(refreshed.rows[0]);
        } else if (workflowStepsChanged && (!input.workflowSteps || input.workflowSteps.length === 0)) {
          await client.query(
            `UPDATE internal_agents SET workflow_steps_hash = NULL, reviewed_at = NULL, reviewed_by = NULL WHERE id = $1 AND tenant_id = $2`,
            [internalAgentId, tenantId],
          );
          const refreshed = await client.query(
            `SELECT * FROM internal_agents WHERE id = $1 AND tenant_id = $2`,
            [agent.id, tenantId],
          );
          if (refreshed.rows.length > 0) agent = this.mapInternalAgent(refreshed.rows[0]);
        }

        if (versionedFieldsChanged) {
          await this.createVersion(agent, source, actorId, client);
        }

        const payload = await buildInternalAgentEventPayload(agent, 'tenant.internal_agent.updated', { actorId });

        // Co-locate the secondary runtime_config_updated row in the SAME tx
        // when runtime config fields actually changed. The unique partial index
        // on (tenant_id, internal_agent_id, event_type) lets the two distinct
        // event_types coexist. Both rows commit atomically with the entity
        // mutation; we inline-publish both after commit.
        if (runtimeConfigChanged && versionedFieldsChanged) {
          // WS-4.3 — resolve hitlLevel from tenant oversight settings,
          // include it in the payload, and validate the payload against the
          // published JSON Schema before enqueueing. Without hitlLevel in
          // the payload the TR subscriber falls into the `|| null` trap that
          // writes null into agents.hitl_level (NOT NULL) and dead-letters
          // the message.
          const oversight = await oversightService.getOversightSettings(tenantId);
          // The agent's own Autonomy Override wins over the workspace default.
          // This publish is what sets the runtime's agents.hitl_level, so
          // reading only the workspace value here is what made the override a
          // control that stored a value and changed nothing.
          const hitlLevel = resolveAgentHitlLevel(agent.autonomyOverride, oversight?.autonomy);
          const runtimeConfigPayload: Record<string, unknown> = {
            entityVersion: agent.currentVersion,
            agentType: agent.agentType,
            hitlLevel,
            // Publish site 2 of 2 (site 1 is buildInternalAgentEventPayload).
            // Both events fire on the same save and both write TR's
            // agents.model_config, so a raw column value here would race with —
            // and undo — the resolution the primary envelope just stamped.
            modelConfig: effectiveModelConfig(agent),
            execConfig: agent.execConfig,
            memoryScope: agent.memoryScope,
            capabilityTier: agent.capabilityTier,
          };
          validateRuntimeConfigUpdatedPayload(runtimeConfigPayload);
          // Envelope entity_version=null so the runtime subscriber's version
          // gate at subscriber.ts:282-292 SKIPS this event. Otherwise the
          // primary `updated` event (same entity_version=N) would win the
          // race, bump event_versions to N, and the gate would drop this
          // runtime_config_updated event — silently dropping agent_type,
          // hitl_level, model_config, exec_config, memory_scope, and
          // workflow_steps_hash updates (those fields are NOT touched by
          // handleInternalAgentUpdated).
          //
          // The handler reads payload.entityVersion to populate
          // agents.entity_version, so the field still gets persisted.
          secondaryRuntimeConfigRow = await enqueueInternalAgentOutbox(client, {
            tenantId,
            internalAgentId: agent.id,
            eventType: 'tenant.internal_agent.runtime_config_updated',
            entityVersion: null,
            payload: runtimeConfigPayload,
          });
        }

        return {
          entity: { entity: agent },
          eventInput: {
            entityType: 'internal_agent',
            entityId: agent.id,
            eventType: 'tenant.internal_agent.updated',
            entityVersion: agent.currentVersion,
            eventVersion: 1,
            tenantId,
            payload,
          },
        };
      },
    );

    // Inline-publish the secondary row after the tx committed. publishOutboxRowInline
    // never throws — failures leave the row pending for the worker (30s drain).
    if (secondaryRuntimeConfigRow !== null) {
      await publishOutboxRowInline(secondaryRuntimeConfigRow);
    }

    if (mutation.entity === null) {
      return null;
    }
    const internalAgent = mutation.entity;

    // Post-commit: regenerate workflow visualization steps (fire-and-forget).
    if (versionedFieldsChanged) {
      generateWorkflowVisualizationSteps(
        internalAgentId, tenantId,
        input.role ?? current.role,
        input.systemPrompt ?? current.systemPrompt ?? null,
        input.userInstructions ?? current.userInstructions ?? null,
        // `current` matters: a redistill that changes prompts but not the graph
        // still regenerates the picture, and it must be checked against the
        // graph the agent actually still has.
        input.workflowSteps ?? current.workflowSteps ?? null,
      ).catch(err => log.warn({ err, agentId: internalAgentId }, 'generateWorkflowVisualizationSteps failed'));
    }

    // Log audit (DE-004)
    await this.logAudit(internalAgent.id, tenantId, 'updated', { before: { ...current, workflowStepsHash: current.workflowStepsHash }, after: { ...input, workflowStepsHash: internalAgent.workflowStepsHash } }, actorId);

    log.info({ internalAgentId, tenantId, version: internalAgent.currentVersion, versionCreated: versionedFieldsChanged }, 'Internal agent updated');

    // Re-embed if capability-relevant fields changed (fire-and-forget)
    const capabilityFieldsChanged = input.role !== undefined || input.responsibilities !== undefined
      || input.summary !== undefined;
    if (capabilityFieldsChanged) {
      import('./embedding-service').then(({ generateAndStoreEmbedding }) => {
        generateAndStoreEmbedding(internalAgentId, tenantId).catch((err: Error) =>
          log.error({ internalAgentId, error: err.message }, 'Capability re-embedding failed (non-blocking)'));
      }).catch(() => {});
    }

    // runtime_config_updated was enqueued + inline-published above in the same
    // tx as the primary `updated` event. Plan §5.4 atomicity invariant.

    // P1.3: a person just bound a new tool to this team member by hand. The
    // auto-grant path fires its own trigger; this covers the manual one, which
    // had no hook at all. Diffed against `current` because the update payload
    // carries the whole array, not a delta.
    if (input.integrations !== undefined) {
      const previousIds = new Set((current.integrations ?? []).map((i) => i.id));
      const addedTypes = input.integrations
        .filter((i) => !previousIds.has(i.id))
        .map((i) => i.type)
        .filter((t): t is string => Boolean(t));
      for (const connectorType of addedTypes) {
        import('../agent-chat/suggestion-triggers')
          .then(({ maybeProposeForNewIntegration }) =>
            maybeProposeForNewIntegration({ tenantId, agentId: internalAgentId, connectorType }))
          .catch(() => {});
      }
    }

    return internalAgent;
  }

  // Update internal agent status
  async updateStatus(
    internalAgentId: string,
    tenantId: string,
    status: InternalAgentStatus,
    actorId?: string
  ): Promise<InternalAgent | null> {
    const current = await this.getById(internalAgentId, tenantId);
    if (!current) {
      return null;
    }

    // A hire that reaches 'active' must have its template's required
    // connectors bound.
    //
    // create() checks the same thing, and on its own that check never fires:
    // a hire is created as a DRAFT and activated afterwards, so the gate on
    // create() only sees hires that were born active. The guarantee belongs on
    // the transition INTO running, which is the moment the requirement starts
    // to matter.
    if (status === 'active' && current.templateId) {
      const { getTemplate } = await import('../agent-templates/loader');
      const tmpl = getTemplate(current.templateId);
      if (tmpl) {
        const { assertRequiredConnectorsBound } = await import('./required-connector-guard');
        const { connectorTypesForRequirement } = await import('../agent-templates/connector-capabilities');
        assertRequiredConnectorsBound({
          template: tmpl,
          bindings: (current.integrations ?? []) as Array<{ type?: string; integrationId?: string }>,
          status,
          connectorTypesFor: connectorTypesForRequirement,
        });
      }
    }

    // Phase 4: Hash verification on activation for any agent carrying a
    // workflowSteps backbone (hybrid execution engine — agentType is always
    // 'agent', but the workflowSteps array may be present or empty/null).
    // Any transition INTO 'active' for an agent with workflowSteps re-verifies
    // that workflow_steps_hash matches the current workflowSteps. A mismatch
    // means someone wrote to workflowSteps directly, bypassing service.update().
    if (status === 'active' && current.workflowSteps && current.workflowSteps.length > 0) {
      {
        const currentHash = this.computeWorkflowStepsHash(current.workflowSteps);
        if (current.workflowStepsHash && current.workflowStepsHash !== currentHash) {
          log.warn({
            internalAgentId,
            tenantId,
            expected: current.workflowStepsHash,
            actual: currentHash,
          }, 'Workflow steps hash mismatch on activation — possible tampering');

          await this.logAudit(internalAgentId, tenantId, 'status_changed', {
            from: current.status,
            to: status,
            blocked: true,
            reason: 'workflow_tampered',
          }, actorId);

          const error = new Error('Workflow steps have been modified outside the normal update flow. Re-save the agent to re-validate.');
          (error as any).code = 'WORKFLOW_TAMPERED';
          (error as any).statusCode = 409;
          throw error;
        }
      }
    }

    // Canonical shape-3: status UPDATE + outbox enqueue commit atomically.
    // On activation we enrich the event payload with full runtime config so
    // the tenant-runtime can activate without a follow-up RPC. The enrichment
    // happens INSIDE the tx so the published payload always reflects committed
    // state.
    const mutation = await mutateAndPublishEvent<InternalAgent | null>(
      { caller: 'InternalAgentService.updateStatus', actor: actorId, reason: `status_changed → ${status}` },
      async (client) => {
        const result = await client.query(
          `UPDATE internal_agents SET status = $1::varchar, current_version = current_version + 1, updated_at = NOW(), last_active = CASE WHEN $1::varchar = 'active' THEN NOW() ELSE last_active END
           WHERE id = $2 AND tenant_id = $3 AND deleted_at IS NULL
           RETURNING *`,
          [status, internalAgentId, tenantId],
        );
        if (result.rows.length === 0) {
          // No row found — skip publish (see service.update for rationale).
          return { entity: null, eventInput: null };
        }
        const agent = this.mapInternalAgent(result.rows[0]);

        const payload: Record<string, unknown> = {
          id: agent.id,
          status: agent.status,
          previousStatus: current.status,
          changedAt: new Date().toISOString(),
          changedBy: actorId ?? null,
        };

        // On activation the tenant-runtime needs the full runtime config so it
        // can spin the agent up without a follow-up RPC. Build the enriched
        // payload via the same helper the create/update paths use so the
        // payload shape can never drift.
        if (status === 'active') {
          const enriched = await buildInternalAgentEventPayload(agent, 'tenant.internal_agent.created', { actorId });
          // The helper returns `createdAt` / `createdBy` because those are
          // canonical fields on the `created` payload shape. For a
          // status_changed event they would mis-attribute the creation actor
          // (e.g. a pause action would claim the pauser created the agent),
          // so drop them BEFORE the merge.
          delete (enriched as Record<string, unknown>).createdAt;
          delete (enriched as Record<string, unknown>).createdBy;
          Object.assign(payload, enriched);
          payload.changedAt = new Date().toISOString();
          payload.changedBy = actorId ?? null;
        }

        // The field the tenant-runtime's status_changed handler branches on.
        // This publish used to live in the router and sent `newStatus`; moving
        // it here put the status under `status` instead, and the runtime — which
        // reads `newStatus` — quietly stopped acting on pause and resume
        // entirely. Set AFTER the activation merge above, which would otherwise
        // be free to overwrite it. Both names carry the same value; the runtime
        // now accepts either, and this keeps a runtime that has not been
        // deployed yet working.
        payload.newStatus = agent.status;

        return {
          entity: agent,
          eventInput: {
            entityType: 'internal_agent',
            entityId: agent.id,
            eventType: 'tenant.internal_agent.status_changed',
            entityVersion: agent.currentVersion,
            eventVersion: 1,
            tenantId,
            payload,
          },
        };
      },
    );

    if (mutation === null) {
      return null;
    }
    const internalAgent = mutation;

    // Log audit (DE-004)
    await this.logAudit(internalAgent.id, tenantId, 'status_changed', { from: current.status, to: status }, actorId);

    log.info({ internalAgentId, tenantId, oldStatus: current.status, newStatus: status }, 'Internal agent status updated');

    return internalAgent;
  }

  // Delete an internal agent: marked here, purged later (DE-003).
  //
  // The row is marked rather than removed so the deletion is recoverable for
  // its grace period, and src/maintenance/purge-soft-deleted.ts hard-deletes
  // it afterwards - taking the version snapshots, the generated files, the
  // share links and the conversations this agent took part in with it. The
  // mark is what the person sees: the agent leaves every list and every
  // export at once.
  async delete(internalAgentId: string, tenantId: string, actorId?: string): Promise<boolean> {
    // Canonical shape-3: soft-delete UPDATE + person-agent-assignments cleanup
    // + outbox enqueue in one tx. publishOutboxRowInline runs post-commit.
    const deleted = await mutateAndPublishEvent<boolean>(
      { caller: 'InternalAgentService.delete', actor: actorId, reason: 'soft-delete internal_agent + tenant.internal_agent.deleted event' },
      async (client) => {
        const result = await client.query(
          `UPDATE internal_agents SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL RETURNING id`,
          [internalAgentId, tenantId],
        );
        if (result.rowCount === 0) {
          // No row found or already soft-deleted — skip publish.
          return { entity: false, eventInput: null };
        }
        await client.query(
          `UPDATE person_agent_assignments SET deleted_at = NOW()
           WHERE agent_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
          [internalAgentId, tenantId],
        );
        return {
          entity: true,
          eventInput: {
            entityType: 'internal_agent',
            entityId: internalAgentId,
            eventType: 'tenant.internal_agent.deleted',
            entityVersion: null,
            eventVersion: 1,
            tenantId,
            payload: { id: internalAgentId },
          },
        };
      },
    );

    if (!deleted) {
      return false;
    }

    // Log audit (DE-004)
    await this.logAudit(internalAgentId, tenantId, 'deleted', null, actorId);

    log.info({ internalAgentId, tenantId }, 'Internal agent deleted (soft)');

    return true;
  }

  // Create a version snapshot (includes runtime config fields per plan)
  private async createVersion(
    internalAgent: InternalAgent,
    source: VersionSource,
    createdBy?: string,
    client?: Querier,
  ): Promise<void> {
    const querier = client ?? pool;
    await querier.query(
      `INSERT INTO internal_agent_versions (
        internal_agent_id, version, role, responsibilities, integrations, additional_context,
        system_prompt, user_instructions, source, created_by,
        agent_type, model_config, memory_scope, exec_config, workflow_steps, trigger_config,
        instructions_md, workflow_visualization_steps,
        autonomy_override, pinned_knowledge_ids, skills, capability_tier, attachments,
        ai_vendor_override
      )
       VALUES ($1, $2, $3::varchar, $4, $5, $6, $7, $8, $9::varchar, $10, $11::varchar, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22::varchar, $23, $24::varchar)`,
      [
        internalAgent.id,
        internalAgent.currentVersion,
        internalAgent.role,
        internalAgent.responsibilities,
        JSON.stringify(internalAgent.integrations),
        internalAgent.additionalContext,
        internalAgent.systemPrompt,
        internalAgent.userInstructions,
        source,
        createdBy || null,
        internalAgent.agentType,
        JSON.stringify(internalAgent.modelConfig),
        JSON.stringify(internalAgent.memoryScope),
        JSON.stringify(internalAgent.execConfig),
        internalAgent.workflowSteps ? JSON.stringify(internalAgent.workflowSteps) : null,
        internalAgent.triggerConfig ? JSON.stringify(internalAgent.triggerConfig) : null,
        internalAgent.instructionsMd,
        internalAgent.workflowVisualizationSteps ? JSON.stringify(internalAgent.workflowVisualizationSteps) : null,
        internalAgent.autonomyOverride,
        internalAgent.pinnedKnowledgeIds ?? [],
        JSON.stringify(internalAgent.skills ?? []),
        internalAgent.capabilityTier ?? 'connector_only',
        JSON.stringify(internalAgent.attachments ?? []),
        internalAgent.aiVendorOverride ?? null,
      ]
    );
  }

  // Get all versions for an internal agent
  async getVersions(internalAgentId: string, tenantId: string): Promise<InternalAgentVersion[]> {
    // First verify the agent belongs to this tenant
    const agent = await this.getById(internalAgentId, tenantId);
    if (!agent) {
      return [];
    }

    const result = await pool.query(
      `SELECT * FROM internal_agent_versions WHERE internal_agent_id = $1 ORDER BY version DESC`,
      [internalAgentId]
    );

    return result.rows.map(row => this.mapVersion(row));
  }

  // Get a specific version
  async getVersion(internalAgentId: string, tenantId: string, version: number): Promise<InternalAgentVersion | null> {
    // First verify the agent belongs to this tenant
    const agent = await this.getById(internalAgentId, tenantId);
    if (!agent) {
      return null;
    }

    const result = await pool.query(
      `SELECT * FROM internal_agent_versions WHERE internal_agent_id = $1 AND version = $2`,
      [internalAgentId, version]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapVersion(result.rows[0]);
  }

  // Rollback to a specific version
  async rollbackToVersion(
    internalAgentId: string,
    tenantId: string,
    targetVersion: number,
    actorId?: string
  ): Promise<InternalAgent | null> {
    const version = await this.getVersion(internalAgentId, tenantId, targetVersion);
    if (!version) {
      return null;
    }

    // Apply the version's values as an update, creating a new version
    return this.update(
      internalAgentId,
      tenantId,
      {
        role: version.role,
        responsibilities: version.responsibilities || undefined,
        integrations: version.integrations,
        additionalContext: version.additionalContext || undefined,
        systemPrompt: version.systemPrompt || undefined,
        userInstructions: version.userInstructions || undefined,
        instructionsMd: version.instructionsMd,
        // Include runtime config fields in rollback
        agentType: version.agentType,
        modelConfig: version.modelConfig,
        memoryScope: version.memoryScope,
        execConfig: version.execConfig,
        workflowSteps: version.workflowSteps,
        triggerConfig: version.triggerConfig,
        autonomyOverride: version.autonomyOverride,
        aiVendorOverride: version.aiVendorOverride,
        skills: version.skills,
        capabilityTier: version.capabilityTier,
        attachments: version.attachments,
      },
      actorId,
      'manual' // Rollback creates a new manual version
    );
  }

  // Log audit entry (DE-004)
  private async logAudit(
    internalAgentId: string,
    tenantId: string,
    action: 'created' | 'updated' | 'deleted' | 'status_changed',
    changes: unknown,
    actorId?: string
  ): Promise<void> {
    await withTenantScope(tenantId, (client) => client.query(
      `INSERT INTO internal_agent_audit (internal_agent_id, tenant_id, action, changes, actor_id) VALUES ($1, $2, $3::varchar, $4, $5)`,
      [internalAgentId, tenantId, action, changes ? JSON.stringify(changes) : null, actorId || null]
    ));
  }

  // Phase 4: Compute deterministic SHA-256 hash of workflow steps.
  // Recursively sorts object keys for canonical JSON form so that
  // key-insertion order doesn't affect the hash.
  private computeWorkflowStepsHash(steps: WorkflowStep[]): string {
    const canonical = JSON.stringify(steps, (_key, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const sorted: Record<string, unknown> = {};
        for (const k of Object.keys(value).sort()) {
          sorted[k] = value[k];
        }
        return sorted;
      }
      return value;
    });
    return createHash('sha256').update(canonical).digest('hex');
  }

  // Phase 4: Pin workflow integrity metadata (hash, reviewed_at, reviewed_by) on an agent row.
  private async pinWorkflowIntegrity(
    agentId: string,
    tenantId: string,
    steps: WorkflowStep[],
    reviewedBy: string,
    client?: Querier,
  ): Promise<void> {
    const hash = this.computeWorkflowStepsHash(steps);
    const querier = client ?? pool;
    await querier.query(
      `UPDATE internal_agents SET workflow_steps_hash = $1, reviewed_at = NOW(), reviewed_by = $2 WHERE id = $3 AND tenant_id = $4`,
      [hash, reviewedBy, agentId, tenantId]
    );
  }

  // Phase 4: Fetch tool categories for workflow HITL floor enforcement.
  // Gracefully degrades to empty map if tenant-runtime is unreachable.
  private async fetchToolCategories(tenantId: string): Promise<Map<string, string[]>> {
    const categories = new Map<string, string[]>();
    try {
      const { manifests } = await tenantRuntimeClient.getTenantManifests(tenantId);
      const catalogPromises = manifests.map(m =>
        tenantRuntimeClient.getToolCatalog(tenantId, m.manifestId).catch(() => ({
          schemaVersion: 1 as const,
          connectorType: '',
          alias: '',
          tools: [],
        }))
      );
      const catalogs = await Promise.all(catalogPromises);
      for (const catalog of catalogs) {
        for (const tool of catalog.tools) {
          const cats = (tool as unknown as { categories?: string[] }).categories;
          if (tool.name && cats) {
            categories.set(tool.name, cats);
          }
        }
      }
    } catch (err) {
      log.warn({ tenantId, error: (err as Error).message }, 'Failed to fetch tool categories for HITL floor enforcement');
    }
    return categories;
  }


  // Map database row to InternalAgent. Delegates to the shared row-mapper so
  // the reconciler (which can't call this private method) and service path use
  // the same logic.
  private mapInternalAgent(row: Record<string, unknown>): InternalAgent {
    return mapInternalAgentRow(row);
  }

  // Map database row to InternalAgentVersion
  private mapVersion(row: Record<string, unknown>): InternalAgentVersion {
    return {
      id: row.id as string,
      internalAgentId: row.internal_agent_id as string,
      version: row.version as number,
      role: row.role as string,
      responsibilities: row.responsibilities as string | null,
      integrations: this.parseIntegrations(row.integrations),
      additionalContext: row.additional_context as string | null,
      systemPrompt: row.system_prompt as string | null,
      userInstructions: row.user_instructions as string | null,
      instructionsMd: (row.instructions_md as string | null) ?? null,
      source: row.source as VersionSource,
      createdBy: row.created_by as string | null,
      createdAt: new Date(row.created_at as string),
      // Runtime config fields (snapshotted in versions)
      agentType: (row.agent_type as AgentType) || 'agent',
      modelConfig: withNormalizedTier(this.parseJsonb<ModelConfig>(row.model_config, {})),
      memoryScope: normalizeMemoryScope(row.memory_scope),
      execConfig: this.parseJsonb<ExecConfig>(row.exec_config, {}),
      workflowSteps: row.workflow_steps ? this.parseJsonb<WorkflowStep[]>(row.workflow_steps, []) : null,
      triggerConfig: row.trigger_config ? this.parseJsonb<TriggerConfig | null>(row.trigger_config, null) : null,
      workflowVisualizationSteps: row.workflow_visualization_steps
        ? this.parseJsonb<WorkflowVisualizationStep[]>(row.workflow_visualization_steps, [])
        : null,
      autonomyOverride: (row.autonomy_override as AutonomyLevel | null) ?? null,
      aiVendorOverride: (row.ai_vendor_override as WorkspaceAiSelection | null) ?? null,
      pinnedKnowledgeIds: Array.isArray(row.pinned_knowledge_ids)
        ? (row.pinned_knowledge_ids as string[])
        : [],
      skills: this.parseJsonb<Skill[]>(row.skills, []),
      capabilityTier: ((row.capability_tier as CapabilityTier | null) ?? 'connector_only'),
      attachments: this.parseJsonb<TeamAttachment[]>(row.attachments, []),
    };
  }

  // Parse integrations from DB
  private parseIntegrations(raw: unknown): IntegrationPermission[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw as IntegrationPermission[];
  }

  /** Parse the pending_integrations JSONB column. Stored as a plain array of
   *  connector type strings, but defensively handles the case where older
   *  rows have null or a stringified value. */
  private parsePendingIntegrations(raw: unknown): string[] {
    if (raw == null) return [];
    if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed)
          ? parsed.filter((x): x is string => typeof x === 'string')
          : [];
      } catch {
        return [];
      }
    }
    return [];
  }

  // Parse JSONB fields with default fallback
  private parseJsonb<T>(raw: unknown, defaultValue: T): T {
    if (raw === null || raw === undefined) {
      return defaultValue;
    }
    if (typeof raw === 'object') {
      return raw as T;
    }
    try {
      return JSON.parse(raw as string) as T;
    } catch {
      return defaultValue;
    }
  }
}

export const internalAgentService = new InternalAgentService();
