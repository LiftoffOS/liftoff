// POST /api/chat-media — the door a person's own file comes in through.
//
// A SIBLING of /api/generated-files rather than a mode of it, because the two
// differ in every dimension that matters for a route. That one is a producer
// endpoint: authenticated by a service token, it takes an `agentId`, appends an
// assistant message, and every caller is one of our own deployments. This one
// is authenticated by the person's Firebase identity, has no producing agent,
// appends nothing, and its callers are browsers. Folding them together would
// mean one route whose auth model depends on a body field.
//
// What it deliberately shares: the storage service, the MIME allow-list, the
// bucket, the RLS scope and the download route the bytes are read back through.
// Inbound media differs in who uploaded it, not in what it is.
//
// Routes:
//   POST /api/chat-media              — store one file, return a MediaRef
//   POST /api/chat-media/from-connector — resolve files picked from a cloud
//                                       source into attachments, or refuse
//                                       them with a reason
//   POST /api/chat-media/claim        — service-auth; the Chief AI Officer
//                                       marks uploads as sent, since its
//                                       messages table is in another database

import { Router, Request, Response } from 'express';
import multer from 'multer';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';

import { authedWithDelegation } from '../support-delegation/authed';
// Aliased to the name every other service-auth mount in this repo uses. The
// route-tenancy walker recognises that name as a guard, and it is one: a
// caller holding the workforce service token IS the workforce service, which
// is what establishes its right to act inside the tenant it names.
import { workforceServiceAuth as serviceAuthMiddleware } from '../internal-api/workforce-service-auth';
import { log } from '../infrastructure/logging';
import { AccountService } from '../accounts/service';
import { tenantMembersService } from '../tenant-members';
import { MEDIA_TYPES_HUMAN, isAllowedMediaMimeType } from '../generated-files/store';
import {
  INBOUND_SURFACES,
  MediaContentMismatchError,
  MediaScreeningRefusedError,
  UnsupportedMediaTypeError,
  claimInboundMedia,
  storeInboundMedia,
} from '../media/inbound';
import { MAX_MEDIA_ATTACHMENTS, MAX_MEDIA_BYTES } from '../chat-attachments';
import { resolveConnectorAttachments } from './connector-resolve';

export const chatMediaRouter = Router();

const accountService = new AccountService();

// Bytes are streamed straight to GCS, so memory storage is the right shape and
// the file never touches the container's disk.
//
// The limit is the CONTRACT's, not multer's own default and not the producer
// route's 50 MB. Cloud Run refuses a request body over 32 MB on HTTP/1.1 before
// any of this code runs, so a limit above that ceiling is a promise the
// platform will not keep: the person would wait out a long upload and get a
// load-balancer error with nothing in it they could act on.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MEDIA_BYTES, files: 1 },
});

const uploadRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => {
    const uid = req.user?.uid || 'anonymous';
    const ip = ipKeyGenerator(req.ip || 'unknown');
    return `chat-media:${uid}:${ip}`;
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded', retryAfter: 60 },
});

const surfaceSchema = z.enum(INBOUND_SURFACES);

const uploadBodySchema = z.object({
  tenantId: z.string().uuid(),
  /**
   * Which surface this will be sent on, WHEN THAT IS KNOWN.
   *
   * Optional, because on one composer it genuinely is not. The dashboard home
   * page routes a message to Liftoff, the Chief AI Officer, the Insights
   * Manager or a team based on an @mention it parses at SEND time — after the
   * file has already been uploaded. Requiring a surface here would force that
   * page to name one it cannot know, and a stored row asserting the wrong table
   * is worse than a row asserting nothing.
   *
   * The claim step is where the surface becomes a fact: by then a message
   * exists, on exactly one table, and `claimInboundMedia` stamps it. This field
   * is a hint that scopes nothing — it is never read to authorize anything.
   */
  surface: surfaceSchema.optional(),
  /** The thread being typed in. Absent on a brand new conversation, which has
   *  no id until the first message is sent — the claim step fills it in. */
  threadId: z.string().uuid().optional(),
});

const claimBodySchema = z.object({
  tenantId: z.string().uuid(),
  surface: surfaceSchema,
  threadId: z.string().uuid(),
  mediaIds: z.array(z.string().uuid()).min(1).max(MAX_MEDIA_ATTACHMENTS),
});

const fromConnectorBodySchema = z.object({
  tenantId: z.string().uuid(),
  /** Same as the upload route: a hint when the composer knows it, absent when
   *  it does not. The claim step is what records the fact. */
  surface: surfaceSchema.optional(),
  threadId: z.string().uuid().optional(),
  connectorId: z.string().uuid(),
  connectorType: z.string().min(1).max(64),
  items: z
    .array(
      z.object({
        externalId: z.string().min(1).max(512),
        name: z.string().min(1).max(255),
        contentType: z.string().max(200).optional(),
        mimeType: z.string().max(200).optional(),
        sourceUrl: z.string().url().max(2048).optional(),
      }),
    )
    .min(1)
    .max(MAX_MEDIA_ATTACHMENTS + 8),
});

/**
 * Resolve the caller and prove they belong to the tenant they named.
 *
 * Identity is not tenancy. `authMiddleware` establishes who is calling; this
 * establishes that they may act inside the tenant whose id arrived in the body.
 * It runs UNCONDITIONALLY at the top of every handler here — a membership check
 * nested inside an `if` is the shape that let both HITL decision routes
 * authorize nothing whenever the runtime was degraded.
 */
