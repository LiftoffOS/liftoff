// Generated Files Router
//
// Service-to-service endpoints used by the Tenant Runtime to:
//   POST /api/generated-files       — upload a file to GCS and record metadata
//   PATCH /api/generated-files/:id  — write back connector sync metadata
//
// Browser-facing endpoint (Firebase auth):
//   GET   /api/generated-files/:id/download — generate a fresh signed URL
//
// POST and PATCH: TENANT_RUNTIME_SERVICE_TOKEN via X-Service-Auth header
//   (same pattern as /api/agent-audit-logs).
// GET /download: Firebase ID token via Authorization: Bearer header.
//   Tenant isolation is enforced server-side: the caller's Firebase UID is
//   resolved to an account, then verified as a member of the tenant that
//   owns the file. The tenantId query param is required and verified against
//   membership — it is never trusted without this check.

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { withTenantScope, withAdminScope } from '../infrastructure/database';

import { authedWithDelegation } from '../support-delegation/authed';
import { generatedFilesBucket } from './gcs-client';
import { presentFile, PresentFileError } from './present';
import {
  documentOutputTypeSchema,
  isAllowedMediaMimeType,
  MEDIA_TYPES_HUMAN,
  outputTypeSchema,
  outputTypeToContentType,
  outputTypeToExt,
  storeMediaObject,
  UnsupportedMediaTypeError,
  type OutputType,
} from './store';
import { attachMedia, MediaScreeningRefusedError, mediaSurfaceSchema } from '../media/attach';
import * as chatRepo from '../agent-chat/chat-repository';
import { agentAuditLogsService } from '../agent-audit-logs/service';
import { log } from '../infrastructure/logging';
import { AccountService } from '../accounts/service';
import { tenantMembersService } from '../tenant-members';

export const generatedFilesRouter = Router();

const accountService = new AccountService();

// ── Multer — store in memory (files are streamed straight to GCS) ────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max
});

// ── Rate limiter ─────────────────────────────────────────────────────────

const uploadRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  keyGenerator: (req) => {
    const tenantId = req.body?.tenantId || 'unknown';
    const ip = ipKeyGenerator(req.ip || 'unknown');
    return `generated-files:${tenantId}:${ip}`;
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded', retryAfter: 60 },
});

// ── Service auth middleware ───────────────────────────────────────────────

const serviceAuthMiddleware = (req: Request, res: Response, next: () => void) => {
  const serviceToken = req.headers['x-service-auth'] as string | undefined;
  // Two services write files, not one. The tenant runtime produces a team's
  // output; connector-service produces what a custom API answered with, and it
  // must not get a second file store to do it — the whole point of `attach.ts`
  // is that there is one. Both are service secrets of the same trust class,
  // and this route already lets a service write for any tenant, so accepting
  // the second lowers no bar that the first did not already set.
  const accepted = [
    process.env.TENANT_RUNTIME_SERVICE_TOKEN,
    process.env.PLATFORM_CALLBACK_TOKEN,
  ].filter((t): t is string => typeof t === 'string' && t.length > 0);

  if (accepted.length === 0) {
    return res.status(500).json({ error: 'Service authentication not configured' });
  }

  // Compared against every configured token, and against all of them even
  // after one matches: a loop that stops early tells a caller which token it
  // got right by how long the answer took.
  let isValid = false;
  for (const expectedToken of accepted) {
    const sameLength = serviceToken
      && Buffer.byteLength(serviceToken) === Buffer.byteLength(expectedToken);
    const matches = sameLength
      && crypto.timingSafeEqual(Buffer.from(serviceToken), Buffer.from(expectedToken));
    isValid = isValid || matches === true;
  }

  if (!isValid) {
    return res.status(401).json({ error: 'Invalid service authentication' });
  }

  next();
};

// ── Zod schemas ──────────────────────────────────────────────────────────
//
// outputTypeSchema and the extension / content-type maps live in ./store, next
// to the code that writes the object, so the route and every in-process caller
// agree on what a stored artifact's content type is.

