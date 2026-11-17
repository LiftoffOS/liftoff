// Liftoff Switch — migration orchestration.
//
// This module COORDINATES existing Liftoff services. It is emphatically not a
// second agent-provisioning path: conversion goes through
// provisionAgentFromDistill, which is the same distill → create → absorption
// flow the interactive builder uses.
//
// Ordering that matters, and why:
//   * Connection placeholders are materialized when the BUNDLE is accepted,
//     before payment, so the user can reconnect during review and so imported
//     agents can bind to concrete connector UUIDs at conversion time.
//   * Conversion runs only after the billing authority confirms a paid
//     subscription with capacity.
//   * Everything imported stays draft/disabled until the user confirms cutover,
//     which is what keeps duplicate execution an explicit choice.

import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { InternalAgentService } from '../internal-agents/service';
import { provisionAgentFromDistill } from '../internal-agents/provisioning-helper';
import type { DistillInput } from '../internal-agents/distill-service';
import type { TeamAttachment } from '../internal-agents/types';
import {
  checkConversionAdmission,
  checkMigrationCreationAdmission,
  mayRetryItem,
  reserveDistillSlot,
  MAX_CONCURRENT_ITEM_DISTILLS,
  MIGRATION_CREATION_WINDOW_HOURS,
  type AdmissionResult,
  type EntitlementSnapshot,
} from './admission';
import {
  materializeCatalogPlaceholders,
  materializeMcpPlaceholders,
  resolveHostingRequirements,
  resolveConnectionStatuses,
  resolveAgentBindings,
} from './connections';
import { pauseGuidanceFor } from './pause-guidance';
import { sourceMigrationRepository as repo } from './repository';
import type {
  MigrationBundleV1,
  MigrationRequirement,
  MigrationSource,
  MigrationState,
  MigrationView,
  SourceMigration,
  SourceMigrationItem,
  StoredDistillInput,
} from './types';

const internalAgentService = new InternalAgentService();

export class SourceMigrationError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'SourceMigrationError';
  }
}

