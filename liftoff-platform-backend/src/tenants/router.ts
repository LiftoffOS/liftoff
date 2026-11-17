// Tenants Router
// Per Section 1: Control plane owns tenant provisioning

import { Router } from 'express';
import { z } from 'zod';
import { TenantService } from './service';
import { logAudit } from '../infrastructure/logging';
import { pool } from '../infrastructure/database';
import { WORKSPACE_AI_SELECTIONS } from '../model-registry/workspace-ai-vendors';

export const tenantsRouter = Router();
const service = new TenantService();

const agentInstructionsMdSchema = z.object({
  instructionsMd: z.string().max(100000).nullable(),
});

// List all tenants
tenantsRouter.get('/', async (req, res, next) => {
  try {
    const tenants = await service.listAll();
    res.json(tenants);
  } catch (error) {
    next(error);
  }
});

// Provision a new tenant
tenantsRouter.post('/', async (req, res, next) => {
  try {
    const tenant = await service.provision(req.body);

    logAudit('tenant.provisioned', req.ctx, {
      tenantId: tenant.id,
      accountId: tenant.accountId,
      name: tenant.name,
    });

    res.status(201).json(tenant);
  } catch (error) {
    next(error);
  }
});

// Get tenant by ID
tenantsRouter.get('/:id', async (req, res, next) => {
  try {
    const tenant = await service.getById(req.params.id);
    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }
    res.json(tenant);
  } catch (error) {
    next(error);
  }
});

// Get tenants by account ID
tenantsRouter.get('/account/:accountId', async (req, res, next) => {
  try {
    const tenants = await service.getByAccountId(req.params.accountId);
    res.json(tenants);
  } catch (error) {
    next(error);
  }
});

// Activate a tenant
tenantsRouter.post('/:id/activate', async (req, res, next) => {
  try {
    const tenant = await service.activate(req.params.id);

    logAudit('tenant.activated', req.ctx, {
      tenantId: tenant.id,
    });

    res.json(tenant);
  } catch (error) {
    next(error);
  }
});

// Suspend a tenant
tenantsRouter.post('/:id/suspend', async (req, res, next) => {
  try {
    const tenant = await service.suspend(req.params.id);

    logAudit('tenant.suspended', req.ctx, {
      tenantId: tenant.id,
    });

    res.json(tenant);
  } catch (error) {
    next(error);
  }
});

// Reactivate a tenant
tenantsRouter.post('/:id/reactivate', async (req, res, next) => {
  try {
    const tenant = await service.reactivate(req.params.id);

    logAudit('tenant.reactivated', req.ctx, {
      tenantId: tenant.id,
    });

    res.json(tenant);
  } catch (error) {
    next(error);
  }
});

// Update migration status
tenantsRouter.post('/:id/migration-status', async (req, res, next) => {
  try {
    const { status } = req.body;
    const tenant = await service.updateMigrationStatus(req.params.id, status);

    logAudit('tenant.migration_status_updated', req.ctx, {
      tenantId: tenant.id,
      migrationStatus: status,
    });

    res.json(tenant);
  } catch (error) {
    next(error);
  }
});

// Update GCP project info (called after Terraform provisioning)
tenantsRouter.post('/:id/gcp-project', async (req, res, next) => {
  try {
    const { gcpProjectId, databaseName } = req.body;
    const tenant = await service.updateGcpProject(req.params.id, gcpProjectId, databaseName);

    logAudit('tenant.gcp_project_updated', req.ctx, {
      tenantId: tenant.id,
      gcpProjectId,
      databaseName,
    });

    res.json(tenant);
  } catch (error) {
    next(error);
  }
});

