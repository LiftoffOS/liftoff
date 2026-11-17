// Showing a file into a Chief AI Officer conversation.
//
// Writing a file and publishing it are separate acts. The control plane owns
// the file store and the act (its `present.ts`); the Chief AI Officer's
// messages live in THIS database and nowhere else, so the card it writes for
// this surface has to be a call rather than an insert. That is all this route
// is: one adapter, on the other side of the wire from the three the control
// plane can write directly.
//
// Service only, and the token is checked BEFORE anything is parsed or read, so
// a caller without it learns nothing — not even whether the thread exists.
// Identity headers are ignored on purpose: this is a service statement about a
// file already stored and already authorised, not an impersonated request. A
// server with no token configured accepts nothing.

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { log } from '../infrastructure/logging.js';
import { loadConfig } from '../infrastructure/config.js';
import { appendMessage, getThread } from './chat-repository.js';

/** The card, as the control plane writes it on every other surface. */
const fileCardSchema = z.object({
  generatedFileId: z.string().min(1).max(200),
  filename: z.string().min(1).max(500),
  outputType: z.string().min(1).max(50),
  version: z.number().int().nonnegative(),
  // Nullable, never absent: the card hides its download button on exactly null
  // and offers to open the file where it lives instead.
  downloadUrl: z.string().max(4096).nullable(),
  webViewUrl: z.string().max(4096).optional(),
});

const bodySchema = z.object({
  tenantId: z.string().uuid(),
  threadId: z.string().uuid(),
  file: fileCardSchema,
});

/** Whether the request carries the shared service token, timing safe. */
function serviceAuthorized(request: FastifyRequest): boolean {
  const expected = loadConfig().WORKFORCE_SERVICE_TOKEN;
  if (!expected) return false;
  const raw = request.headers['x-service-auth'];
  const presented = Array.isArray(raw) ? raw[0] : raw;
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function registerFileCardRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /internal/team-plan/file-card ─────────────────────────────────
  app.post(
    '/internal/team-plan/file-card',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!serviceAuthorized(request)) {
        return reply.status(401).send({ error: 'Invalid service authentication' });
      }
      try {
        const parsed = bodySchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.status(400).send({ error: 'Validation failed', details: parsed.error.errors });
        }
        const { tenantId, threadId, file } = parsed.data;

        // Read under the named tenant, so a thread belonging to another one is
        // a miss rather than a card written where it does not belong.
        const thread = await getThread(threadId, tenantId);
        if (!thread) {
          return reply.status(404).send({ error: 'Thread not found' });
        }

        await appendMessage({
          tenantId,
          threadId,
          role: 'assistant',
          content: '',
          // The type that makes a row a card rather than speech, the same word
          // the other three surfaces write.
          messageType: 'file_output',
          files: [file],
        });

        return reply.send({ presented: true });
      } catch (error) {
        log.error(
          { error: (error as Error).message, stack: (error as Error).stack },
          'Failed to show a file in a team plan conversation',
        );
        return reply.status(500).send({ error: 'Failed to show the file' });
      }
    },
  );
}
