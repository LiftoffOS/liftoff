import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../infrastructure/database';
import { logger, logAudit } from '../infrastructure/logging';
import { getDefaultProvider, getProviderModel } from '../memory/embedding';
import { generateSkillEmbeddingWithRetry } from './skill-embedding';

// Skill embeddings always go through the platform-default embedding
// provider. The wrapper returns only the vector, so we record the model
// that platform default resolves to at write time. If we ever route
// skills through tenant-entitled providers, switch to the detailed
// embed API and record the actual model returned per call.
const DEFAULT_EMBEDDING_MODEL = (): string => getProviderModel(getDefaultProvider());

export interface Skill {
  /** Control-plane skill identity. Persisted verbatim when it is a UUID, so a
   *  skill that survives a redistill keeps the id `agent_skill_metrics` and
   *  usefulness scoring are keyed on. The flywheel also mints transient
   *  `reflection:<uuid>:<origin>` ids for brand-new skills; those are not
   *  UUIDs, so a fresh id is generated here and the control plane picks it up
   *  on its next sync. */
  id?: string;
  name: string;
  description: string;
  instruction: string;
  tags?: string[];
  /** See migration 334. Absent on payloads from an older control plane. */
  provenance?: 'distilled' | 'learned' | 'operator';
  protected?: boolean;
  /** Files the skill ships with — pointers, never content. See migration 395.
   *  Absent on payloads from an older control plane, and absent on the many
   *  skills that are text only. */
  bundle?: SkillBundle;
}

/** One file belonging to a skill. Content lives in the control plane's bucket,
 *  addressed by its own digest; the digest is re-checked on every read, because
 *  a pointer is only a promise about content. */
export interface SkillBundleFile {
  path: string;
  bytes: number;
  sha256: string;
  storageRef: string;
  executable?: boolean;
}

export interface SkillBundle {
  files: SkillBundleFile[];
}

/** `agent_skills.id` is a UUID column; the control plane's transient
 *  `reflection:<uuid>:<origin>` ids are not UUIDs and must not be forced into
 *  it. Returns the id when it is safe to persist, else null (generate one). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function persistableSkillId(id: string | undefined): string | null {
  return id && UUID_RE.test(id) ? id : null;
}

export interface InternalAgentInstructionInput {
  tenantId: string;
  agentId: string;
  idempotencyKey?: string;  // event_id from ControlPlaneEvent — prevents duplicate instructions on redelivery
  systemPrompt?: string;
  userInstructions?: string;
  hitlLevel?: number;
  // `type` is enriched by the platform backend at event-publish time. See
  // src/instruction-compiler/types.ts for the full rationale. Optional for
  // backwards compat with events emitted before the enrichment was added.
  integrations?: Array<{ id: string; type?: string; selectedObjects: string[] }>;
  triggerConfig?: { type: 'cron' | 'event'; cronExpr?: string; eventTopic?: string };
  // Phase 1 CLAUDE.md: DB-backed instructions_md from platform backend
  instructionsMd?: string | null;
  // R5: capability tier — connector_only (default) or execution_enabled (grants shell/file tools)
  capabilityTier?: 'connector_only' | 'execution_enabled';
  /** Per-tool result-handling policy from distillation. Stored verbatim; the
   *  gateway reads it to decide which results may not be acted on in part. */
  resultRules?: Array<{ toolName: string; requiresComplete: boolean }>;
  /** Per-tool rules appended to those tools' descriptions, keyed by aliased
   *  tool name. Full-replace on every publish, exactly like resultRules. */
  toolDescriptionOverrides?: Record<string, string>;
  /** Declared grounding rules, evaluated by the host at turn start so an
   *  agent's first read is the same on every engine. */
  groundsOn?: Array<{ label: string; terms: string[]; cues: string[]; toolName: string; enabled: boolean }>;
  /** Per-capability live | unwired | absent. The gateway refuses an absent
   *  capability's tools by name. */
  capabilityStates?: Record<string, 'live' | 'unwired' | 'absent'>;
  // Agent skills — discrete semantically-selectable instruction modules
  skills?: Skill[];
  // Knowledge items pinned via [[knowledge:...]] markers in responsibilities/
  // additionalContext. Used by corpus_search as a retrieval bias — pinned
  // items are positionally elevated above natural matches when they match
  // the query. Empty array when no pins.
  pinnedKnowledgeIds?: string[];
}