// PATCH /tenants/:id  — rename workspace and/or update onboarding state
// Owner / admin only. The same endpoint handles:
//   - { name }                           rename (sidebar switcher updates)
//   - { onboardingStep }                 save resume position
//   - { onboardingPersona }              save step-2 answer
//   - { onboardingCompleted: true }      set onboarding_completed_at
// The onboardingHireInput / onboardingHireChosenStatus fields that lived here
// are gone (ADR-050). They carried the first hire across the payment boundary;
// the hire now happens after onboarding, so nothing writes them — and their
// columns are dropped in the follow-up release, which a surviving writer here
// would 42703 against in the window before the new revision is serving.
const patchTenantSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  onboardingStep: z.number().int().min(0).max(20).optional(),
  onboardingPersona: z.string().trim().min(1).max(50).nullable().optional(),
  onboardingCompleted: z.boolean().optional(),
  // Fused-onboarding fields.
  onboardingPath: z.enum(['A','B']).optional(),
  // Must stay in step with OnboardingStepId and migration 366's CHECK. Rejecting
  // a retired id here rather than at the constraint is deliberate: zod answers
  // 400, the constraint would answer 23514 and a 500.
  //
  // 'all_set' was dropped in migration 371, paired with this enum. It stayed
  // accepted for exactly one release because the revision serving during 370's
  // migration window still wrote it at the end of onboarding; the revision
  // serving now cannot produce it.
  onboardingStepId: z.enum([
    'welcome','workspace_name','persona','plan','payment','invite',
  ]).optional(),
  // Workspace AI vendor selection (settings dropdown). 'default' = Liftoff
  // Managed (restores the platform-managed policy and clears the marker).
  // Maps onto model_configs.routing_policy via
  // model-registry/workspace-ai-vendors.ts — the values here are UI vendor
  // names, translated server-side (glm/qwen/deepseek/kimi/grok all execute via
  // provider 'openrouter').
  // Built from WORKSPACE_AI_SELECTIONS rather than restated. This was a second
  // copy of the vocabulary, and a vendor added to the map but missing here is
  // rejected with `invalid_body` — the dropdown offers it and the PATCH refuses
  // it, which reads as a frontend bug. The per-agent override schema in
  // internal-agents already builds off the same list.
  workspaceAiVendor: z.enum(WORKSPACE_AI_SELECTIONS).optional(),
});

tenantsRouter.patch('/:id', async (req, res, next) => {
  try {
    const parsed = patchTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body', details: parsed.error.errors });
      return;
    }
    const tenantId = req.params.id;

    // Membership check: owner or admin of this tenant.
    const firebaseUid = req.user?.uid;
    if (!firebaseUid) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const { AccountService } = await import('../accounts/service');
    const { tenantMembersService } = await import('../tenant-members/service');
    const accountService = new AccountService();
    const account = await accountService.getByFirebaseUid(firebaseUid);
    if (!account?.id) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const membership = await tenantMembersService.getMembership(tenantId, account.id);
    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    // Snapshot pre-mutation state so the audit rows can carry real diffs.
    // Without this, tenant.renamed only knew the new name; reviewers can't
    // reconstruct what the previous value was without joining against other
    // tables (which may not have the historical record).
    const prior = await service.getById(tenantId);

    let tenant = parsed.data.name !== undefined
      ? await service.updateName(tenantId, parsed.data.name)
      : null;

    const hasOnboardingUpdate =
      parsed.data.onboardingStep !== undefined ||
      parsed.data.onboardingPersona !== undefined ||
      parsed.data.onboardingCompleted !== undefined ||
      parsed.data.onboardingPath !== undefined ||
      parsed.data.onboardingStepId !== undefined;

    if (hasOnboardingUpdate) {
      tenant = await service.updateOnboardingProgress(tenantId, {
        step: parsed.data.onboardingStep,
        persona: parsed.data.onboardingPersona,
        completed: parsed.data.onboardingCompleted,
        onboardingPath: parsed.data.onboardingPath,
        onboardingStepId: parsed.data.onboardingStepId,
      });
    }

    // Workspace AI vendor selection — applied via the model-registry service
    // (routing-policy rebuild + single-row invariant + TR sync event). Audited
    // with the prior selection so vendor flips are reconstructable in review.
    if (parsed.data.workspaceAiVendor !== undefined) {
      const { ModelRegistryService } = await import('../model-registry/service');
      const modelRegistryService = new ModelRegistryService();
      const priorVendor = await modelRegistryService.getWorkspaceVendor(tenantId);
      await modelRegistryService.setWorkspaceVendor(tenantId, parsed.data.workspaceAiVendor);
      logAudit('tenant.workspace_ai_changed', req.ctx, {
        resourceType: 'tenant',
        resourceId: tenantId,
        previousState: { workspaceAiVendor: priorVendor },
        newState: { workspaceAiVendor: parsed.data.workspaceAiVendor },
      });
    }

    if (parsed.data.name !== undefined) {
      logAudit('tenant.renamed', req.ctx, {
        resourceType: 'tenant',
        resourceId: tenantId,
        previousState: { name: prior?.name },
        newState: { name: parsed.data.name },
      });
    }
    if (hasOnboardingUpdate && tenant) {
      logAudit('tenant.onboarding_progress', req.ctx, {
        resourceType: 'tenant',
        resourceId: tenantId,
        previousState: prior ? {
          onboardingStep: prior.onboardingStep,
          onboardingPersona: prior.onboardingPersona,
          onboardingCompletedAt: prior.onboardingCompletedAt,
        } : null,
        newState: {
          onboardingStep: tenant.onboardingStep,
          onboardingPersona: tenant.onboardingPersona,
          onboardingCompletedAt: tenant.onboardingCompletedAt,
        },
      });
    }

    if (!tenant) {
      // No-op patch — return current state.
      const current = await service.getById(tenantId);
      if (!current) {
        res.status(404).json({ error: 'Tenant not found' });
        return;
      }
      tenant = current;
    }

    res.json(tenant);
  } catch (error) {
    next(error);
  }
});

