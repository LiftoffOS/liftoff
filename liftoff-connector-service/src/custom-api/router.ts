// Custom API connections, over HTTP.
//
// Mount path: /api/connectors/custom-api (see server.ts), behind the same
// service auth every other subtree here sits behind. Platform-backend is the
// only caller: it owns the conversation half (the workspace action, the
// confirmation, the capture tokens and the capture page) and calls this to
// register or reconnect an instance.
//
// The tool-schema endpoint is the one piece neither the ordinary connector
// path nor the custom-MCP path gives us for free. `ListTools`
// (`catalog/tool-schemas.ts`) says its own design outright — "The source of
// truth is the static registry. No database reads" — aggregated per connector
// TYPE with a global version hash, so per-instance operations cannot travel
// through it. This is their door. Execution still goes through the existing
// Execute path; only the schemas need a new one.

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../infra/logging.js';
import { getConnectorById } from '../oauth/connector-ops.js';
import {
  getCustomApiConnector,
  listCustomApiConnectors,
} from './repository.js';
import { checkSupportedSubset, customApiSpecSchema } from './spec.js';
import { fetchOpenApiDocument, SpecFetchError } from './spec-fetch.js';
import { generateOperations, isRefusal } from './operations.js';
import {
  CUSTOM_API_CONNECTOR_TYPE,
  registerCustomApiConnection,
  refreshCustomApiSpec,
  reverifyCustomApiConnection,
  updateCustomApiConnectionAndVerify,
} from './service.js';
import type { CustomApiConnectorRow } from './types.js';

export const customApiRouter = Router();

function getAccountId(req: Request): string | null {
  const h = req.header('x-account-id');
  return h && typeof h === 'string' && h.length > 0 ? h : null;
}

/** The version tag the runtime's schema cache short-circuits on.
 *
 *  `<updatedAt>|<opCount>` — the same contract shape platform-backend's
 *  custom-MCP raw-tools endpoint has. Compared, never parsed. */
export function customApiCacheVersion(row: CustomApiConnectorRow): string {
  return `${row.updatedAt.toISOString()}|${row.ops.length}`;
}

const describeSchema = z.object({
  tenantId: z.string().min(1).max(200),
  spec: customApiSpecSchema,
});

// POST /describe — read the specification and say what connecting it would
// give, WITHOUT creating anything.
//
// The confirmation a person is shown before a capture link is minted has to
// carry the number of operations the specification yields, and that number is
// only knowable by reading the document. Reading it here rather than in
// platform-backend keeps the OpenAPI machinery in one service — and means an
// unsupported specification is refused BEFORE anybody is handed a link for a
// connection that could never be registered.
customApiRouter.post('/describe', async (req: Request, res: Response) => {
  const parsed = describeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'invalid_body',
      issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const { spec } = parsed.data;
  try {
    const fetched = await fetchOpenApiDocument(spec.specSourceUrl);
    const review = checkSupportedSubset(spec, fetched.document);
    if (review.refusal) return res.status(422).json(review.refusal);
    const generated = generateOperations(
      fetched.document,
      spec.baseUrl,
      review.skipped.map((s) => s.operation),
    );
    if (isRefusal(generated)) return res.status(422).json(generated);
    return res.json({
      operationCount: generated.operations.length,
      specHash: fetched.hash,
      // A handful of names, so the confirmation can say what kind of thing
      // this connection carries rather than only how many.
      sampleOperations: generated.operations.slice(0, 8).map((op) => op.name),
      // What the connection will NOT carry, so the person deciding hears it
      // BEFORE they decide rather than discovering a missing endpoint later.
      ...(review.skipped.length
        ? {
          skippedCount: review.skipped.length,
          skippedOperations: review.skipped.slice(0, 8).map((s) => s.operation),
          skippedReasons: [...new Set(review.skipped.map((s) => s.reason))].slice(0, 5),
        }
        : {}),
    });
  } catch (err) {
    if (err instanceof SpecFetchError) {
      return res.status(422).json({ refused: 'unsupported_specification', message: err.message });
    }
    logger.error({ err: (err as Error).message }, 'custom_api_describe_failed');
    return res.status(500).json({ error: 'describe_failed' });
  }
});

const registerSchema = z.object({
  tenantId: z.string().min(1).max(200),
  attemptId: z.string().min(1).max(200),
  spec: customApiSpecSchema,
  credential: z.string().min(1).max(8192),
  reconnectConnectorId: z.string().uuid().optional(),
});

