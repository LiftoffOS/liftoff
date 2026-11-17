// Per-invocation MCP client pool. One client per (invocationId, serverId)
// so multiple tools/call invocations within one agent turn reuse the same
// connection. Closes connections when the invocation completes.
//
// Two server kinds:
//   - remote → StreamableHTTPClientTransport against the URL
//   - in-process → InMemoryTransport paired with the live McpServer
//                  instance (Liftoff tool gateway)
// The Client API is identical for both; the transport choice is the only
// difference. Used by mcp-bridge.ts to dispatch tool calls for vendor
// adapters that don't have native MCP support (OpenAI for the in-process
// catalog, future Gemini).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServerConfig } from './catalog-types';

class McpClientPool {
  private clients = new Map<string, Client>();

  private keyFor(invocationId: string, serverId: string): string {
    return `${invocationId}::${serverId}`;
  }

  async acquire(invocationId: string, server: McpServerConfig): Promise<Client> {
    const key = this.keyFor(invocationId, server.id);
    const existing = this.clients.get(key);
    if (existing) return existing;

    const client = new Client(
      { name: 'mcp-bridge', version: '1.0.0' },
      { capabilities: {} },
    );

    if (server.kind === 'remote') {
      const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: server.headers ?? {} },
      });
      await client.connect(transport);
    } else {
      // In-process: linked-pair InMemoryTransport — client side on this
      // Client, server side connected to the live McpServer instance.
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      // McpSdkServerConfigWithInstance.instance is the McpServer; it
      // exposes a .connect(transport) that turns it into a live endpoint.
      await server.config.instance.connect(serverTransport);
      await client.connect(clientTransport);
    }

    this.clients.set(key, client);
    return client;
  }

  async releaseAll(invocationId: string): Promise<void> {
    for (const [key, client] of this.clients.entries()) {
      if (key.startsWith(`${invocationId}::`)) {
        await client.close();
        this.clients.delete(key);
      }
    }
  }
}

let singleton: McpClientPool | null = null;

export function getMcpClientPool(): McpClientPool {
  if (!singleton) singleton = new McpClientPool();
  return singleton;
}
