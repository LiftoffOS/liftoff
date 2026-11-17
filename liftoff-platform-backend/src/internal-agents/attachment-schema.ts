// Zod schema for TeamAttachment — the ONE definition shared by every route
// that accepts attachments (create/update, distill, distill-stream).
// Wire shape is fixed by the frontend contract in
// docs/REQUIRED_BACKEND_APIS.md "Team Attachments"; keep the two in lockstep.

import { z } from 'zod';

/** Per-attachment plain-text cap. Parity with the knowledge extraction cap
 *  (MAX_EXTRACT_CHARS in knowledge/service.ts) so an uploaded file and the
 *  same file resolved through a connector carry the same budget. */
export const MAX_ATTACHMENT_CONTENT_CHARS = 100_000;

/** List cap. 20, matching the integrations cap on the same payloads. */
export const MAX_ATTACHMENTS = 20;

const attachmentSource = z.enum(['responsibilities', 'guidance']);

const uploadAttachmentSchema = z.object({
  kind: z.literal('upload'),
  name: z.string().min(1).max(255),
  content: z.string().max(MAX_ATTACHMENT_CONTENT_CHARS),
  addedAt: z.string().max(64),
  source: attachmentSource,
});

const connectorAttachmentSchema = z.object({
  kind: z.literal('connector'),
  name: z.string().min(1).max(255),
  connectorId: z.string().uuid(),
  connectorType: z.string().min(1).max(64),
  externalId: z.string().min(1).max(512),
  sourceUrl: z.string().max(2048).optional(),
  addedAt: z.string().max(64),
  source: attachmentSource,
});

export const teamAttachmentSchema = z.discriminatedUnion('kind', [
  uploadAttachmentSchema,
  connectorAttachmentSchema,
]);

export const teamAttachmentsArraySchema = z
  .array(teamAttachmentSchema)
  .max(MAX_ATTACHMENTS);