// GET /tenants/:id/workspace-ai — current Workspace AI vendor selection.
// Same owner/admin membership gate as PATCH /tenants/:id (inline, because this
// route names the tenant param `:id` and the shared requireMinRole helper
// extracts `:tenantId`). Returns { vendor: 'default' | <vendor>, vendorModels,
// vendorCoding }: vendorModels is each named vendor's model display names,
// Frontier model first; vendorCoding is each named vendor's coding tool, with
// the model OpenCode is given. Neither has a 'default' key: Liftoff Managed
// shows no models.
tenantsRouter.get('/:id/workspace-ai', async (req, res, next) => {
  try {
    const tenantId = req.params.id;
    const firebaseUid = req.user?.uid;
    if (!firebaseUid) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const { AccountService } = await import('../accounts/service');
    const { tenantMembersService } = await import('../tenant-members/service');
    const account = await new AccountService().getByFirebaseUid(firebaseUid);
    if (!account?.id) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const membership = await tenantMembersService.getMembership(tenantId, account.id);
    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const { ModelRegistryService } = await import('../model-registry/service');
    const { getWorkspaceAiVendorModels, getWorkspaceAiVendorCoding } = await import(
      '../model-registry/workspace-ai-vendor-loader'
    );
    const [vendor, vendorModels, vendorCoding] = await Promise.all([
      new ModelRegistryService().getWorkspaceVendor(tenantId),
      getWorkspaceAiVendorModels(),
      getWorkspaceAiVendorCoding(),
    ]);
    res.json({ vendor, vendorModels, vendorCoding });
  } catch (error) {
    next(error);
  }
});

// ── BYO AI provider keys ─────────────────────────────────────────────────────
//
// Workspace AI (PATCH /:id { workspaceAiVendor }) answers WHICH provider a
// workspace's teams route to. These two answer the separate question of WHOSE
// account the calls bill to.
//
// Same owner/admin membership gate as PATCH /:id, inline for the same reason
// GET /:id/workspace-ai is: this route names the tenant param `:id` and the
// shared requireMinRole helper extracts `:tenantId`.

// GET /tenants/:id/ai-provider-keys — the stored keys, as redacted hints.
// Providers with no stored key are omitted; the card renders those fields empty
// and prompts for a key.
tenantsRouter.get('/:id/ai-provider-keys', async (req, res, next) => {
  try {
    const tenantId = req.params.id;
    const firebaseUid = req.user?.uid;
    if (!firebaseUid) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const { AccountService } = await import('../accounts/service');
    const { tenantMembersService } = await import('../tenant-members/service');
    const account = await new AccountService().getByFirebaseUid(firebaseUid);
    if (!account?.id) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const membership = await tenantMembersService.getMembership(tenantId, account.id);
    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const { getProviderKeys } = await import('../tenant-ai-provider-keys/service');
    res.json({ keys: await getProviderKeys(tenantId) });
  } catch (error) {
    next(error);
  }
});