const uploadBodySchema = z.object({
  agentId: z.string().uuid(),
  tenantId: z.string().uuid(),
  baseName: z.string().min(1).max(255),
  outputType: outputTypeSchema,
  conversationId: z.string().uuid().optional(),
  /** Producer-supplied description of a media upload, used as the rendered
   *  element's alt text. Screened in the attach helper alongside the filename;
   *  ignored for the document output types, which render as a named card. */
  alt: z.string().max(1000).optional(),
  /** Which conversation table a media upload's reference is written to.
   *
   *  Defaults to team chat, which is the only out-of-process producer there is
   *  today. It is a field rather than a constant because the attach helper's
   *  whole point is that a surface joins by adopting the layer, and an
   *  out-of-process producer on another surface — the workforce service, if the
   *  Chief AI Officer ever gains one — would otherwise have no way in.
   *
   *  Widening the reachable set is safe here and nowhere else: this route is
   *  behind the tenant-runtime service token, so every caller is already a
   *  first-party service that can write into this tenant's team chat. The
   *  target thread still has to exist on the named table, and the helper still
   *  runs the same validation and screening whichever adapter it ends at. */
  surface: mediaSurfaceSchema.optional(),
  /** The chat turn whose tool call produced this file. Written to the
   *  `file_output` message as `produced_in_turn_id` (migration 474), which is
   *  what lets the reply for that turn be checked against the cards the turn
   *  actually appended. Optional: an older runtime image or a non-chat caller
   *  sends none, and the card then belongs to no turn — a fact the check
   *  reads as "cannot tell", never as "no card". Not `turn_id` on the row:
   *  that column is unique per assistant message and a card is one. */
  turnId: z.string().uuid().optional(),
  /** How many seconds these bytes survive unpublished.
   *
   *  Absent stores an artifact, which is what almost every producer means: it
   *  is about to card the file in the same request. A value stores STAGED
   *  bytes — attributed, announced nowhere, and discarded on their own unless
   *  somebody presents them. A producer that fetched a file on a model's
   *  behalf says so here, because nothing yet knows whether a person will ever
   *  be shown it. */
  discardAfterSeconds: z.coerce.number().int().positive().max(2_592_000).optional(),
});

/** Whether a `file_output` message was appended for a registered file.
 *
 *  Both registration routes append the card inside a catch that logs and
 *  continues, and answer 201 with the file id regardless, because the file
 *  exists whether or not the card does. This is what tells the caller which
 *  of the two it got. True ONLY when the insert returned a row: it is the one
 *  signal the runtime may trust about what this surface did with the file,
 *  and a 201 on its own is not that signal. */
async function appendFileCard(args: {
  tenantId: string;
  conversationId: string;
  agentId: string;
  attachment: Record<string, unknown>;
  producedInTurnId: string | null;
  generatedFileId: string;
  route: string;
}): Promise<boolean> {
  try {
    const row = await chatRepo.appendMessage(
      args.tenantId,
      args.conversationId,
      'assistant',
      '',
      args.agentId,
      null,
      0,
      0,
      'file_output',
      [args.attachment],
      undefined,
      // Never `turn_id`: acm_assistant_turn_uniq makes it unique per
      // assistant row, and the reply owns it. The turn rides in its own column.
      null,
      null,
      args.producedInTurnId,
    );
    return Boolean(row?.id);
  } catch (msgErr) {
    log.error(
      { error: (msgErr as Error).message, generatedFileId: args.generatedFileId },
      `generated-files: ${args.route} — failed to append file_output message — continuing`,
    );
    return false;
  }
}

const patchBodySchema = z.object({
  connectorId: z.string().uuid(),
  connectorFileId: z.string().min(1).max(1024),
  connectorPath: z.string().min(1).max(2048).optional(),
  webViewUrl: z.string().url().max(2048).optional(),
});

// ── POST /api/generated-files ────────────────────────────────────────────

