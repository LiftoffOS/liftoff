// Liftoff Switch — orchestration endpoints.
//
// Every route is tenant-scoped and carries an UNCONDITIONAL membership guard.
// Identity is not tenancy: authMiddleware proves who is calling,
// tenantAuthMiddleware proves they belong to the tenant they named. The guard
// is mounted with `router.use` so it cannot be skipped by a route added later,
// and it is never nested inside a conditional — a guard inside an `if` matches
// the pattern while failing the property, which is how authorization has
// switched itself off in this codebase before.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { tenantAuthMiddleware } from '../infrastructure/middleware';
import { authedWithDelegation } from '../support-delegation/authed';
import { log } from '../infrastructure/logging';
import { withTenantScope } from '../infrastructure/database';
import { AccountService } from '../accounts/service';
import {
  readEntitlementSnapshot,
  sourceMigrationService,
  SourceMigrationError,
} from './service';
import { completeImportedMcpServer, CompleteImportError } from './custom-mcp-import';
import { MAX_BUNDLE_FILES, MAX_BUNDLE_FILE_BYTES } from '../internal-agents/skill-bundle';
import type { MigrationBundleV1 } from './types';

export const sourceMigrationsRouter = Router();

const accountService = new AccountService();

// Authentication for every route in this module.
sourceMigrationsRouter.use(authedWithDelegation);
// Tenancy for every route in this module. tenantAuthMiddleware resolves the
// tenant from params, query or body and proves membership before any handler
// runs.
sourceMigrationsRouter.use(tenantAuthMiddleware('editTeams'));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createSchema = z.object({
  tenantId: z.string().uuid(),
  source: z.enum(['openclaw', 'hermes', 'claude-code', 'codex']),
  sourceVersion: z.string().max(64).optional(),
  adapterVersion: z.string().min(1).max(64),
  installationFingerprint: z.string().min(8).max(128),
});

// The bundle is validated at the edge rather than trusted: it crossed a
// process boundary from a machine we do not control.
const attachmentSchema = z.object({
  name: z.string().min(1).max(255),
  content: z.string().max(100_000),
  category: z.enum(['instructions', 'skill', 'memory', 'routine']),
  sourcePaths: z.array(z.string().max(1024)).max(200),
});

/** One edge between two imported agents. Shared by both spellings of the key. */
const relationshipSchema = z.object({
  fromSourceRef: z.string().max(512),
  toSourceRef: z.string().max(512),
  kind: z.enum(['delegates_to', 'shares_workspace']),
});

const agentSchema = z.object({
  sourceRef: z.string().min(1).max(512),
  role: z.string().min(1).max(255),
  responsibilities: z.string().min(1).max(10_000),
  additionalContext: z.string().max(10_000).optional(),
  originalLabel: z.string().max(2048).optional(),
  attachments: z.array(attachmentSchema).max(20),
  integrationRefs: z.array(z.string().max(512)).max(50),
  mcpServerRefs: z.array(z.string().max(512)).max(200),
  routineRefs: z.array(z.string().max(512)).max(200),
  // How this team member runs. Missing here, zod STRIPPED it — the CLI sent
  // every imported schedule and the validator silently deleted it, so
  // distill_input.cronExpr was null for every item and every trigger came from
  // the distiller's guess instead of the source. Nothing failed: the type says
  // the field exists, the parse result is cast to it, and the loss is invisible
  // from either side.
  cronExpr: z.string().max(128).optional(),
  modelPreference: z
    .object({
      provider: z.string().max(64).optional(),
      model: z.string().max(128).optional(),
      note: z.string().max(512).optional(),
    })
    .optional(),
});