// POST /register — capture, then verify, then active.
//
// The credential arrives here and goes straight to Secret Manager through
// credentialService; it is never written to a row, never logged, and never
// echoed back in the response.
customApiRouter.post('/register', async (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'invalid_body',
      issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const accountId = getAccountId(req);
  if (!accountId) {
    return res.status(401).json({ error: 'Authentication required (x-account-id header)' });
  }
  const { tenantId, attemptId, spec, credential, reconnectConnectorId } = parsed.data;
  try {
    const result = await registerCustomApiConnection({
      tenantId,
      accountId,
      attemptId,
      spec,
      credential,
      ...(reconnectConnectorId ? { reconnectConnectorId } : {}),
    });
    if ('refused' in result) {
      // 422: the request was well formed and the SPECIFICATION was not
      // acceptable. A refusal names the offending operations so the assistant
      // has something to relay and the person something to decide.
      return res.status(422).json(result);
    }
    return res.json(result);
  } catch (err) {
    logger.error(
      { tenantId, attemptId, err: (err as Error).message },
      'custom_api_register_failed',
    );
    return res.status(500).json({ error: 'registration_failed' });
  }
});

// ── Phase 7: repair and removal ──────────────────────────────────────────
//
// Three of the four controls are here; the fourth, removing the connection, is
// the ordinary connector delete (this table's foreign key cascades with it).
// None of them implies another: a re-verify does not change the key, an edit
// does not ask for one, a revoke keeps the connection and every binding, and a
// delete touches no AI team's schedule.

const tenantBodySchema = z.object({ tenantId: z.string().min(1).max(200) });
/** `apply` is the second step. Absent means look and report. */
const specRefreshSchema = z.object({
  tenantId: z.string().min(1).max(200),
  apply: z.boolean().optional(),
});

// POST /:connectorId/verify — re-run the declared verification with the
// credential already in custody.
//
// The repair that needs no new key: a connection that went to `error` on a 429,
// or against an endpoint that was briefly gone, comes back without anybody
// being asked for anything.
customApiRouter.post('/:connectorId/verify', async (req: Request, res: Response) => {
  const parsed = tenantBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'tenantId is required' });
  try {
    const outcome = await reverifyCustomApiConnection({
      tenantId: parsed.data.tenantId,
      connectorId: req.params.connectorId,
    });
    return res.json(outcome);
  } catch (err) {
    logger.error(
      { err: (err as Error).message, connectorId: req.params.connectorId },
      'custom_api_verify_failed',
    );
    return res.status(500).json({ error: 'verification_failed' });
  }
});

const updateSchema = z.object({
  tenantId: z.string().min(1).max(200),
  name: z.string().min(1).max(200).optional(),
  baseUrl: z.string().url().max(2000).optional(),
  apiHosts: z.array(z.string().min(1).max(253)).min(1).max(20).optional(),
  auth: customApiSpecSchema.shape.auth.optional(),
  verification: customApiSpecSchema.shape.verification.optional(),
});

// PATCH /:connectorId — hosts, placement and verification, editable IN PLACE.
//
// Never delete-and-recreate: the connector id is what every bound AI team
// holds and what its tool names are derived from, so rebuilding the connection
// to change one field would break every binding to fix nothing. The credential
// is untouched — correcting where a request goes is not a reason to ask
// somebody for the key again — and the verification runs afterwards, so an
// edit that made the connection worse says so and one that repaired it comes
// back to `active` on its own.
customApiRouter.patch('/:connectorId', async (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'invalid_body',
      issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const { tenantId, name, baseUrl, apiHosts, auth, verification } = parsed.data;
  try {
    const updated = await updateCustomApiConnectionAndVerify({
      tenantId,
      connectorId: req.params.connectorId,
      changes: {
        ...(name !== undefined ? { name } : {}),
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(apiHosts !== undefined ? { apiHosts } : {}),
        ...(auth !== undefined ? { authPlacement: auth } : {}),
        ...(verification !== undefined ? { verification } : {}),
      },
    });
    if (updated === null) return res.status(404).json({ error: 'not_found' });
    // 422: the request was well formed and the RESULT would not have been a
    // connection that could reach anything.
    if ('refused' in updated) return res.status(422).json(updated);
    return res.json({
      connection: projectConnection(updated.row),
      verification: updated.verification,
    });
  } catch (err) {
    logger.error(
      { err: (err as Error).message, connectorId: req.params.connectorId },
      'custom_api_update_failed',
    );
    return res.status(500).json({ error: 'update_failed' });
  }
});

// POST /:connectorId/revoke — discard OUR copy of the key, keep everything else.
//
// Separate from removing the connection on purpose: the description, the
// operations and every binding survive, and the connection asks to be
// reconnected. It revokes NOTHING at the provider, which the caller says in as
// many words — an API key has no revocation endpoint to call, so the key keeps
// working wherever else it is used until somebody revokes it there.
// POST /:connectorId/spec-refresh — read the provider's specification again.
//
// Two steps, because applying can REMOVE an operation and an AI team bound to
// it loses it: `apply: false` reports what changed and writes nothing.
customApiRouter.post('/:connectorId/spec-refresh', async (req: Request, res: Response) => {
  const parsed = specRefreshSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'tenantId is required' });
  try {
    const result = await refreshCustomApiSpec({
      tenantId: parsed.data.tenantId,
      connectorId: req.params.connectorId,
      apply: parsed.data.apply === true,
    });
    if (result === null) return res.status(404).json({ error: 'not_found' });
    if ('refused' in result) return res.status(422).json(result);
    return res.json(result);
  } catch (err) {
    logger.error(
      { err: (err as Error).message, connectorId: req.params.connectorId },
      'custom_api_spec_refresh_failed',
    );
    return res.status(500).json({ error: 'spec_refresh_failed' });
  }
});

