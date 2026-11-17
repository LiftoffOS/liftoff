// Re-export of the shared credential redactor.
//
// The implementation moved to @liftoffos/redact so workforce-service can use
// the same one rather than a copy that drifts. This shim keeps the dozen
// existing `../common/redact` imports in this repo working unchanged, and is
// the only thing that should ever live in this file.

export { redactSensitiveText, redactMessagesForEgress } from '@liftoffos/redact';