export class InternalAgentInstructionService {
  /**
   * Creates and activates a compiled instruction for an internal agent.
   *
   * This materializes the user's internal agent configuration (from TeamBuilder + OversightPage)
   * into an executable instruction. HITL gates are enforced at runtime based on
   * the oversight settings (autonomy, escalation, sensitive work categories).
   */
  async createAndActivateForInternalAgent(input: InternalAgentInstructionInput): Promise<string> {
    const pool = getPool();
    const instructionId = uuidv4();

    // Validate tenant isolation (SE-002)
    if (!input.tenantId || !input.agentId) {
      throw new Error('tenantId and agentId are required');
    }

    // Idempotency check: if key provided, check for any prior instruction
    // bearing that key (regardless of status). If one exists the event has
    // already been processed; return that row's id and treat the call as a
    // no-op. Filtering on `status='active'` would break the at-least-once
    // Pub/Sub contract: when event A arrives and inserts v1 (active), then a
    // NEWER event B supersedes v1 to status='superseded' and inserts v2
    // (active), and then Pub/Sub re-delivers event A (retry, crash recovery,
    // ack lost in flight, …), an active-only pre-check misses the v1 row, the
    // supersede UPDATE below wouldn't surface it either (only acts on active
    // rows), and the INSERT hits the `idx_compiled_instructions_idempotency`
    // unique constraint on the same `event_id + '_activation'` key. The
    // duplicate-key error bubbles up as a 500 from
    // /internal/pubsub/control-plane-events, Pub/Sub nacks, and the same event
    // retries indefinitely — jamming the subscription with stale redistill
    // events and blocking every newer event behind them (including Composio
    // Gmail trigger fan-outs to CSR). Matching on any status keeps correct
    // at-least-once semantics: the
    // idempotency_key is global across statuses by design (the constraint
    // doesn't scope on status), and the pre-check must match the constraint.
    if (input.idempotencyKey) {
      const existing = await pool.query(
        `SELECT id, status FROM compiled_instructions
         WHERE tenant_id = $1 AND agent_id = $2 AND idempotency_key = $3
         LIMIT 1`,
        [input.tenantId, input.agentId, input.idempotencyKey]
      );
      if (existing.rows.length > 0) {
        logger.info('Instruction already exists for idempotency key, returning existing', {
          instructionId: existing.rows[0].id,
          status: existing.rows[0].status,
          idempotencyKey: input.idempotencyKey,
        });
        return existing.rows[0].id;
      }
    }

    // Deactivate any existing active instructions for this agent
    await pool.query(
      `UPDATE compiled_instructions
       SET status = 'superseded', activated_at = NULL
       WHERE agent_id = $1 AND tenant_id = $2 AND status = 'active'`,
      [input.agentId, input.tenantId]
    );

    // Get the next version number for this agent
    const versionResult = await pool.query(
      `SELECT COALESCE(MAX(version), 0) + 1 as next_version
       FROM compiled_instructions
       WHERE agent_id = $1 AND tenant_id = $2`,
      [input.agentId, input.tenantId]
    );
    const nextVersion = versionResult.rows[0].next_version;

    // Resolve capability tier: explicit input takes precedence; fall back to scanning
    // the prompt text for sandbox__ tool references (pre-tier-field legacy detection).
    const promptText = [input.systemPrompt ?? '', input.userInstructions ?? '', input.instructionsMd ?? ''].join(' ');
    const resolvedCapabilityTier = input.capabilityTier ??
      (promptText.includes('sandbox__') ? 'execution_enabled' : 'connector_only');

    // Build compiled instruction from user's internal agent configuration
    // raw_input captures the original TeamBuilder configuration for audit/debugging
    const rawInput = {
      systemPrompt: input.systemPrompt || '',
      userInstructions: input.userInstructions || '',
      hitlLevel: input.hitlLevel ?? 3,
      integrations: input.integrations || [],
      triggerConfig: input.triggerConfig || null,
      pinnedKnowledgeIds: input.pinnedKnowledgeIds ?? [],
      source: 'internal_agent',
    };

    const compiledInstruction = {
      id: instructionId,
      agentId: input.agentId,
      tenantId: input.tenantId,
      version: nextVersion,
      systemPrompt: input.systemPrompt || '',
      userInstructions: input.userInstructions || '',
      hitlLevel: input.hitlLevel ?? 3,  // From OversightPage settings
      integrations: input.integrations || [],
      triggerConfig: input.triggerConfig || null,
      status: 'active',
      source: 'internal_agent',  // Created from TeamBuilder/TeamUpdatePage
      createdAt: new Date().toISOString(),
      activatedAt: new Date().toISOString(),
    };

    // Use parameterized query to prevent SQL injection (SE-006).
    // ON CONFLICT DO NOTHING guards against the concurrent-insert race that occurs when
    // a `created` event and an `updated` event for the same agent are delivered
    // simultaneously (e.g. on coordinator restart / deployment rollout). Both handlers
    // compute version = MAX(version)+1 = 1 before either commits, then race to INSERT.
    // Without the guard the losing INSERT throws a unique-constraint violation, the
    // inline-activation catch swallows it, and the agent is left in DRAFT with no
    // compiled_instruction.  With the guard the losing INSERT is a no-op; we then fall
    // through to fetch the winning instruction and return its id so the caller can
    // proceed to activate the lifecycle as normal.
    const insertResult = await pool.query(
      `INSERT INTO compiled_instructions
       (id, agent_id, tenant_id, version, raw_input, system_prompt, user_instructions,
        hitl_level, integrations, trigger_config, status, source,
        created_at, activated_at, idempotency_key, instructions_md, capability_tier,
        result_rules, tool_description_overrides, grounds_on, capability_states)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
       ON CONFLICT (agent_id, version) DO NOTHING
       RETURNING id`,
      [
        compiledInstruction.id,
        compiledInstruction.agentId,
        compiledInstruction.tenantId,
        compiledInstruction.version,
        JSON.stringify(rawInput),  // raw_input is NOT NULL
        compiledInstruction.systemPrompt,
        compiledInstruction.userInstructions,
        compiledInstruction.hitlLevel,
        JSON.stringify(compiledInstruction.integrations),
        compiledInstruction.triggerConfig ? JSON.stringify(compiledInstruction.triggerConfig) : null,
        compiledInstruction.status,
        compiledInstruction.source,
        compiledInstruction.createdAt,
        compiledInstruction.activatedAt,
        input.idempotencyKey || null,
        input.instructionsMd || null,
        resolvedCapabilityTier,
        // Defaulted to an empty list rather than null: the column is NOT NULL so
        // every reader gets a list, and an agent distilled before this existed
        // lands on today's behaviour rather than on an undefined policy.
        JSON.stringify(input.resultRules ?? []),
        JSON.stringify(input.toolDescriptionOverrides ?? {}),
        JSON.stringify(input.groundsOn ?? []),
        JSON.stringify(input.capabilityStates ?? {}),
      ]
    );

    if (insertResult.rows.length === 0) {
      // A concurrent call won the version-1 race.  The winning INSERT already committed
      // an active instruction for this agent.  Return its id so the caller proceeds to
      // activate the lifecycle rather than treating this as a failure.
      const winner = await pool.query(
        `SELECT id FROM compiled_instructions
         WHERE agent_id = $1 AND tenant_id = $2 AND status = 'active'
         ORDER BY version DESC LIMIT 1`,
        [input.agentId, input.tenantId],
      );
      if (winner.rows.length > 0) {
        logger.info('Concurrent INSERT won version race — returning existing active instruction', {
          agentId: input.agentId,
          tenantId: input.tenantId,
          existingInstructionId: winner.rows[0].id,
        });
        return winner.rows[0].id as string;
      }
      // Should not happen: conflict means a row exists, but it isn't active.  Throw so
      // the caller's catch block logs it and Pub/Sub redelivers for a clean retry.
      throw new Error(
        `Race condition: concurrent INSERT won for agent ${input.agentId} but no active instruction found`,
      );
    }

    // Clear graduated_at on all agent memories so the slow loop can re-evaluate
    // and re-graduate if the lessons are still relevant to the new configuration.
    // Re-distill means the agent's role/responsibilities may have changed.
    await pool.query(
      `UPDATE memories SET graduated_at = NULL
       WHERE agent_id = $1 AND tenant_id = $2 AND graduated_at IS NOT NULL`,
      [input.agentId, input.tenantId],
    );

    // Store skills when provided — supersede prior active skills and insert new ones.
    if (input.skills && input.skills.length > 0) {
      await pool.query(
        `UPDATE agent_skills SET status = 'superseded', updated_at = NOW()
         WHERE agent_id = $1 AND tenant_id = $2 AND status = 'active'`,
        [input.agentId, input.tenantId],
      );

      for (const skill of input.skills) {
        const embedding = await generateSkillEmbeddingWithRetry(skill.description, {
          tenantId: input.tenantId,
          agentId: input.agentId,
          skillName: skill.name,
        });

        // Explicit ::uuid + ::vector casts — see updateAgentSkillsOnly's
        // INSERT below for rationale. Column is halfvec(3072) after
        // migration 259.
        // COALESCE keeps the control plane's id when it sent a UUID (skill
        // identity survives the rewrite, so metrics and usefulness scores stay
        // attached); otherwise the column default mints a fresh one.
        //
        // ON CONFLICT is REQUIRED, not defensive: superseding above is an UPDATE,
        // so the previous row for this id is still in the table. Re-inserting the
        // same id would violate the primary key and fail the whole skills write —
        // which is every write after ids start flowing. Reactivating the row in
        // place is also the behaviour we want: one row per skill identity, with
        // agent_skill_metrics still attached to it.
        await pool.query(
          `INSERT INTO agent_skills
             (id, tenant_id, agent_id, compiled_instruction_id, name, description, instruction,
              embedding, embedding_model, tags, status, provenance, protected, bundle)
           VALUES (COALESCE($10::uuid, gen_random_uuid()), $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
                   $7::vector, $8, $9, 'active', $11, $12, $13::jsonb)
           ON CONFLICT (id) DO UPDATE SET
             compiled_instruction_id = EXCLUDED.compiled_instruction_id,
             name = EXCLUDED.name,
             description = EXCLUDED.description,
             instruction = EXCLUDED.instruction,
             embedding = EXCLUDED.embedding,
             embedding_model = EXCLUDED.embedding_model,
             tags = EXCLUDED.tags,
             status = 'active',
             provenance = EXCLUDED.provenance,
             protected = EXCLUDED.protected,
             bundle = EXCLUDED.bundle,
             updated_at = NOW()`,
          [
            input.tenantId,
            input.agentId,
            instructionId,
            skill.name,
            skill.description,
            skill.instruction,
            embedding ? `[${embedding.join(',')}]` : null,
            embedding ? DEFAULT_EMBEDDING_MODEL() : null,
            skill.tags ?? [],
            persistableSkillId(skill.id),
            skill.provenance ?? 'distilled',
            skill.protected ?? false,
            skill.bundle ? JSON.stringify(skill.bundle) : null,
          ],
        );
      }

      logger.info('Stored skills for agent', {
        agentId: input.agentId,
        tenantId: input.tenantId,
        skillCount: input.skills.length,
      });
    }

    // Audit log for instruction creation
    logAudit('instruction.created', {
      tenantId: input.tenantId,
      agentId: input.agentId,
      resourceType: 'compiled_instruction',
      resourceId: instructionId,
    }, {
      action: 'created_from_internal_agent',
      metadata: {
        source: 'internal_agent_activation',
        hitlLevel: compiledInstruction.hitlLevel,
        hasSystemPrompt: !!input.systemPrompt,
        hasUserInstructions: !!input.userInstructions,
        integrationCount: compiledInstruction.integrations.length,
      },
    });

    logger.info('Created and activated instruction for internal agent', {
      instructionId,
      agentId: input.agentId,
      tenantId: input.tenantId,
    });

    return instructionId;
  }