/** What a caller outside this service may see. Never the credential — there is
 *  none on the row — and never the full operation schemas, which travel on the
 *  tool endpoint below. */
function projectConnection(row: CustomApiConnectorRow): Record<string, unknown> {
  return {
    connectorId: row.connectorId,
    name: row.name,
    providerSlug: row.providerSlug,
    baseUrl: row.baseUrl,
    apiHosts: row.apiHosts,
    auth: row.authPlacement,
    verification: row.verification,
    operationCount: row.ops.length,
    // The names as well as the count: the Connections page lists them the way
    // it lists a custom MCP server's tools, and a count on its own says
    // nothing about what the connection can actually do.
    operations: row.ops.map((op) => op.name),
    specSourceUrl: row.specSourceUrl,
    specHash: row.specHash,
    specFetchedAt: row.specFetchedAt?.toISOString() ?? null,
    // Drift is the two hashes DIFFERING, resolved here so no reader has to
    // know that and none can get it wrong. Absent means never swept, which is
    // not the same as up to date and must not read as drift.
    specDrifted: row.specDriftHash !== null && row.specDriftHash !== row.specHash,
    specDriftCheckedAt: row.specDriftCheckedAt?.toISOString() ?? null,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    completedByAccountId: row.completedByAccountId,
    updatedAt: row.updatedAt.toISOString(),
    version: customApiCacheVersion(row),
  };
}

// GET /?tenantId= — the workspace's custom API connections, for the runtime's
// schema cache to enumerate and for a person reading the Connections page.
customApiRouter.get('/', async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId;
  if (typeof tenantId !== 'string' || tenantId === '') {
    return res.status(400).json({ error: 'tenantId is required' });
  }
  try {
    const rows = await listCustomApiConnectors(tenantId);
    return res.json({ connections: rows.map(projectConnection) });
  } catch (err) {
    logger.error({ err: (err as Error).message, tenantId }, 'custom_api_list_failed');
    return res.status(500).json({ error: 'list_failed' });
  }
});

// GET /:connectorId/tools?tenantId= — the per-instance tool schemas.
//
// Keyed by CONNECTOR ID, because that is what makes these operations this
// workspace's: `custom_api_connector` is one shared type and two workspaces'
// connections under it have nothing to do with each other.
customApiRouter.get('/:connectorId/tools', async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId;
  if (typeof tenantId !== 'string' || tenantId === '') {
    return res.status(400).json({ error: 'tenantId is required' });
  }
  try {
    const row = await getCustomApiConnector(tenantId, req.params.connectorId);
    if (!row) return res.status(404).json({ error: 'not_found' });
    const connector = await getConnectorById(tenantId, req.params.connectorId);
    return res.json({
      connectorId: row.connectorId,
      name: row.name,
      // The connection's own state travels with its tools so a consumer does
      // not have to ask twice to know whether they can be called.
      status: connector?.status ?? 'error',
      tools: row.ops.map((op) => ({
        name: op.name,
        description: op.description,
        inputSchema: op.inputSchema,
        entityType: op.entityType,
        // The MERGED classification, carried verbatim. Both halves matter
        // downstream: the effect tokens decide the HITL gate, and the
        // sensitivity names are matched literally by the Sensitive Work
        // settings, so neither may be filtered on the way out.
        categories: op.categories,
      })),
      version: customApiCacheVersion(row),
    });
  } catch (err) {
    logger.error({ err: (err as Error).message, connectorId: req.params.connectorId }, 'custom_api_tools_failed');
    return res.status(500).json({ error: 'tools_failed' });
  }
});

export { CUSTOM_API_CONNECTOR_TYPE };

// GET /:connectorId?tenantId= — ONE connection, as a person managing it sees
// it: the description, the counts, and whether it has ever verified. Never the
// credential (the row holds none) and never the operation schemas, which are
// what the tools endpoint above is for.
//
// Registered after `/:connectorId/tools` so the more specific path is matched
// first, and after `/describe` and `/register` for the same reason.
customApiRouter.get('/:connectorId', async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId;
  if (typeof tenantId !== 'string' || tenantId === '') {
    return res.status(400).json({ error: 'tenantId is required' });
  }
  try {
    const row = await getCustomApiConnector(tenantId, req.params.connectorId);
    if (!row) return res.status(404).json({ error: 'not_found' });
    return res.json({ connection: projectConnection(row) });
  } catch (err) {
    logger.error(
      { err: (err as Error).message, connectorId: req.params.connectorId },
      'custom_api_get_failed',
    );
    return res.status(500).json({ error: 'get_failed' });
  }
});
