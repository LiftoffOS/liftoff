import type { McpToolCatalog } from '../catalog-types';

/** Build the mcpServers config object Anthropic's claude-agent-sdk consumes.
 *  Two flavors of server:
 *    - in-process: passed as McpSdkServerConfigWithInstance with the live
 *      McpServer instance; the SDK calls it without going through any
 *      transport. This is how Liftoff exposes connector tools + sandbox
 *      primitives + code_session + delegate_to_agent + memory tools.
 *    - remote: passed as McpHttpServerConfig / McpSSEServerConfig / etc.
 *      so the SDK opens a real transport to the vendor MCP (GitHub MCP,
 *      Stripe MCP, etc.). */
export function buildAnthropicMcpServers(
  catalog: McpToolCatalog,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const server of catalog.servers) {
    if (server.kind === 'in-process') {
      // McpSdkServerConfigWithInstance — already in SDK config shape
      // ({type:'sdk', name, instance}). Pass straight through.
      out[server.id] = server.config;
    } else {
      const sdkType = server.transport === 'sse' ? 'sse'
                    : server.transport === 'stdio' ? 'stdio'
                    : 'http';
      out[server.id] = {
        type: sdkType,
        url: server.url,
        headers: server.headers,
      };
    }
  }
  return out;
}