  /**
   * Updates agent skills in-place without creating a new compiled_instructions row.
   *
   * Used by the skills flywheel: when platform-backend emits a skills_updated event
   * after the feedback loop refines skill instructions, the tenant-runtime re-ingests
   * the updated skill set and links it to the current active instruction version.
   * The compiled_instructions.version is NOT bumped — this is a skills-only mutation.
   */
  async updateAgentSkillsOnly(input: {
    tenantId: string;
    agentId: string;
    idempotencyKey?: string;
    skills: Skill[];
  }): Promise<void> {
    const pool = getPool();

    if (input.idempotencyKey) {
      const already = await this.checkEventLedger(input.tenantId, input.idempotencyKey);
      if (already) return;
    }

    // Find the current active compiled_instruction_id — link new skills to it.
    // Do NOT create a new compiled_instructions row; this is a skills-only mutation.
    const instrResult = await pool.query(
      `SELECT id FROM compiled_instructions
       WHERE agent_id = $1 AND tenant_id = $2 AND status = 'active'
       ORDER BY version DESC LIMIT 1`,
      [input.agentId, input.tenantId],
    );
    if (instrResult.rows.length === 0) {
      logger.warn({ agentId: input.agentId }, 'updateAgentSkillsOnly: no active instruction, skipping');
      return;
    }
    const compiledInstructionId = instrResult.rows[0].id as string;

    await pool.query(
      `UPDATE agent_skills SET status = 'superseded', updated_at = NOW()
       WHERE agent_id = $1 AND tenant_id = $2 AND status = 'active'`,
      [input.agentId, input.tenantId],
    );

    for (const skill of input.skills) {
      const embedding = await generateSkillEmbeddingWithRetry(skill.description, {
        tenantId: input.tenantId,
        agentId: input.agentId,
        skillName: skill.name,
      });

      // Explicit ::vector cast on $7 — PG's type deduction fails on the
      // first prepared-statement parse when the parameter value is a string
      // like '[0.1,...]' going into a halfvec column (error: "inconsistent
      // types deduced for parameter $1" — the $N in the error message is
      // misleading; the actual problem is the cast). Casting in the SQL
      // bypasses deduction. ::uuid casts on the IDs are defensive for the
      // same reason. Column is halfvec(3072) after migration 259.
      // See createAndActivateForInternalAgent's INSERT for the COALESCE id and
      // ON CONFLICT rationale (skill-identity continuity across a rewrite, and
      // the primary-key collision with the row this function just superseded).
      await pool.query(
        `INSERT INTO agent_skills
           (id, tenant_id, agent_id, compiled_instruction_id, name, description,
            instruction, embedding, embedding_model, tags, status, provenance, protected, bundle)
         VALUES (COALESCE($10::uuid, gen_random_uuid()), $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
                 $7::vector, $8, $9, 'active', $11, $12, $13::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           compiled_instruction_id = EXCLUDED.compiled_instruction_id,
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           instruction = EXCLUDED.instruction,
           embedding = EXCLUDED.embedding,
           embedding_model = EXCLUDED.embedding_model,
           tags = EXCLUDED.tags,
           status = 'active',
           provenance = EXCLUDED.provenance,
           protected = EXCLUDED.protected,
           bundle = EXCLUDED.bundle,
           updated_at = NOW()`,
        [
          input.tenantId,
          input.agentId,
          compiledInstructionId,
          skill.name,
          skill.description,
          skill.instruction,
          embedding ? `[${embedding.join(',')}]` : null,
          embedding ? DEFAULT_EMBEDDING_MODEL() : null,
          skill.tags ?? [],
          persistableSkillId(skill.id),
          skill.provenance ?? 'distilled',
          skill.protected ?? false,
          skill.bundle ? JSON.stringify(skill.bundle) : null,
        ],
      );
    }

    if (input.idempotencyKey) {
      await this.recordEventLedger(input.tenantId, input.idempotencyKey, input.agentId);
    }

    logger.info('Updated agent skills (skills-only mutation)', {
      agentId: input.agentId,
      tenantId: input.tenantId,
      skillCount: input.skills.length,
      compiledInstructionId,
    });
  }