// PUT /tenants/:id/ai-provider-keys — store or rotate keys.
//
// A MERGE, not a replace: a vendor absent from the body keeps whatever is
// stored. The card only submits fields the user typed into, so a replace would
// drop the other three keys every time somebody rotated one.
//
// Every submitted key is verified against its provider before anything is
// stored, and the whole write is rejected if any check fails — 400 with a
// per-provider message so the card can mark the offending field. A provider
// outage is a rejection too, never a silent store of something unchecked; that
// is what removes `unverified` from the status enum.
tenantsRouter.put('/:id/ai-provider-keys', async (req, res, next) => {
  try {
    const tenantId = req.params.id;
    const firebaseUid = req.user?.uid;
    if (!firebaseUid) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const { AccountService } = await import('../accounts/service');
    const { tenantMembersService } = await import('../tenant-members/service');
    const account = await new AccountService().getByFirebaseUid(firebaseUid);
    if (!account?.id) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const membership = await tenantMembersService.getMembership(tenantId, account.id);
    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const { parseKeyUpdateBody, updateProviderKeys } = await import(
      '../tenant-ai-provider-keys/service'
    );
    const update = parseKeyUpdateBody(req.body);
    if (!update) {
      res.status(400).json({ error: 'invalid_body' });
      return;
    }

    const result = await updateProviderKeys(tenantId, update);
    if (!result.ok) {
      res.status(400).json({ error: 'key_validation_failed', errors: result.errors });
      return;
    }

    // One audit row per vendor written, carrying the vendor and the
    // previous/new hint. Never the key.
    for (const change of result.changes) {
      logAudit('tenant.ai_provider_key_changed', req.ctx, {
        resourceType: 'tenant',
        resourceId: tenantId,
        vendor: change.vendor,
        previousState: { hint: change.previousHint },
        newState: { hint: change.newHint },
      });
    }

    res.json({ keys: result.keys });
  } catch (error) {
    next(error);
  }
});

// PATCH /tenants/:id/agent-instructions-md
// Admin-only: set the tenant-level CLAUDE.md loaded by every internal agent
// in this tenant. Zero-UI-change by design: authoring is via backend API +
// SQL only for phase 1.
tenantsRouter.patch('/:id/agent-instructions-md', async (req, res, next) => {
  try {
    const parsed = agentInstructionsMdSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
      return;
    }

    const result = await pool.query(
      `UPDATE tenants SET agent_instructions_md = $1, updated_at = NOW() WHERE id = $2 RETURNING id, agent_instructions_md`,
      [parsed.data.instructionsMd, req.params.id],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }

    logAudit('tenant.agent_instructions_md_updated', req.ctx, {
      tenantId: req.params.id,
      length: parsed.data.instructionsMd?.length ?? 0,
    });

    res.json({ id: result.rows[0].id, agentInstructionsMd: result.rows[0].agent_instructions_md });
  } catch (error) {
    next(error);
  }
});

// Get migration status and history for a tenant
tenantsRouter.get('/:id/migration', async (req, res, next) => {
  try {
    const migrationInfo = await service.getMigrationInfo(req.params.id);
    if (!migrationInfo) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }
    res.json(migrationInfo);
  } catch (error) {
    next(error);
  }
});

// ─── Fused-onboarding full-distill orchestration — REMOVED (ADR-050) ───
//
// Two routes lived here:
//
//   GET  /:tenantId/full-distill-status   — the provisioning loader's 1.5s poll
//   POST /:tenantId/restart-full-distill  — that screen's retry button
//
// Both existed to supervise a distill deferred past the payment step, because
// the first hire happened before the card. The hire now happens after
// onboarding at /dashboard/agents/explore, where the distill runs inline with
// its own progress stream, so there is no deferred work to watch or retry and
// no provisioning screen left to watch it from.
//
// Removed rather than left mounted: both read onboarding_full_distill_*, and
// those columns are dropped in the follow-up release. A reader surviving here
// would 42703 in the window between that migration and the new revision.