const bundleSchema = z.object({
  bundleVersion: z.literal(1),
  // Bounded like everything else that crossed the network: these are notes for
  // support, not a channel for arbitrary payload.
  diagnostics: z.array(z.string().max(1024)).max(500).optional(),
  source: z.enum(['openclaw', 'hermes', 'claude-code', 'codex']),
  sourceVersion: z.string().max(64).optional(),
  adapterVersion: z.string().min(1).max(64),
  installationFingerprint: z.string().min(8).max(128),
  // Bounded for payload safety, not as a product limit: there is no cap on how
  // many team members an import may carry. Conversion is rate-limited and
  // resumes itself, so a large import takes several waves rather than being
  // refused. 500 matches the other per-bundle array bounds.
  agents: z.array(agentSchema).max(500),
  // `teamRelationships` IS THE RETIRED SPELLING AND IS STILL ACCEPTED, for the
  // same reason the MCP addressing argument keeps its old name: @liftoffos/cli
  // is published, so an install that predates the rename keeps sending the key
  // it was built with. Renaming it outright would reject those bundles at the
  // schema, which is the worst place to fail — the person has already run the
  // import and waited for it.
  agentRelationships: z.array(relationshipSchema).max(500).optional(),
  teamRelationships: z.array(relationshipSchema).max(500).optional(),
  instructions: z.array(z.record(z.string(), z.unknown())).max(1000),
  skills: z
    .array(
      z.object({
        sourceRef: z.string().max(512),
        identitySourceRef: z.string().max(512),
        name: z.string().max(255),
        content: z.string().max(100_000),
        sourcePath: z.string().max(1024),
        // NAMES only, held to what an environment variable may be called — the
        // same pattern the locker enforces, so a name that arrives here can
        // actually be stored.
        referencedSecretNames: z
          .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/))
          .max(50)
          .optional(),
        // The skill's own files. Mirrors the caps in skill-bundle.ts, which
        // were calibrated against 160 real skills: past them what arrives is a
        // vendored repository rather than a skill.
        files: z
          .array(
            z.object({
              path: z.string().min(1).max(512),
              text: z.string().max(MAX_BUNDLE_FILE_BYTES),
              executable: z.boolean().optional(),
            }),
          )
          .max(MAX_BUNDLE_FILES)
          .optional(),
      }),
    )
    .max(500),
  memories: z
    .array(
      z.object({
        sourceRef: z.string().max(512),
        identitySourceRef: z.string().max(512),
        content: z.string().max(100_000),
        scope: z.enum(['agent', 'workspace']),
        sourcePath: z.string().max(1024),
      }),
    )
    .max(1000),
  routines: z
    .array(
      z.object({
        sourceRef: z.string().max(512),
        identitySourceRef: z.string().max(512),
        name: z.string().max(255),
        cronExpr: z.string().max(128),
        prompt: z.string().max(100_000),
        enabledInSource: z.boolean(),
      }),
    )
    .max(200),
  catalogConnectorRequirements: z
    .array(
      z.object({
        sourceRef: z.string().max(512),
        connectorType: z.string().max(64),
        usedByIdentityRefs: z.array(z.string().max(512)).max(100),
        usedByRoutineRefs: z.array(z.string().max(512)).max(200),
        externalAccountLabel: z.string().max(255).optional(),
        authMethod: z.string().max(32).optional(),
      }),
    )
    .max(200),
  customMcpServerRequirements: z
    .array(
      z.object({
        sourceRef: z.string().max(512),
        name: z.string().max(255),
        url: z.string().url().max(2048),
        transport: z.literal('http'),
        authScheme: z.enum(['none', 'api_key', 'bearer', 'custom_headers']),
        customHeaderNames: z.array(z.string().max(128)).max(50).optional(),
        usedByIdentityRefs: z.array(z.string().max(512)).max(100),
      }),
    )
    .max(100),
  hostingRequirements: z
    .array(
      z.object({
        sourceRef: z.string().max(512),
        name: z.string().max(255),
        command: z.string().max(1024).optional(),
        args: z.array(z.string().max(1024)).max(100).optional(),
        url: z.string().max(2048).optional(),
        reason: z.enum(['stdio_mcp_requires_hosting', 'unreachable_mcp_endpoint']),
        usedByIdentityRefs: z.array(z.string().max(512)).max(100),
        // The package the command runs, when it names one. Bounded like every
        // other client-supplied string: this value is used to build a registry
        // query, so it is not allowed to be arbitrarily long.
        packageIdentity: z
          .object({
            registryType: z.enum(['npm', 'pypi', 'oci']),
            name: z.string().min(1).max(512),
          })
          .optional(),
      }),
    )
    .max(200),
  governanceRules: z.array(z.record(z.string(), z.unknown())).max(500),
  modelPreferences: z.array(z.record(z.string(), z.unknown())).max(100),
  unsupportedItems: z
    .array(
      z.object({
        sourceRef: z.string().max(512),
        reason: z.string().max(64),
        detail: z.string().max(2048),
        sourcePath: z.string().max(1024).optional(),
      }),
    )
    .max(2000),
});

