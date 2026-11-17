// The `search` tool's description, in one place.
//
// `search` is implemented twice — once as an MCP tool for the vendor-engine
// adapters and once as a builtin for the native loop — and its schema is
// declared a third time. A description that lives at each site drifts, and the
// model's choice between overlapping retrieval tools is made almost entirely
// from these words.

export const SEARCH_TOOL_DESCRIPTION =
  'Search across what this workspace knows. Three sources, in this order: ' +
  '(1) already-indexed content, everything previously fetched from connected ' +
  'systems, searched first because it is instant and costs nothing at the vendor; ' +
  '(2) agent memory, always searched; ' +
  '(3) live connector search, only for the aliases you pass in `connectors` ' +
  '(e.g. ["github", "slack"]), which does call the vendor. ' +
  'The indexed source reports its own coverage: it holds only what has been ' +
  'fetched before, so finding nothing there does NOT mean the data does not ' +
  'exist. Say so, and query the connector directly.';
