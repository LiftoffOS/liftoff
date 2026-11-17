// The chat attachment contract, for platform-backend's own surfaces.
//
// The implementation is @liftoffos/chat-attachments, published from
// packages/chat-attachments in this repository. It has to be a package rather
// than a module because the Chief AI Officer lives in liftoff-workforce-service
// — a separate deployable, in a separate repository, with a separate database —
// and backend code shared with it can only travel as a published package.
//
// This file is the neutral in-repo name for it, so nothing inside src/ imports
// the contract through a surface that happens to have had it first. Liftoff
// re-exports it from src/liftoff/chat-service.ts, so its existing callers are
// untouched.

export {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_CONTENT_CHARS,
  MAX_ATTACHMENT_NAME_CHARS,
  MAX_MEDIA_ATTACHMENTS,
  MAX_MEDIA_BYTES,
  MAX_IMAGES_PER_TURN,
  MAX_IMAGE_BYTES_PER_TURN,
  ATTACHMENT_ALLOWANCE_TOKENS,
  IMAGE_ALLOWANCE_TOKENS,
  MEDIA_NOTICE_ALLOWANCE_TOKENS,
  attachmentSchema,
  attachmentsSchema,
  countAttachments,
  mediaRefSchema,
  contributorSchema,
  contributorsSchema,
  toMessageAttachments,
  toMessageMedia,
  describeAttachment,
  escapeAttachmentName,
  composeTurnText,
  composeMediaNotices,
  isModelReadableImage,
  isModelReadableVideo,
  partitionMediaForModel,
  MAX_INLINE_VIDEO_BYTES,
  estimateImageTokens,
  sanitizeAttachmentName,
  sanitizeAttachments,
} from '@liftoffos/chat-attachments';

export type {
  MediaRef,
  Contributor,
  ChatAttachment,
  ChatUploadAttachment,
  ChatConnectorAttachment,
  ChatMediaAttachment,
  ChatMessageAttachment,
  SendableModalities,
} from '@liftoffos/chat-attachments';