export const sourceMigrationService = {
  /** Create or resume the migration for one installation. */
  async createOrResume(
    tenantId: string,
    accountId: string | null,
    params: {
      source: MigrationSource;
      sourceVersion?: string;
      adapterVersion: string;
      installationFingerprint: string;
    },
  ): Promise<SourceMigration> {
    const existing = await repo.createOrResume(tenantId, { ...params, accountId });

    // A resumed migration does not consume a creation slot; only a genuinely
    // new record is admitted. `createOrResume` returns an existing row when
    // one is live, so a fresh row is detectable by its empty bundle and
    // importing state.
    if (existing.bundle === null && existing.state === 'importing') {
      const recent = await repo.countRecentForAccount(
        tenantId,
        accountId,
        MIGRATION_CREATION_WINDOW_HOURS,
      );
      // The row just created counts itself; admit against the state that
      // existed before it.
      const admission = checkMigrationCreationAdmission({
        recentMigrationCount: Math.max(0, recent - 1),
      });
      if (!admission.allowed) {
        await repo.setState(tenantId, existing.id, 'failed', { lastError: admission.detail });
        throw new SourceMigrationError(admission.detail, 429, admission.code);
      }
    }

    return existing;
  },

  async getById(tenantId: string, migrationId: string): Promise<SourceMigration | null> {
    return repo.getById(tenantId, migrationId);
  },

  /** Accept a versioned, redacted bundle and build the pre-payment preview.
   *
   *  No LLM work runs here. This produces a NORMALIZED PREVIEW: items, routines
   *  and connection requirements, plus the placeholders the user reconnects
   *  during review. */
  async acceptBundle(
    tenantId: string,
    accountId: string,
    migrationId: string,
    bundle: MigrationBundleV1,
  ): Promise<SourceMigration> {
    const migration = await repo.getById(tenantId, migrationId);
    if (!migration) {
      throw new SourceMigrationError('Migration not found', 404, 'not_found');
    }
    if (migration.state === 'active') {
      throw new SourceMigrationError(
        'This migration has already completed cutover.',
        409,
        'already_active',
      );
    }

    // A bundle may be REPLACED freely until the first model call, and not after.
    //
    // Re-uploading is the supported way to pick up a change the person made to
    // their installation after seeing the review screen — the fingerprint is
    // path-derived and cannot see content change, so without this a first scan
    // would be permanent. But saveBundle re-derives the migration state, so
    // accepting one mid-conversion would rewind a build that is running and
    // that the tenant is already paying for. upsertItem protects a built item's
    // distill input; nothing protected the state.
    //
    // The CLI applies the same boundary before it uploads. It is repeated here
    // because a rule that lives only in a client is not a rule.
    const REPLACEABLE_BEFORE_BUILD: MigrationState[] = [
      'importing',
      'setup_required',
      'payment_required',
      'failed',
    ];
    if (migration.bundle && !REPLACEABLE_BEFORE_BUILD.includes(migration.state)) {
      throw new SourceMigrationError(
        'This import is already being built, so it cannot be replaced. Finish or retry the ' +
          'current build first.',
        409,
        'bundle_locked_by_conversion',
      );
    }

    // ── items: one per selected persistent identity ────────────────────
    for (const agent of bundle.agents) {
      const distillInput: StoredDistillInput = {
        role: agent.role,
        responsibilities: agent.responsibilities,
        additionalContext: agent.additionalContext,
        attachments: agent.attachments,
        integrationRefs: agent.integrationRefs,
        mcpServerRefs: agent.mcpServerRefs,
        routineRefs: agent.routineRefs,
        originalLabel: agent.originalLabel,
        cronExpr: agent.cronExpr,
        modelPreference: agent.modelPreference,
      };
      await repo.upsertItem(tenantId, {
        migrationId,
        sourceRef: agent.sourceRef,
        normalizedInputHash: hashDistillInput(distillInput),
        distillInput,
      });
    }

    // ── routines: imported disabled, awaiting their first run ──────────
    for (const routine of bundle.routines) {
      await repo.upsertRoutine(tenantId, {
        migrationId,
        sourceRef: routine.sourceRef,
        name: routine.name,
        cronExpr: routine.cronExpr,
        prompt: routine.prompt,
        enabledInSource: routine.enabledInSource,
        routineRef: `switch:${migrationId}:${routine.sourceRef}`,
      });
    }

    // ── stdio resolution: decide what each local server actually IS before
    //    anything is materialized ────────────────────────────────────────
    //
    // A stdio server the source ran locally is usually a wrapper around an API
    // we already reach — as a governed catalog connector, or as an endpoint the
    // vendor hosts. Resolving it here is what turns "we cannot run this" into a
    // connection the user can complete. Anything unresolved keeps the Requires
    // hosting card it already had.
    const resolvedHosting = await resolveHostingRequirements(bundle.hostingRequirements);
    const catalogRequirements = [
      ...bundle.catalogConnectorRequirements,
      ...resolvedHosting.catalog,
    ];
    const mcpRequirements = [...bundle.customMcpServerRequirements, ...resolvedHosting.mcp];

    // ── connections: placeholders now, so reconnection can happen during
    //    review and agents can bind to concrete UUIDs at conversion ─────
    const ctx = { tenantId, accountId, migrationId, source: bundle.source };
    const catalog = await materializeCatalogPlaceholders(ctx, catalogRequirements);
    await materializeMcpPlaceholders(ctx, mcpRequirements);

    // A re-import replaces the bundle, so a connection the person removed from
    // their installation must stop being waited on. Without this it lingers as
    // Needs Reconnect that nothing can satisfy and nothing can clear, and the
    // build can never start — the stale row outlives the thing it described.
    const pruned = await repo.pruneConnectionsNotIn(tenantId, migrationId, [
      ...catalogRequirements.map((r) => r.sourceRef),
      ...mcpRequirements.map((r) => r.sourceRef),
    ]);
    if (pruned > 0) {
      log.info({ tenantId, migrationId, pruned }, 'source-migrations: dropped connections the source no longer references');
    }

    const unsupportedItems = [...bundle.unsupportedItems];
    for (const type of catalog.unsupported) {
      unsupportedItems.push({
        sourceRef: `connector:${type}`,
        reason: 'connector_not_connectable',
        detail:
          `${type} cannot be connected in Liftoff right now, so it was not created as a ` +
          'reconnect card. Choose an alternative or leave this capability out.',
      });
    }

    const state: MigrationState = deriveStateAfterBundle(bundle, unsupportedItems.length);

    const saved = await repo.saveBundle(tenantId, migrationId, bundle, {
      state,
      unsupportedItems,
      // Only what is STILL unresolved. A server that resolved to a connector or
      // a hosted endpoint has a card of its own now, and listing it here as
      // well would ask the user to go and host something Liftoff already
      // reaches.
      hostingRequirements: resolvedHosting.remaining,
      // The adapter's own notes about what it had to give up, plus what
      // resolution decided. Hard-coding [] here meant the normalizer decided
      // what to drop and nothing kept the decision.
      diagnostics: [...(bundle.diagnostics ?? []), ...resolvedHosting.diagnostics],
    });
    if (!saved) throw new SourceMigrationError('Migration not found', 404, 'not_found');
    return saved;
  },

  /** Post-payment conversion. Runs the canonical distill → create → absorption
   *  path for each selected identity. */
  async convert(
    tenantId: string,
    accountId: string,
    migrationId: string,
    entitlement: EntitlementSnapshot,
    actorId?: string,
    /** Restrict the run to these source refs. A retry on one failed team
     *  member should rebuild that member and nothing else — the others either
     *  already exist or failed for their own reasons, and sweeping them into
     *  someone's retry spends model calls they did not ask for. */
    onlySourceRefs?: string[],
  ): Promise<SourceMigration> {
    const migration = await repo.getById(tenantId, migrationId);
    if (!migration) throw new SourceMigrationError('Migration not found', 404, 'not_found');
    if (!migration.bundle) {
      throw new SourceMigrationError('No import has been uploaded yet.', 400, 'no_bundle');
    }
    if (migration.state === 'active') {
      throw new SourceMigrationError('This migration is already active.', 409, 'already_active');
    }

    const items = await repo.listItems(tenantId, migrationId);
    const targeted = onlySourceRefs?.length
      ? items.filter((i) => onlySourceRefs.includes(i.sourceRef))
      : items;
    // Already-built members are skipped whatever is asked for: a destination
    // agent id is the end of the line for that item.
    const outstanding = targeted.filter((i) => i.state !== 'converted');

    // Every imported connection must be reconnected first. The distiller
    // shapes each team member around the integrations it is given, so building
    // against a connector still in `error` produces a member built for tools it
    // cannot reach — broken on arrival, and only fixable by building it again.
    //
    // Enforced here and not only in the wizard: a rule that lives in the
    // browser is not a rule.
    // Resolved live, and NOT best-effort: an unreachable connector-service must
    // stop the build rather than let it proceed on a stale copy that says
    // everything is fine.
    const connections = await resolveConnectionStatuses(
      tenantId,
      accountId,
      await repo.listConnections(tenantId, migrationId),
    );
    const unreconnected = connections.filter(
      (c) => c.status === 'needs_reconnect' || c.status === 'placeholder_pending',
    );
    if (unreconnected.length > 0) {
      throw new SourceMigrationError(
        `${unreconnected.length} imported connection(s) still need reconnecting. ` +
          'Reconnect them before building, so the team is not built against tools it cannot use.',
        409,
        'connections_not_reconnected',
      );
    }

    // The payment gate. Nothing billable has run before this line.
    const admission = checkConversionAdmission({ entitlement });
    if (!admission.allowed) {
      await repo.setState(tenantId, migrationId, 'payment_required', {
        lastError: admission.detail,
      });
      throw new SourceMigrationError(admission.detail, 402, admission.code);
    }

    // A targeted retry rebuilds one member of a migration that has already
    // finished. The migration as a whole has NOT gone back to building, and
    // saying so would throw every viewer back to the progress screen for work
    // that concerns a single row.
    const alreadyFinished =
      migration.state === 'conversion_ready' || migration.state === 'ready_to_cutover';
    const isTargetedRetry = Boolean(onlySourceRefs?.length) && alreadyFinished;

    if (!isTargetedRetry) {
      // Queued first, then converting. The two are distinct on purpose: a
      // client polling between admission and the first worker starting should
      // see that its request was accepted rather than a stale payment_required.
      await repo.setState(tenantId, migrationId, 'conversion_queued');
      await repo.setState(tenantId, migrationId, 'converting');
    }

    // Bounded concurrency: at most MAX_CONCURRENT_ITEM_DISTILLS in flight.
    const queue = [...outstanding];
    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENT_ITEM_DISTILLS, Math.max(queue.length, 1)) },
      async () => {
        for (;;) {
          const item = queue.shift();
          if (!item) return;
          await this.convertItem(tenantId, accountId, migration, item, actorId);
        }
      },
    );
    await Promise.all(workers);

    const after = await repo.listItems(tenantId, migrationId);
    const anyFailed = after.some((i) => i.state === 'failed');
    const allDone = after.every((i) => i.state === 'converted' || i.state === 'failed');

    // A targeted retry never moves the migration backwards; it only ever
    // resolves the row it was asked about.
    const nextState: MigrationState = allDone
      ? anyFailed
        ? 'conversion_ready'
        : 'ready_to_cutover'
      : isTargetedRetry
        ? migration.state
        : 'converting';

    const updated = await repo.setState(tenantId, migrationId, nextState, {
      convertedAt: allDone,
    });
    return updated ?? migration;
  },

  /** Finish the items a rate-limited conversion left behind.
   *
   *  Called by the resume sweep, never by a person. It differs from `convert`
   *  in what it deliberately does NOT do: it selects nothing (the selection was
   *  made when the build started, and re-selecting would build members somebody
   *  deselected), it does not re-check connections (they were reconnected
   *  before the build was allowed to start), and it never moves the migration
   *  backwards.
   *
   *  It DOES re-check the billing authority. Spend is decided by
   *  `billing_controls` and the OU buckets and by nothing else (INV-PB-010),
   *  and a subscription can lapse between one wave and the next. */
  async resumePendingItems(
    tenantId: string,
    accountId: string,
    migrationId: string,
  ): Promise<void> {
    const migration = await repo.getById(tenantId, migrationId);
    if (!migration || !migration.bundle) return;
    if (migration.state !== 'converting') return;

    const pending = (await repo.listItems(tenantId, migrationId)).filter(
      (i) => i.state === 'pending',
    );
    if (pending.length === 0) return;

    const entitlement = await readEntitlementSnapshot(tenantId);
    const admission = checkConversionAdmission({ entitlement });
    if (!admission.allowed) {
      await repo.setState(tenantId, migrationId, 'payment_required', {
        lastError: admission.detail,
      });
      log.warn(
        { tenantId, migrationId, code: admission.code },
        'source-migrations: resume halted — the billing authority no longer admits this build',
      );
      return;
    }

    const queue = [...pending];
    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENT_ITEM_DISTILLS, Math.max(queue.length, 1)) },
      async () => {
        for (;;) {
          const item = queue.shift();
          if (!item) return;
          await this.convertItem(tenantId, accountId, migration, item);
        }
      },
    );
    await Promise.all(workers);

    // An item that still could not reserve a slot stays pending, and the next
    // sweep takes it. The migration only leaves `converting` once every item
    // has actually settled.
    const after = await repo.listItems(tenantId, migrationId);
    const allDone = after.every((i) => i.state === 'converted' || i.state === 'failed');
    if (!allDone) return;

    const anyFailed = after.some((i) => i.state === 'failed');
    await repo.setState(
      tenantId,
      migrationId,
      anyFailed ? 'conversion_ready' : 'ready_to_cutover',
      { convertedAt: true },
    );
  },

  /** Convert one item. This is where the determinism rules live. */
  async convertItem(
    tenantId: string,
    accountId: string,
    migration: SourceMigration,
    item: SourceMigrationItem,
    actorId?: string,
  ): Promise<void> {
    // 1. Already mapped: return it. Never distill, never create.
    if (item.destinationAgentId) return;

    // 2. Distill succeeded previously but creation did not finish: create from
    //    the stored output. Never redistill.
    const replay = item.distillOutput !== null;

    if (!replay) {
      const retry = mayRetryItem(item.attemptCount);
      if (!retry.allowed) {
        await repo.setItemState(tenantId, item.id, 'failed', { lastError: retry.detail });
        return;
      }

      // Every distill attempt reserves capacity through the shared ledger.
      const slot = await reserveDistillSlot({ tenantId, accountId });
      if (!slot.allowed) {
        await repo.setItemState(tenantId, item.id, 'pending', { lastError: slot.detail });
        return;
      }
    }

    await repo.setItemState(tenantId, item.id, replay ? 'creating' : 'distilling', {
      incrementAttempt: !replay,
    });

    try {
      const bindings = await resolveAgentBindings(
        tenantId,
        migration.id,
        item.distillInput.integrationRefs,
        item.distillInput.mcpServerRefs,
      );

      const distillInput: DistillInput = {
        role: item.distillInput.role,
        responsibilities: item.distillInput.responsibilities,
        additionalContext: item.distillInput.additionalContext ?? null,
        integrations: bindings.integrations,
        tenantId,
        attachments: toTeamAttachments(item.distillInput),
      };

      const result = await provisionAgentFromDistill({
        tenantId,
        distillInput,
        integrations: bindings.integrations.map((i) => ({
          id: i.id,
          name: i.name,
          type: i.type,
          selectedObjects: i.selectedObjects,
        })),
        pendingIntegrations: bindings.pendingIntegrations,
        // Deterministic: a crash between create and mapping recovery finds the
        // same key and returns the same agent instead of making a second one.
        idempotencyKey: `switch:${migration.id}:agent:${item.sourceRef}`,
        actorId,
        // Imported team members stay drafts until the user confirms cutover.
        status: 'draft',
        // Consent follows scope (invariant 9). Only artifact names the user
        // explicitly approved reach the shared knowledge library; everything
        // else stays agent-scoped, which lands immediately and stays
        // governable. An empty list means nothing is shared, which is the
        // correct default for a curated help centre.
        libraryApprovals: migration.libraryApprovals,
        // The source told us when this runs. Let the distiller describe the
        // work, but never let it guess a schedule we already know.
        triggerOverride: item.distillInput.cronExpr
          ? { type: 'cron' as const, cronExpr: item.distillInput.cronExpr }
          : undefined,
        existingDistillOutput: replay
          ? (item.distillOutput as unknown as Awaited<ReturnType<typeof provisionAgentFromDistill>>['distillOutput'])
          : undefined,
        onDistillComplete: async (output) => {
          await repo.saveDistillOutput(tenantId, item.id, output as unknown as Record<string, unknown>);
        },
      });

      await repo.saveDestinationAgent(tenantId, item.id, result.agent.id);

      // Give this member the FILES its imported skills ship with.
      //
      // Distillation and absorption settle the skill TEXT, and neither of them
      // ever sees a file: the classifier reads the material the person is
      // importing, and a `scripts/run.py` is not material to classify. So the
      // files are applied here, from the bundle, against the agent that just
      // resulted — otherwise they would be validated at the edge, stored in the
      // migration, and quietly never become anything.
      const importedSkillsWithFiles = (migration.bundle?.skills ?? []).filter(
        (s) => s.identitySourceRef === item.sourceRef && (s.files?.length ?? 0) > 0,
      );
      if (importedSkillsWithFiles.length > 0) {
        try {
          const { applyImportedSkills } = await import('../internal-agents/skill-import-service');
          const applied = await applyImportedSkills(
            tenantId,
            result.agent.id,
            importedSkillsWithFiles.map((s) => ({
              name: s.name,
              // The skill's own one-line purpose is not carried separately by
              // the bundle, so the source path stands in: it says WHICH file
              // this came from, which is what a person reading it needs.
              description: `Imported from ${s.sourcePath}`,
              instruction: s.content,
              files: s.files,
            })),
          );
          log.info(
            {
              tenantId,
              migrationId: migration.id,
              agentId: result.agent.id,
              withFiles: importedSkillsWithFiles.length,
              imported: applied.imported,
              skipped: applied.skippedAsDuplicate,
            },
            'source-migrations: applied imported skill files',
          );
        } catch (err) {
          // A file that did not land must not fail a team member that did.
          log.error(
            {
              tenantId,
              migrationId: migration.id,
              agentId: result.agent.id,
              error: (err as Error).message,
            },
            'source-migrations: imported skill files could not be applied; the member was still created',
          );
        }
      }

      // Bind the imported routines for this identity to the agent that
      // resulted. They stay disabled until cutover.
      const routines = await repo.listRoutines(tenantId, migration.id);
      for (const routine of routines) {
        if (item.distillInput.routineRefs.includes(routine.sourceRef) && !routine.destinationAgentId) {
          await repo.upsertRoutine(tenantId, {
            migrationId: migration.id,
            sourceRef: routine.sourceRef,
            name: routine.name,
            cronExpr: routine.cronExpr,
            prompt: routine.prompt,
            enabledInSource: routine.enabledInSource,
            routineRef: routine.routineRef,
            itemId: item.id,
          });
        }
      }
    } catch (err) {
      const message = (err as Error).message;
      log.error(
        { error: message, tenantId, migrationId: migration.id, sourceRef: item.sourceRef },
        'source-migrations: item conversion failed',
      );
      await repo.setItemState(tenantId, item.id, 'failed', { lastError: message });
    }
  },

  /** Cutover. Deliberately small.
   *
   *  Liftoff does not verify that OpenClaw or Hermes is stopped: the user owns
   *  that decision, and the confirmation screen says plainly that leaving
   *  equivalent source schedules active can execute work twice. */
  async activate(
    tenantId: string,
    migrationId: string,
    entitlement: EntitlementSnapshot,
    actorId?: string,
  ): Promise<SourceMigration> {
    const migration = await repo.getById(tenantId, migrationId);
    if (!migration) throw new SourceMigrationError('Migration not found', 404, 'not_found');

    // Idempotent: activating an already-active migration is a no-op, so a
    // double-submitted confirmation cannot activate a team twice.
    if (migration.state === 'active') return migration;

    if (!entitlement.paid) {
      throw new SourceMigrationError(
        'A paid subscription is required before activating the imported team.',
        402,
        'payment_required',
      );
    }

    const items = await repo.listItems(tenantId, migrationId);
    const converted = items.filter((i) => i.destinationAgentId);
    if (converted.length === 0) {
      throw new SourceMigrationError(
        'Nothing has been converted yet, so there is nothing to activate.',
        400,
        'nothing_to_activate',
      );
    }

    // Activate through the canonical path. NEVER a raw status update:
    // updateStatus verifies workflow integrity, increments the version, writes
    // the audit record and atomically publishes the full activation
    // configuration to the Tenant Runtime. A direct UPDATE would leave the
    // runtime ignorant of the entire team.
    for (const item of converted) {
      await internalAgentService.updateStatus(
        item.destinationAgentId as string,
        tenantId,
        'active',
        actorId,
      );
    }

    // Enable the routines the user accepted. Each carries its stable
    // routine_ref and starts 'awaiting' its first scheduled run.
    const routines = await repo.listRoutines(tenantId, migrationId);
    for (const routine of routines) {
      if (!routine.accepted) continue;
      const owner =
        routine.destinationAgentId ??
        converted.find((i) => i.id === routine.itemId)?.destinationAgentId ??
        converted[0]?.destinationAgentId;
      if (!owner) continue;
      await repo.markRoutineEnabled(tenantId, routine.id, owner);
    }

    const updated = await repo.setState(tenantId, migrationId, 'active', { completedAt: true });
    log.info(
      { tenantId, migrationId, activated: converted.length, routines: routines.length },
      'source-migrations: cutover complete',
    );
    return updated ?? migration;
  },

  /** Record the first terminal scheduled outcome for an imported routine.
   *
   *  Idempotent and first-write-wins, so a duplicate delivery is a no-op. */
  async recordFirstRun(
    tenantId: string,
    routineRef: string,
    outcome: { status: 'succeeded' | 'failed'; errorCategory?: string | null; occurredAt?: Date },
  ): Promise<boolean> {
    return repo.recordFirstRun(tenantId, routineRef, outcome);
  },

  /** The view the CLI and the wizard both read. */
  async buildView(
    tenantId: string,
    migration: SourceMigration,
    opts: { onboardingComplete: boolean; accountId?: string },
  ): Promise<MigrationView> {
    const items = await repo.listItems(tenantId, migration.id);
    const stored = await repo.listConnections(tenantId, migration.id);

    // Status is resolved against connector-service, never read from the local
    // copy alone: the copy is written once at import and the reconnect happens
    // in another service's database.
    //
    // Best-effort HERE and refused in `convert`. If connector-service cannot be
    // reached, a screen that falls back to "needs reconnect" is pessimistic and
    // harmless; a build gate that fell back to "reconnected" would be neither.
    let connections = stored;
    if (opts.accountId) {
      try {
        connections = await resolveConnectionStatuses(tenantId, opts.accountId, stored);
      } catch (err) {
        log.warn(
          { tenantId, migrationId: migration.id, err },
          'source-migrations: could not refresh connection status; showing the stored one',
        );
      }
    }

    const requirements: MigrationRequirement[] = [];

    const needsReconnect = connections.filter((c) => c.status === 'needs_reconnect');
    if (needsReconnect.length > 0) {
      requirements.push({
        kind: 'credential',
        detail: `${needsReconnect.length} connection(s) need to be reconnected in Liftoff.`,
        resolvePath: '/dashboard/connections',
      });
    }

    if (migration.hostingRequirements.length > 0) {
      requirements.push({
        kind: 'hosting',
        detail:
          `${migration.hostingRequirements.length} imported server(s) run locally and need ` +
          'hosting before Liftoff can reach them.',
        resolvePath: '/dashboard/connections',
      });
    }

    if (migration.state === 'payment_required') {
      requirements.push({
        kind: 'payment',
        detail:
          'This workspace does not currently have an active plan with room for the imported ' +
          'team. Check your plan, then build.',
        resolvePath: `/dashboard/switch/${migration.source}/review`,
      });
    }

    if (migration.state === 'setup_required') {
      requirements.push({
        kind: 'selection',
        detail: 'Some imported material does not fit and needs your attention.',
        resolvePath: `/dashboard/switch/${migration.source}/review`,
      });
    }

    const routines = await repo.listRoutines(tenantId, migration.id);

    // Consent candidates: workspace-scoped material the import would like to
    // put in the shared knowledge library. Agent-scoped context is not listed
    // here because it lands without asking (invariant 9).
    const consentCandidates = (migration.bundle?.memories ?? [])
      .filter((m) => m.scope === 'workspace')
      .map((m) => m.sourceRef);

    if (consentCandidates.length > migration.libraryApprovals.length) {
      requirements.push({
        kind: 'consent',
        detail:
          `${consentCandidates.length - migration.libraryApprovals.length} imported item(s) would ` +
          'be shared with the whole workspace. Choose which ones, if any.',
        resolvePath: `/dashboard/switch/${migration.source}/review`,
      });
    }

    return {
      id: migration.id,
      source: migration.source,
      state: migration.state,
      itemCount: items.length,
      convertedCount: items.filter((i) => i.state === 'converted').length,
      unsupportedCount: migration.unsupportedItems.length,
      items: items.map((i) => ({
        sourceRef: i.sourceRef,
        role: i.distillInput.role,
        state: i.state,
        destinationAgentId: i.destinationAgentId ?? undefined,
        lastError: i.lastError ?? undefined,
      })),
      requirements,
      webPath: webPathForState(migration.source, migration.state),
      onboardingComplete: opts.onboardingComplete,
      unsupportedItems: migration.unsupportedItems,
      hostingRequirements: migration.hostingRequirements,
      routines: routines.map((r) => ({
        sourceRef: r.sourceRef,
        name: r.name,
        cronExpr: r.cronExpr,
        accepted: r.accepted,
        enabledInSource: r.enabledInSource,
        firstRunStatus: r.firstRunStatus,
        firstRunErrorCategory: r.firstRunErrorCategory ?? undefined,
      })),
      connections: connections.map((c) => ({
        sourceRef: c.sourceRef,
        kind: c.kind,
        connectorType: c.connectorType,
        displayName: c.displayName ?? undefined,
        endpointUrl: c.endpointUrl ?? undefined,
        authScheme: c.authScheme ?? undefined,
        connectorId: c.connectorId ?? undefined,
        status: c.status,
      })),
      consentCandidates,
      libraryApprovals: migration.libraryApprovals,
      pauseGuidance: pauseGuidanceFor(migration.source),
    };
  },

  async findLatest(
    tenantId: string,
    accountId: string | null,
    source: MigrationSource,
  ): Promise<SourceMigration | null> {
    return repo.findLatest(tenantId, accountId, source);
  },

  async setConsent(
    tenantId: string,
    migrationId: string,
    approvedArtifactNames: string[],
  ): Promise<SourceMigration> {
    const updated = await repo.setLibraryApprovals(tenantId, migrationId, approvedArtifactNames);
    if (!updated) throw new SourceMigrationError('Migration not found', 404, 'not_found');
    return updated;
  },

  async setRoutineAccepted(
    tenantId: string,
    migrationId: string,
    sourceRef: string,
    accepted: boolean,
  ): Promise<void> {
    const ok = await repo.setRoutineAcceptedByRef(tenantId, migrationId, sourceRef, accepted);
    if (!ok) throw new SourceMigrationError('Imported routine not found', 404, 'not_found');
  },
};