const uploadSchema = z.object({
  tenantId: z.string().uuid(),
  bundle: bundleSchema,
});

/** Whether the workspace has finished standard onboarding.
 *
 *  The wizard runs only after onboarding completes in this release. The server
 *  is the authority; the CLI must not infer it. */
async function isOnboardingComplete(tenantId: string): Promise<boolean> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query<{ onboarding_completed_at: Date | null }>(
      `SELECT onboarding_completed_at FROM tenants WHERE id = $1`,
      [tenantId],
    );
    return Boolean(res.rows[0]?.onboarding_completed_at);
  });
}

async function resolveAccountId(req: Request): Promise<string | null> {
  const firebaseUid = req.user?.uid;
  if (!firebaseUid) return null;
  const account = await accountService.getByFirebaseUid(firebaseUid);
  return account?.id ?? null;
}

function handleError(res: Response, err: unknown): Response {
  if (err instanceof SourceMigrationError) {
    return res.status(err.statusCode).json({ error: err.message, errorCode: err.code });
  }
  log.error({ error: (err as Error).message }, 'source-migrations: request failed');
  return res.status(500).json({ error: 'Migration request failed' });
}

// POST /api/source-migrations — create or resume, idempotent per installation.
sourceMigrationsRouter.post('/', async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
  }
  const { tenantId, ...params } = parsed.data;

  try {
    // The import belongs to the person running the CLI, not to the workspace.
    const accountId = await resolveAccountId(req);
    const migration = await sourceMigrationService.createOrResume(tenantId, accountId, params);
    const view = await sourceMigrationService.buildView(tenantId, migration, {
      onboardingComplete: await isOnboardingComplete(tenantId),
      accountId: (await resolveAccountId(req)) ?? undefined,
    });
    return res.status(201).json(view);
  } catch (err) {
    return handleError(res, err);
  }
});

// GET /api/source-migrations/latest — the migration currently open for this
// source. The wizard resumes from this rather than from a client-held id, so a
// user landing on the route from anywhere sees their real position.
//
// Declared BEFORE '/:id' so the literal path wins over the parameter.
sourceMigrationsRouter.get('/latest', async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string | undefined;
  const source = req.query.source as string | undefined;
  if (!tenantId || !UUID_RE.test(tenantId)) {
    return res.status(400).json({ error: 'tenantId (UUID) is required' });
  }
  if (source !== 'openclaw' && source !== 'hermes') {
    return res.status(400).json({ error: 'source must be openclaw or hermes' });
  }

  try {
    // This person's import, not the workspace's most recent one.
    const latestForAccount = await resolveAccountId(req);
    const migration = await sourceMigrationService.findLatest(tenantId, latestForAccount, source);
    if (!migration) return res.json({ migration: null });
    const view = await sourceMigrationService.buildView(tenantId, migration, {
      onboardingComplete: await isOnboardingComplete(tenantId),
      accountId: (await resolveAccountId(req)) ?? undefined,
    });
    return res.json({ migration: view });
  } catch (err) {
    return handleError(res, err);
  }
});

// POST /api/source-migrations/:id/consent — record which imported material the
// user approved for the shared knowledge library.
const consentSchema = z.object({
  tenantId: z.string().uuid(),
  approvedArtifactNames: z.array(z.string().max(512)).max(1000),
});

