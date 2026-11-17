/**
 * The name a CLI engine reports for a catalog tool, and the way back.
 *
 * The CLI engines reach the catalog through the HTTP MCP proxy, registered
 * in each CLI's config under ONE server name. Each CLI then names the tools
 * it serves from that server with its own prefix: opencode `<server>_<tool>`,
 * gemini-cli `mcp_<server>_<tool>`. Everything downstream — the stream seams,
 * the governance gate, the trajectory record and the checkpoint a pause
 * resumes from — resolves names against the catalog, so a reported name is
 * translated back at the edge and the prefix never leaves the adapter or the
 * mapper that reads the CLI's events.
 */

/** The name the proxy's MCP server is registered under in every CLI's config. */
export const LIFTOFF_MCP_SERVER_NAME = 'liftoff';

/** opencode names every tool it serves `<server>_<tool>`. */
const OPENCODE_TOOL_PREFIX = `${LIFTOFF_MCP_SERVER_NAME}_`;

/** gemini-cli names every MCP tool `mcp_<server>_<tool>`. */
export const GEMINI_CLI_TOOL_PREFIX = `mcp_${LIFTOFF_MCP_SERVER_NAME}_`;

function stripPrefix(reported: string, prefix: string): string {
  return reported.startsWith(prefix) ? reported.slice(prefix.length) : reported;
}

/** The catalog's name for a tool opencode reported. */
export function opencodeCatalogToolName(reported: string): string {
  return stripPrefix(reported, OPENCODE_TOOL_PREFIX);
}

/** The catalog's name for a tool gemini-cli reported. */
export function geminiCliCatalogToolName(reported: string): string {
  return stripPrefix(reported, GEMINI_CLI_TOOL_PREFIX);
}