  private async checkEventLedger(tenantId: string, idempotencyKey: string): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT 1 FROM event_processing_ledger
       WHERE tenant_id = $1 AND event_id = $2 AND status = 'completed' LIMIT 1`,
      [tenantId, idempotencyKey],
    );
    return result.rows.length > 0;
  }

  private async recordEventLedger(
    tenantId: string,
    idempotencyKey: string,
    agentId: string,
  ): Promise<void> {
    const pool = getPool();
    // Explicit per-parameter casts AND distinct parameter positions:
    //   - event_processing_ledger.tenant_id  is UUID
    //   - event_processing_ledger.entity_id  is VARCHAR(255)
    // The previous version reused `$1` for both tenant_id and entity_id;
    // PostgreSQL's prepared-statement parser infers a single type per
    // placeholder, so it threw "inconsistent types deduced for parameter $1"
    // every time and the skills_updated handler rolled back. Pub/Sub then
    // redelivered indefinitely, head-of-line blocking the same subscription
    // that delivers connector.composio_trigger_fired (every test email
    // waited ~5 minutes behind a wall of failing skills retries).
    //
    // entity_id is the per-agent identifier (the agent whose skills changed)
    // — not a duplicate of tenant_id. The compound index
    // `idx_epl_entity (tenant_id, entity_type, entity_id)` only makes sense
    // when entity_id distinguishes one agent's ledger row from another's.
    await pool.query(
      `INSERT INTO event_processing_ledger
         (tenant_id, event_id, event_type, entity_type, entity_id, entity_version, status)
       VALUES ($1::uuid, $2, 'skills_updated', 'agent', $3, 0, 'completed')
       ON CONFLICT (tenant_id, event_id) DO UPDATE SET status = 'completed', updated_at = NOW()`,
      [tenantId, idempotencyKey, agentId],
    );
  }

}

export const internalAgentInstructionService = new InternalAgentInstructionService();