/** Read the ONE money authority. This module consumes the decision and never
 *  computes or caches a second one (INV-PB-010).
 *
 *  Reads exactly three things: whether execution is allowed, whether the
 *  account is suspended, and the operational status. There is no seat or team
 *  cap, because pricing is consumption of Operating Units — a workspace may run
 *  as many teams as it wants. The query used to select `max_active_agents` for
 *  a capacity check; that column was dropped from `entitlements` long ago and
 *  exists in no environment, so every conversion failed with a 500 before any
 *  decision was reached. The cap it fed should never have been there. */
export async function readEntitlementSnapshot(tenantId: string): Promise<EntitlementSnapshot> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query<{
      agent_execution_allowed: boolean;
      operational_status: string | null;
      suspended: boolean | null;
    }>(
      `SELECT e.agent_execution_allowed,
              e.tenant_operational_status AS operational_status,
              bc.suspended
         FROM entitlements e
         JOIN tenants t ON t.id = e.tenant_id
         LEFT JOIN billing_controls bc ON bc.account_id = t.account_id
        WHERE e.tenant_id = $1`,
      [tenantId],
    );

    const row = res.rows[0];
    if (!row) return { paid: false };

    return {
      paid: Boolean(row.agent_execution_allowed) && !row.suspended,
      operationalStatus: row.suspended ? 'suspended' : row.operational_status ?? 'active',
    };
  });
}