async function resolveMember(
  req: Request,
  res: Response,
  tenantId: string,
): Promise<{ accountId: string } | null> {
  const firebaseUid = req.user?.uid;
  if (!firebaseUid) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  const account = await accountService.getByFirebaseUid(firebaseUid);
  if (!account) {
    res.status(401).json({ error: 'Account not found' });
    return null;
  }
  const membership = await tenantMembersService.getMembership(tenantId, account.id);
  if (!membership) {
    // Do not confirm the tenant exists to somebody who is not in it.
    res.status(403).json({ error: 'Access denied' });
    return null;
  }
  return { accountId: account.id };
}

// ── POST /api/chat-media ─────────────────────────────────────────────────

// Order is load-bearing. The rate limiter runs BEFORE multer, not after it:
// the tenant id arrives inside the multipart body, so membership cannot be
// checked until the body is parsed — which means an authenticated caller who
// belongs to no tenant at all can still make this process buffer 20 MB into
// memory before it is refused. Limiting on the Firebase uid first bounds how
// often that can happen. (The producer route beside this one orders these the
// other way round, and can afford to: every caller there holds a service
// token.)
chatMediaRouter.post(
  '/',
  ...authedWithDelegation,
  uploadRateLimiter,
  upload.single('file'),
  async (req: Request, res: Response) => {
    const tRequest = Date.now();
    try {
      const parsed = uploadBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
      }
      const { tenantId, surface, threadId } = parsed.data;

      const member = await resolveMember(req, res, tenantId);
      if (!member) return;

      if (!req.file) {
        return res.status(400).json({ error: 'Missing file upload (field name: file)' });
      }

      // Refused at the boundary, naming what IS accepted. A person who picked
      // a HEIC photo needs to know that and not a generic failure — the
      // producer route has said it this way since it existed.
      if (!isAllowedMediaMimeType(req.file.mimetype)) {
        return res.status(400).json({
          error: 'Unsupported media type',
          details: `Accepted: ${MEDIA_TYPES_HUMAN}; got ${req.file.mimetype || 'no content type'}`,
        });
      }

      // The half of the request storeMediaObject cannot see: byte sniffing,
      // injection screening of the file name, and the two identity lookups
      // above. Paired with the store's own phase log, these two lines account
      // for the whole server side of an upload.
      const tAccepted = Date.now();
      const media = await storeInboundMedia({
        tenantId,
        accountId: member.accountId,
        surface: surface ?? null,
        threadId: threadId ?? null,
        bytes: req.file.buffer,
        mimeType: req.file.mimetype,
        filename: req.file.originalname || 'upload',
      });

      log.info(
        {
          event: 'chat_media_upload_timing',
          surface: surface ?? null,
          sizeBytes: req.file.size,
          mimeType: media.mimeType,
          storeMs: Date.now() - tAccepted,
          totalMs: Date.now() - tRequest,
        },
        'chat-media: upload complete',
      );
      return res.status(201).json({ media });
    } catch (error) {
      if (error instanceof UnsupportedMediaTypeError) {
        return res.status(400).json({ error: 'Unsupported media type', details: error.message });
      }
      if (error instanceof MediaContentMismatchError) {
        return res.status(400).json({ error: 'File content does not match its type', details: error.message });
      }
      if (error instanceof MediaScreeningRefusedError) {
        return res.status(400).json({ error: 'File refused', details: error.message });
      }
      log.error(
        { error: (error as Error).message, stack: (error as Error).stack },
        'chat-media: upload failed',
      );
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// ── POST /api/chat-media/from-connector ──────────────────────────────────
//
// The cloud pickers (Drive, OneDrive, Dropbox, Box) hand back file references,
// not files. This turns each reference into something the turn can actually
// carry — extracted text, or stored media — and where it cannot, says why.
//
// The refusal is the point of the route existing at all. Before it, a file
// picked from a cloud source produced a chip carrying its NAME and nothing
// else: the model was told a file called "Q3 chart.png" was attached and never
// saw a pixel of it, so it answered about a picture it had not been shown.

chatMediaRouter.post('/from-connector', ...authedWithDelegation, async (req: Request, res: Response) => {
  try {
    const parsed = fromConnectorBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
    }
    const { tenantId, surface, threadId, connectorId, connectorType, items } = parsed.data;

    const member = await resolveMember(req, res, tenantId);
    if (!member) return;

    const resolved = await resolveConnectorAttachments({
      tenantId,
      accountId: member.accountId,
      surface: surface ?? null,
      threadId: threadId ?? null,
      connectorId,
      connectorType,
      items,
    });

    return res.json({ results: resolved });
  } catch (error) {
    log.error(
      { error: (error as Error).message, stack: (error as Error).stack },
      'chat-media: connector resolve failed',
    );
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/chat-media/claim ───────────────────────────────────────────
//
// Service auth, and one caller: the workforce service. The other three surfaces
// persist their messages inside this process and claim in-process, but the
// Chief AI Officer's messages table is in a different database, so the moment
// its message is written is not a moment this process can see.

chatMediaRouter.post('/claim', serviceAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const parsed = claimBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
    }
    const { tenantId, surface, threadId, mediaIds } = parsed.data;
    const claimed = await claimInboundMedia(tenantId, mediaIds, threadId, surface);
    return res.json({ claimed });
  } catch (error) {
    log.error(
      { error: (error as Error).message, stack: (error as Error).stack },
      'chat-media: claim failed',
    );
    return res.status(500).json({ error: 'Internal server error' });
  }
});
