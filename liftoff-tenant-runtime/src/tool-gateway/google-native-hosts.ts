// Which connectors can hold a native Google Doc or Slides deck.
//
// Drive hosts both: a document created through the Docs or Slides API lands in
// the user's Drive, opens in place, and has no bytes of its own — which is also
// why the native routes are the only ones that work on a composio_managed
// Drive, where binary cannot cross the proxy. The document tools dispatch on
// these rather than on the connector's type, the write-side mirror of the read
// side's "pick the presentation reader by file type, not connector type".
//
// In their own module, with no SDK import, so the dispatch is testable: the
// MCP module that consumes them pulls in the Claude Agent SDK's ESM entry,
// which Jest cannot parse, and a rule nobody can test is a rule that drifts.

export function hostsGoogleNativeDocs(connectorType: string): boolean {
  return connectorType === 'google_docs' || connectorType === 'google_drive';
}

export function hostsGoogleNativeSlides(connectorType: string): boolean {
  return connectorType === 'google_slides' || connectorType === 'google_drive';
}