generatedFilesRouter.post(
  '/',
  serviceAuthMiddleware,
  upload.single('file'),
  uploadRateLimiter,
  async (req: Request, res: Response) => {
    try {
      const parseResult = uploadBodySchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: parseResult.error.errors,
        });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'Missing file upload (field name: file)' });
      }

      const { agentId, tenantId, baseName, outputType, conversationId, alt, turnId } = parseResult.data;
      const discardAfter = parseResult.data.discardAfterSeconds
        ? new Date(Date.now() + parseResult.data.discardAfterSeconds * 1000)
        : null;

      // Media is typed by MIME, and only an allow-listed type is stored. The
      // check is here, at the boundary, rather than after the bytes are in GCS:
      // a producer that uploads something the browser will not draw should be
      // told so, not handed a URL to an object nobody can render.
      if (outputType === 'media' && !isAllowedMediaMimeType(req.file.mimetype)) {
        return res.status(400).json({
          error: 'Unsupported media type',
          details: `outputType 'media' accepts ${MEDIA_TYPES_HUMAN}; got ${req.file.mimetype || 'no content type'}`,
        });
      }

      // Media takes the attach path: stored once by the same storage service,
      // then referenced from the message's `media` column rather than appended
      // as a file_output document card. Everything below this branch is the
      // document pipeline, unchanged.
      if (outputType === 'media') {
        const media = await attachMedia({
          surface: parseResult.data.surface ?? 'agent_chat',
          tenantId,
          threadId: conversationId ?? null,
          agentId,
          bytes: req.file.buffer,
          mimeType: req.file.mimetype,
          filename: req.file.originalname || baseName,
          alt,
        });
        return res.status(201).json({
          id: media.mediaId,
          filename: media.filename,
          version: media.version,
          downloadUrl: media.downloadUrl,
          mimeType: media.mimeType,
        });
      }

      const stored = await storeMediaObject({
        tenantId,
        agentId,
        baseName,
        outputType,
        bytes: req.file.buffer,
        originalFilename: req.file.originalname,
        uploadedMimeType: req.file.mimetype,
        conversationId: conversationId ?? null,
        discardAfter,
        // The document response carries a downloadUrl the producer uses.
        signUrl: true,
      });
      const { id: fileId, filename, version, signedUrl } = stored;

      // Append a file_output assistant message to the conversation if present.
      let cardAppended = false;
      if (conversationId) {
        cardAppended = await appendFileCard({
          tenantId,
          conversationId,
          agentId,
          attachment: {
            generatedFileId: fileId,
            filename,
            outputType,
            version,
            downloadUrl: signedUrl,
          },
          producedInTurnId: turnId ?? null,
          generatedFileId: fileId,
          route: 'upload',
        });
      }

      // Audit log.
      try {
        await agentAuditLogsService.insertAuditLog({
          tenantId,
          internalAgentId: agentId,
          action: 'document.generated',
          inputArgs: {
            filename,
            outputType,
            version,
            generatedFileId: fileId,
            downloadUrl: signedUrl,
          },
          outcome: 'success',
          triggeredBy: 'agent',
        });
      } catch (auditErr) {
        log.error(
          { error: (auditErr as Error).message, generatedFileId: fileId },
          'generated-files: failed to insert audit log — continuing',
        );
      }

      return res.status(201).json({
        id: fileId,
        filename,
        version,
        downloadUrl: signedUrl,
        mimeType: stored.mimeType,
        cardAppended,
      });
    } catch (error) {
      // A refusal is not a fault. Both of these are decisions this service made
      // deliberately about the upload it was handed, and answering 500 would
      // tell the producer to retry something that will be refused identically,
      // and would file a policy decision as an outage.
      if (error instanceof UnsupportedMediaTypeError) {
        return res.status(400).json({ error: 'Unsupported media type', details: error.message });
      }
      if (error instanceof MediaScreeningRefusedError) {
        log.warn(
          { error: error.message, tenantId: req.body?.tenantId },
          'generated-files: media refused by content screening',
        );
        return res.status(422).json({ error: 'Media refused by content screening', details: error.message });
      }
      log.error(
        { error: (error as Error).message, stack: (error as Error).stack },
        'generated-files: POST failed',
      );
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ── POST /api/generated-files/register-connector-native ──────────────────
//
// Registers a connector-native file (e.g. a Google Slides presentation that
// was created directly in the user's Google Drive by a connector tool).
// These files have no GCS record, so gcs_path is stored as NULL.
// Auth: TENANT_RUNTIME_SERVICE_TOKEN via X-Service-Auth header.

generatedFilesRouter.post(
  '/register-connector-native',
  serviceAuthMiddleware,
  async (req: Request, res: Response) => {
    try {
      const schema = z.object({
        agentId: z.string().uuid(),
        tenantId: z.string().uuid(),
        baseName: z.string().min(1).max(255),
        // Documents only. A connector-native row has no bytes and no GCS
        // object, so there is nothing for 'media' to be typed by and nothing
        // for a renderer to draw — it would land as a file card named after a
        // picture that does not exist.
        outputType: documentOutputTypeSchema,
        conversationId: z.string().uuid().optional(),
        connectorId: z.string().uuid(),
        connectorFileId: z.string().min(1).max(1024),
        webViewUrl: z.string().url().max(2048),
        /** Same field, same reason as on the upload body above. */
        turnId: z.string().uuid().optional(),
      });

      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

      const { agentId, tenantId, baseName, outputType, conversationId, connectorId, connectorFileId, webViewUrl, turnId } =
        parsed.data;

      // Determine next version for this (agent, baseName) pair.
      // generated_files is RLS-scoped on tenant_id — run within tenant scope.
      const versionResult = await withTenantScope(tenantId, (client) =>
        client.query(
          `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
           FROM generated_files
           WHERE agent_id = $1 AND base_name = $2`,
          [agentId, baseName],
        ),
      );
      const version: number = Number(versionResult.rows[0].next_version);

      // Derive filename from baseName + version + extension (extension is empty for Google-native types).
      const ext = outputTypeToExt(outputType);
      const filename = ext ? `${baseName}_v${version}.${ext}` : `${baseName}_v${version}`;

      // Insert with gcs_path = NULL (connector-native file lives in the connector, not GCS).
      const insertResult = await withTenantScope(tenantId, (client) =>
        client.query(
          `INSERT INTO generated_files
             (tenant_id, agent_id, conversation_id, filename, base_name, version, output_type,
              gcs_path, size_bytes, connector_id, connector_file_id, web_view_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 0, $8, $9, $10)
           RETURNING id`,
          [
            tenantId,
            agentId,
            conversationId ?? null,
            filename,
            baseName,
            version,
            outputType,
            connectorId,
            connectorFileId,
            webViewUrl,
          ],
        ),
      );

      const row = insertResult.rows[0] as { id: string };

      // Append a file_output assistant message to the conversation if present.
      let cardAppended = false;
      if (conversationId) {
        cardAppended = await appendFileCard({
          tenantId,
          conversationId,
          agentId,
          attachment: {
            generatedFileId: row.id,
            filename,
            outputType,
            version,
            // Explicitly null, never omitted. A connector-native row has no
            // bytes to download — the card's open-in-connector link is the
            // whole affordance — and the card hides its Download button only
            // when this is exactly null: `undefined !== null`, so an omitted
            // field drew a Download button on a card with nothing behind it.
            downloadUrl: null,
            webViewUrl,
          },
          producedInTurnId: turnId ?? null,
          generatedFileId: row.id,
          route: 'register-connector-native',
        });
      }

      // Audit log.
      try {
        await agentAuditLogsService.insertAuditLog({
          tenantId,
          internalAgentId: agentId,
          action: 'document.generated',
          inputArgs: {
            filename,
            outputType,
            version,
            generatedFileId: row.id,
            webViewUrl,
            connectorId,
            connectorFileId,
          },
          outcome: 'success',
          triggeredBy: 'agent',
        });
      } catch (auditErr) {
        log.error(
          { error: (auditErr as Error).message, generatedFileId: row.id },
          'generated-files: register-connector-native — failed to insert audit log — continuing',
        );
      }

      return res.status(201).json({ id: row.id, webViewUrl, cardAppended });
    } catch (error) {
      log.error(
        { error: (error as Error).message, stack: (error as Error).stack },
        'generated-files: register-connector-native failed',
      );
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ── POST /api/generated-files/:fileId/present ────────────────────────────
//
// Show a file that is already stored. The one route that does not create
// anything: writing a file and publishing it are separate acts, and this is
// the second one. See src/generated-files/present.ts for why.

const presentBodySchema = z.object({
  tenantId: z.string().uuid(),
  /** The conversation to show it in. The caller's, never the file's: a file
   *  carries no conversation, and which one shows it is decided by whoever is
   *  replying. */
  conversationId: z.string().uuid(),
  surface: z.enum(['agent_chat', 'liftoff', 'insights', 'team_plan']).default('agent_chat'),
  /** internal_agents.id of whoever is presenting. Absent for a platform
   *  assistant, which has no row in that table. */
  agentId: z.string().uuid().optional(),
  turnId: z.string().uuid().optional(),
});

generatedFilesRouter.post(
  '/:fileId/present',
  serviceAuthMiddleware,
  async (req: Request, res: Response) => {
    try {
      const fileId = req.params.fileId;
      if (!fileId || !/^[0-9a-f-]{36}$/i.test(fileId)) {
        return res.status(400).json({ error: 'Invalid file id' });
      }
      const parsed = presentBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
      }
      const { tenantId, conversationId, surface, agentId, turnId } = parsed.data;

      const presented = await presentFile({
        tenantId,
        fileId,
        surface,
        conversationId,
        agentId: agentId ?? null,
        turnId: turnId ?? null,
      });

      return res.json({ presented: true, ...presented });
    } catch (error) {
      if (error instanceof PresentFileError) {
        // A file that is not in this workspace reads as absent rather than as
        // a refusal that would confirm it exists somewhere.
        const status = error.reason === 'not_found' ? 404 : 502;
        return res.status(status).json({ error: error.message, reason: error.reason });
      }
      log.error(
        { error: (error as Error).message, stack: (error as Error).stack },
        'generated-files: present failed',
      );
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ── PATCH /api/generated-files/:id ───────────────────────────────────────

generatedFilesRouter.patch(
  '/:id',
  serviceAuthMiddleware,
  async (req: Request, res: Response) => {
    try {
      const fileId = req.params.id;
      if (!fileId || !/^[0-9a-f-]{36}$/i.test(fileId)) {
        return res.status(400).json({ error: 'Invalid file ID' });
      }

      const parseResult = patchBodySchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: parseResult.error.errors,
        });
      }

      const { connectorId, connectorFileId, connectorPath, webViewUrl } = parseResult.data;

      // This endpoint is a Cloud Tasks callback with no tenant context in
      // the request. Resolve the tenant_id from the file id via admin scope
      // first, then run all writes under tenant scope so RLS is enforced.
      const tenantLookup = await withAdminScope(
        {
          caller: 'generated-files.patch.resolveTenant',
          reason: 'Cloud Tasks callback: resolve tenant_id from file id before applying tenant scope to writes',
        },
        (client) =>
          client.query<{ tenant_id: string }>(
            `SELECT tenant_id FROM generated_files WHERE id = $1`,
            [fileId],
          ),
      );

      if (tenantLookup.rowCount === 0) {
        return res.status(404).json({ error: 'Generated file not found' });
      }

      const tenantId = tenantLookup.rows[0].tenant_id;

      // 1. Update generated_files row under tenant scope (RLS enforced).
      const updateResult = await withTenantScope(tenantId, (client) =>
        client.query(
          `UPDATE generated_files
           SET connector_id = $1,
               connector_file_id = $2,
               connector_path = $3,
               web_view_url = $4
           WHERE id = $5
           RETURNING id, tenant_id`,
          [connectorId, connectorFileId, connectorPath ?? null, webViewUrl ?? null, fileId],
        ),
      );

      if (updateResult.rowCount === 0) {
        return res.status(404).json({ error: 'Generated file not found' });
      }

      // 2. Update any chat message attachment that references this file.
      // M4: Single bulk UPDATE that walks the attachments array in SQL via
      // jsonb_set on each matching element. Previously this ran one UPDATE
      // per row in a JS loop; for messages with multiple matching files
      // the loop pattern produced O(N) round-trips. The bulk form produces
      // identical state: every attachment whose generatedFileId matches
      // gets `webViewUrl` set; non-matching attachments are unchanged.
      if (webViewUrl) {
        try {
          await withTenantScope(tenantId, (client) =>
            client.query(
              `UPDATE agent_chat_messages m
               SET attachments = (
                 SELECT jsonb_agg(
                   CASE
                     WHEN att->>'generatedFileId' = $1
                       THEN att || jsonb_build_object('webViewUrl', $2::text)
                     ELSE att
                   END
                 )
                 FROM jsonb_array_elements(m.attachments) AS att
               )
               WHERE m.attachments @> $3::jsonb`,
              [
                fileId,
                webViewUrl,
                JSON.stringify([{ generatedFileId: fileId }]),
              ],
            ),
          );
        } catch (attachErr) {
          log.error(
            { error: (attachErr as Error).message, fileId },
            'generated-files: PATCH — failed to update message attachments — continuing',
          );
        }

        // 3. Back-fill webViewUrl into the audit log entry for this file.
        try {
          await withTenantScope(tenantId, (client) =>
            client.query(
              `UPDATE agent_audit_logs
               SET input_args = input_args || jsonb_build_object('webViewUrl', $1::text)
               WHERE input_args->>'generatedFileId' = $2`,
              [webViewUrl, fileId],
            ),
          );
        } catch (auditErr) {
          log.error(
            { error: (auditErr as Error).message, fileId },
            'generated-files: PATCH — failed to update audit log webViewUrl — continuing',
          );
        }
      }

      return res.json({ ok: true });
    } catch (error) {
      log.error(
        { error: (error as Error).message, stack: (error as Error).stack },
        'generated-files: PATCH failed',
      );
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ── GET /api/generated-files/:fileId/download ─────────────────────────────
//
// Auth model:
//   1. Firebase ID token → req.user.uid (set by authMiddleware).
//   2. tenantId is required as a query param.
//   3. The caller's UID is resolved to an account, then verified as a member
//      of the supplied tenant (server-side membership check via tenantMembersService).
//   4. Only after membership is confirmed is the DB row fetched. The DB row's
//      tenant_id is then cross-checked against the verified tenantId as a
//      defence-in-depth guard against UUID-guessing across tenants.
//   Omitting tenantId or belonging to a different tenant both yield 400/403.

// ── GET /api/generated-files/:fileId/content ─────────────────────────────
//
// The RAW BYTES, for a service rather than a browser.
//
// The download route beside this one answers with a signed URL, which is right
// for a browser and useless to the tenant runtime: that route is Firebase-authed
// and a service has no Firebase identity to present. The runtime needs the
// bytes themselves, because a vendor takes an image as base64 in the request
// body and will not fetch a URL from a private bucket.
//
// Same isolation as the browser route, by a different route to it: service auth
// establishes that the caller is one of our deployments, and the row is then
// read inside the named tenant's RLS scope, so an id belonging to another
// tenant returns 404 rather than bytes.
//
// Media only. This is not a general file-exfiltration endpoint: a document
// output is fetched by a person through the signed URL, and there is no caller
// that needs a service to read one.
generatedFilesRouter.get(
  '/:fileId/content',
  serviceAuthMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { fileId } = req.params;
      const tenantId = req.query.tenantId as string | undefined;
      if (!fileId || !/^[0-9a-f-]{36}$/i.test(fileId)) {
        return res.status(400).json({ error: 'Invalid file ID' });
      }
      if (!tenantId || !/^[0-9a-f-]{36}$/i.test(tenantId)) {
        return res.status(400).json({ error: 'tenantId query parameter is required' });
      }

      const result = await withTenantScope(tenantId, (client) =>
        client.query(
          `SELECT gcs_path, mime_type FROM generated_files
            WHERE id = $1 AND output_type = 'media'`,
          [fileId],
        ),
      );
      const row = result.rows[0] as { gcs_path: string | null; mime_type: string | null } | undefined;
      if (!row?.gcs_path || !row.mime_type) {
        return res.status(404).json({ error: 'Media not found' });
      }

      const [bytes] = await generatedFilesBucket().file(row.gcs_path).download();
      res.setHeader('Content-Type', row.mime_type);
      res.setHeader('Content-Length', String(bytes.length));
      return res.send(bytes);
    } catch (error) {
      log.error(
        { error: (error as Error).message },
        'generated-files: GET content failed',
      );
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

generatedFilesRouter.get(
  '/:fileId/download',
  ...authedWithDelegation,
  async (req: Request, res: Response) => {
    try {
      const { fileId } = req.params;
      if (!fileId || !/^[0-9a-f-]{36}$/i.test(fileId)) {
        return res.status(400).json({ error: 'Invalid file ID' });
      }

      // tenantId is required — reject requests that omit it.
      const tenantId = req.query.tenantId as string | undefined;
      if (!tenantId || !/^[0-9a-f-]{36}$/i.test(tenantId)) {
        return res.status(400).json({ error: 'tenantId query parameter is required' });
      }

      // Resolve the caller's account from their Firebase UID and verify
      // they are a member of the requested tenant (server-side enforcement).
      const firebaseUid = req.user?.uid;
      if (!firebaseUid) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const account = await accountService.getByFirebaseUid(firebaseUid);
      if (!account) {
        return res.status(401).json({ error: 'Account not found' });
      }

      const membership = await tenantMembersService.getMembership(tenantId, account.id);
      if (!membership) {
        // Don't confirm tenant or file existence to non-members.
        return res.status(403).json({ error: 'Access denied' });
      }

      // generated_files is RLS-scoped; lookup within tenant scope so RLS
      // returns the row only if it belongs to this tenant.
      const result = await withTenantScope(tenantId, (client) =>
        client.query(
          `SELECT gcs_path, tenant_id, web_view_url, mime_type, output_type
           FROM generated_files WHERE id = $1`,
          [fileId],
        ),
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Generated file not found' });
      }

      const row = result.rows[0] as {
        gcs_path: string | null;
        tenant_id: string;
        web_view_url: string | null;
        mime_type: string | null;
        output_type: string;
      };

      // Defence-in-depth: the file must belong to the verified tenant.
      // (RLS already enforces this; the explicit check is belt-and-suspenders.)
      if (row.tenant_id !== tenantId) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // The content type travels back with the URL because the renderer needs
      // it BEFORE it fetches anything: it decides between <img>, <video>,
      // <audio> and a file card. Rows written before migration 390 carry no
      // mime_type, so it is derived from output_type the way it always was.
      const mimeType = row.mime_type
        ?? outputTypeToContentType(row.output_type as OutputType);

      if (row.gcs_path === null) {
        if (!row.web_view_url) {
          return res.status(404).json({ error: 'No download available for this file' });
        }
        return res.json({ downloadUrl: row.web_view_url, mimeType });
      }

      const bucket = generatedFilesBucket();
      const [signedUrl] = await bucket.file(row.gcs_path).getSignedUrl({
        action: 'read',
        expires: Date.now() + 3_600_000,
      });

      return res.json({ downloadUrl: signedUrl, mimeType });
    } catch (error) {
      log.error(
        { error: (error as Error).message, stack: (error as Error).stack },
        'generated-files: GET download failed',
      );
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);