sourceMigrationsRouter.post('/:id/consent', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'Migration id must be a UUID' });
  }
  const parsed = consentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
  }

  try {
    const migration = await sourceMigrationService.setConsent(
      parsed.data.tenantId,
      req.params.id,
      parsed.data.approvedArtifactNames,
    );
    const view = await sourceMigrationService.buildView(parsed.data.tenantId, migration, {
      onboardingComplete: await isOnboardingComplete(parsed.data.tenantId),
      accountId: (await resolveAccountId(req)) ?? undefined,
    });
    return res.json(view);
  } catch (err) {
    return handleError(res, err);
  }
});

// POST /api/source-migrations/:id/routines/accept — accept or decline an
// imported routine. Declining records that the capability was omitted; it does
// not delete anything in the source.
const routineAcceptSchema = z.object({
  tenantId: z.string().uuid(),
  sourceRef: z.string().min(1).max(512),
  accepted: z.boolean(),
});

sourceMigrationsRouter.post('/:id/routines/accept', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'Migration id must be a UUID' });
  }
  const parsed = routineAcceptSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
  }

  try {
    await sourceMigrationService.setRoutineAccepted(
      parsed.data.tenantId,
      req.params.id,
      parsed.data.sourceRef,
      parsed.data.accepted,
    );
    return res.json({ ok: true });
  } catch (err) {
    return handleError(res, err);
  }
});

// PUT /api/source-migrations/:id/bundle — accept the redacted bundle and build
// the pre-payment preview. No LLM work runs here.
sourceMigrationsRouter.put('/:id/bundle', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'Migration id must be a UUID' });
  }
  const parsed = uploadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid bundle', details: parsed.error.issues });
  }
  const { tenantId, bundle } = parsed.data;

  // Collapse the two spellings into the one the rest of the service knows about,
  // here at the edge, so nothing downstream has to know the rename happened. A
  // bundle carrying neither key is a bundle with no relationships, which is
  // valid and common — both are optional precisely so an old CLI and a new one
  // are equally acceptable.
  const normalisedBundle = {
    ...bundle,
    teamRelationships: bundle.agentRelationships ?? bundle.teamRelationships ?? [],
  };

  try {
    const accountId = await resolveAccountId(req);
    if (!accountId) return res.status(401).json({ error: 'Account not found' });

    const migration = await sourceMigrationService.acceptBundle(
      tenantId,
      accountId,
      req.params.id,
      normalisedBundle as unknown as MigrationBundleV1,
    );
    const view = await sourceMigrationService.buildView(tenantId, migration, {
      onboardingComplete: await isOnboardingComplete(tenantId),
      accountId,
    });
    return res.json(view);
  } catch (err) {
    return handleError(res, err);
  }
});

// POST /api/source-migrations/:id/convert — post-payment conversion.
sourceMigrationsRouter.post('/:id/convert', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'Migration id must be a UUID' });
  }
  const tenantId = (req.body?.tenantId ?? req.query.tenantId) as string | undefined;
  if (!tenantId || !UUID_RE.test(tenantId)) {
    return res.status(400).json({ error: 'tenantId (UUID) is required' });
  }

  // Optional: retry just these team members rather than everything outstanding.
  const rawRefs = (req.body as { sourceRefs?: unknown } | undefined)?.sourceRefs;
  let sourceRefs: string[] | undefined;
  if (rawRefs !== undefined) {
    if (
      !Array.isArray(rawRefs) ||
      rawRefs.length > 25 ||
      !rawRefs.every((r) => typeof r === 'string' && r.length > 0 && r.length <= 512)
    ) {
      return res.status(400).json({ error: 'sourceRefs must be an array of up to 25 strings' });
    }
    sourceRefs = rawRefs as string[];
  }

  try {
    const accountId = await resolveAccountId(req);
    if (!accountId) return res.status(401).json({ error: 'Account not found' });

    // Subscription truth comes from the existing billing authority, never from
    // a value this module stored.
    const entitlement = await readEntitlementSnapshot(tenantId);
    const migration = await sourceMigrationService.convert(
      tenantId,
      accountId,
      req.params.id,
      entitlement,
      accountId,
      sourceRefs,
    );
    const view = await sourceMigrationService.buildView(tenantId, migration, {
      onboardingComplete: await isOnboardingComplete(tenantId),
      accountId,
    });
    return res.json(view);
  } catch (err) {
    return handleError(res, err);
  }
});

