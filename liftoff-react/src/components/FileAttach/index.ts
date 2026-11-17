// The file-attachment picker: the composer's "+" button, the popover it opens,
// and the stylesheet both arrive with. Import from this folder, never from
// components/index.ts — that barrel is in the entry chunk, and the CSS
// side-effect in FileUploadPopover would leak into every route from there
// (see the note in components/index.ts and scripts/verify/css-closure.mjs).
export { default as FileUploadButton } from './FileUploadButton'
export { default as FileUploadPopover } from './FileUploadPopover'
export type { PendingAttachment, MediaContext } from './FileUploadPopover'
