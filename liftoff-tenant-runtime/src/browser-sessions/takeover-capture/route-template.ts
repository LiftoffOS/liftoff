// The one URL projection every browser trail uses, now `recordedUrl` from
// @liftoffos/redact.
//
// The old projection here dropped the query string and fragment and replaced
// opaque path segments with `:id`. That threw away fidelity data: the
// resource id in a path, the filter in a query string and the view in an SPA
// fragment are the exact record, filter or view the person used, and an AI
// team that mirrors their workflow needs them. `recordedUrl` keeps them and
// replaces ONLY protected components (URL credentials, password / token /
// key / signature / session-id parameters, and on a callback route the
// protocol code, state and opaque path tokens), returning the omission and
// truncation facts beside the text.
//
// ONE function, applied everywhere a URL enters the record: inside the page
// by the takeover recorder (which embeds its source, so the two cannot
// drift), to Playwright's `framenavigated` URL in Node, to the Stagehand
// loop's `pageUrl` and `goto` per step, to the navigation helper's requested
// and final URLs, and to the safe URL persisted in
// `web_sessions.vendor_metadata.current_url`. It is self-contained for the
// same reason the old one was, and `route-template.test.ts` still
// re-evaluates its source in a fresh realm to hold it to that.

export { recordedUrl, RECORDED_URL_CAP, type SanitizedText } from '@liftoffos/redact';