// GET /api/source-migrations/:id
sourceMigrationsRouter.get('/:id', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'Migration id must be a UUID' });
  }
  const tenantId = req.query.tenantId as string | undefined;
  if (!tenantId || !UUID_RE.test(tenantId)) {
    return res.status(400).json({ error: 'tenantId (UUID) is required' });
  }

  try {
    const migration = await sourceMigrationService.getById(tenantId, req.params.id);
    if (!migration) return res.status(404).json({ error: 'Migration not found' });
    const view = await sourceMigrationService.buildView(tenantId, migration, {
      onboardingComplete: await isOnboardingComplete(tenantId),
      accountId: (await resolveAccountId(req)) ?? undefined,
    });
    return res.json(view);
  } catch (err) {
    return handleError(res, err);
  }
});

// POST /api/source-migrations/:id/connections/:connectorId/complete-import
//
// Completes an IMPORTED custom MCP server: fresh credentials or a tunnel, then
// discovery, then both projections go active. Heals the imported placeholder
// rather than creating a second server.
const completeImportSchema = z.object({
  tenantId: z.string().uuid(),
  authType: z.enum(['none', 'api_key', 'bearer', 'custom_headers']),
  apiKey: z.string().max(4096).optional(),
  bearerToken: z.string().max(4096).optional(),
  customHeaders: z
    .array(z.object({ name: z.string().min(1).max(128), value: z.string().max(4096) }))
    .max(50)
    .optional(),
  endpointUrl: z.string().url().max(2048).optional(),
  tunnelRouteId: z.string().uuid().optional(),
  confirmedUnauthenticated: z.boolean().optional(),
});

sourceMigrationsRouter.post(
  '/:id/connections/:connectorId/complete-import',
  async (req: Request, res: Response) => {
    if (!UUID_RE.test(req.params.id) || !UUID_RE.test(req.params.connectorId)) {
      return res.status(400).json({ error: 'Migration id and connector id must be UUIDs' });
    }
    const parsed = completeImportSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    }
    const { tenantId, ...input } = parsed.data;

    try {
      const result = await completeImportedMcpServer({
        tenantId,
        migrationId: req.params.id,
        connectorId: req.params.connectorId,
        input,
      });
      return res.json(result);
    } catch (err) {
      if (err instanceof CompleteImportError) {
        return res.status(err.statusCode).json({ error: err.message, errorCode: err.code });
      }
      return handleError(res, err);
    }
  },
);

// POST /api/source-migrations/:id/activate — cutover.
//
// Requires a current paid subscription AND an explicit user confirmation. The
// confirmation is the request itself: the wizard only sends it from the cutover
// screen, which shows the source pause guidance and the duplicate-execution
// warning.
sourceMigrationsRouter.post('/:id/activate', async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'Migration id must be a UUID' });
  }
  const tenantId = (req.body?.tenantId ?? req.query.tenantId) as string | undefined;
  if (!tenantId || !UUID_RE.test(tenantId)) {
    return res.status(400).json({ error: 'tenantId (UUID) is required' });
  }
  if (req.body?.confirmed !== true) {
    return res.status(400).json({
      error: 'Explicit cutover confirmation is required',
      errorCode: 'confirmation_required',
    });
  }

  try {
    const accountId = await resolveAccountId(req);
    if (!accountId) return res.status(401).json({ error: 'Account not found' });

    const entitlement = await readEntitlementSnapshot(tenantId);
    const migration = await sourceMigrationService.activate(
      tenantId,
      req.params.id,
      entitlement,
      accountId,
    );
    const view = await sourceMigrationService.buildView(tenantId, migration, {
      onboardingComplete: await isOnboardingComplete(tenantId),
      accountId,
    });
    return res.json(view);
  } catch (err) {
    return handleError(res, err);
  }
});
