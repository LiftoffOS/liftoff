// @liftoffos/redact: what leaves a service, made safe first.
//
// `credentials.ts` is the canonical credential redactor (E4), applied to text
// on its way out of a service. `browser-safe.ts` is the browser record's pair
// of sanitizers: the safe URL projection the tenant runtime's takeover
// recorder embeds into the page, and the bounded text sanitizer for a browser
// instruction or outcome. Both return the facts a reader needs beside the
// text, so nothing downstream infers an omission from a `[redacted]` token.

export { redactSensitiveText, redactMessagesForEgress } from './credentials';
export {
  recordedUrl,
  sanitizeBrowserText,
  RECORDED_URL_CAP,
  BROWSER_TEXT_DEFAULT_CAP,
  type SanitizedText,
} from './browser-safe';