function deriveStateAfterBundle(bundle: MigrationBundleV1, unsupportedCount: number): MigrationState {
  // Overflow no longer gates anything. The importer packs to fit and drops the
  // least valuable material by priority, so there is nothing for the person
  // importing to arbitrate — asking them to pick which of their own files to
  // delete is our schema bound leaking into their day.
  //
  // The one genuine blocker left: nothing to convert. That is not a
  // preference, it is an empty import.
  if (bundle.agents.length === 0) return 'setup_required';
  void unsupportedCount;
  return 'payment_required';
}

// The wizard has exactly THREE screens, and this must name them: review, then
// building, then done. It is what the CLI opens and what a reload resolves to,
// so a name the wizard does not use sends the browser to a URL that immediately
// rewrites itself — and `setup` / `cutover` are screens that no longer exist at
// all. Mirrored by stageForState() in the web app.
function webPathForState(source: MigrationSource, state: MigrationState): string {
  const base = `/dashboard/switch/${source}`;
  switch (state) {
    // Everything before the build is one screen: what we found, what needs
    // reconnecting, and the choices about scheduled work.
    case 'importing':
    case 'setup_required':
    case 'payment_required':
    case 'failed':
      return `${base}/review`;
    case 'conversion_queued':
    case 'converting':
      return `${base}/building`;
    // Built and awaiting launch. Whether to start them is the user's call.
    case 'conversion_ready':
    case 'ready_to_cutover':
    case 'active':
      return `${base}/done`;
    default:
      return `${base}/review`;
  }
}

function hashDistillInput(input: StoredDistillInput): string {
   
  const crypto = require('crypto') as typeof import('crypto');
  const canonical = JSON.stringify({
    role: input.role,
    responsibilities: input.responsibilities,
    additionalContext: input.additionalContext ?? null,
    integrationRefs: [...input.integrationRefs].sort(),
    mcpServerRefs: [...input.mcpServerRefs].sort(),
    routineRefs: [...input.routineRefs].sort(),
    cronExpr: input.cronExpr ?? null,
    attachments: input.attachments.map((a) => ({
      name: a.name,
      category: a.category,
      sourcePaths: a.sourcePaths,
      contentHash: crypto.createHash('sha256').update(a.content).digest('hex'),
    })),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** Imported attachments are uploads: their text is carried inline. A connector
 *  attachment would reference a live document in a customer's drive, which an
 *  import has no basis to claim. */
function toTeamAttachments(input: StoredDistillInput): TeamAttachment[] {
  return input.attachments.map((a) => ({
    kind: 'upload' as const,
    name: a.name,
    content: a.content,
    addedAt: new Date().toISOString(),
    source: a.category === 'instructions' ? ('responsibilities' as const) : ('guidance' as const),
  }));
}

export type { AdmissionResult };
