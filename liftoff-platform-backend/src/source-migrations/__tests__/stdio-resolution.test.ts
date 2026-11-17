// What a local stdio MCP server resolves to.
//
// The property under test is precedence, and the one that matters most is the
// LAST rung: a registry that cannot be reached knows nothing about the server,
// so it must leave the import exactly where it was. A lookup that failed open
// would quietly drop a capability the person asked to bring across; a lookup
// that threw would fail a bundle upload over an optional enrichment.

import { resolveHostingRequirements } from '../connections';
import { _clearMcpRegistryCache } from '../mcp-registry';
import type { HostingRequirement } from '../types';

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../connectors/connector-service-client', () => ({
  createImportPlaceholders: jest.fn(),
  listConnectorsForTenant: jest.fn(),
}));

jest.mock('../repository', () => ({
  sourceMigrationRepository: {},
}));

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

function hosting(overrides: Partial<HostingRequirement> = {}): HostingRequirement {
  return {
    sourceRef: 'mcp:localtools',
    name: 'localtools',
    command: 'npx',
    args: ['-y', '@acme/local-mcp'],
    reason: 'stdio_mcp_requires_hosting',
    usedByIdentityRefs: ['agent:research'],
    ...overrides,
  };
}

/** One registry page. */
function registryPage(servers: unknown[]): { ok: true; json: () => Promise<unknown> } {
  return { ok: true, json: async () => ({ servers: servers.map((server) => ({ server })) }) };
}

beforeEach(() => {
  fetchMock.mockReset();
  _clearMcpRegistryCache();
});

describe('resolveHostingRequirements', () => {
  it('prefers our own catalog connector over anything the registry says', async () => {
    const result = await resolveHostingRequirements([
      hosting({
        packageIdentity: { registryType: 'npm', name: '@modelcontextprotocol/server-github' },
      }),
    ]);

    expect(result.catalog).toHaveLength(1);
    expect(result.catalog[0].connectorType).toBe('github');
    expect(result.remaining).toHaveLength(0);
    // A connector we already have is not a question for the registry.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('carries the identity refs onto the connector requirement it creates', async () => {
    const result = await resolveHostingRequirements([
      hosting({
        sourceRef: 'mcp:gh',
        packageIdentity: { registryType: 'npm', name: '@modelcontextprotocol/server-github' },
      }),
    ]);

    expect(result.catalog[0]).toMatchObject({
      sourceRef: 'mcp:gh',
      usedByIdentityRefs: ['agent:research'],
      usedByRoutineRefs: [],
    });
  });

  it('resolves to the endpoint the vendor publishes when the registry knows the package', async () => {
    fetchMock.mockResolvedValue(
      registryPage([
        {
          name: 'io.github.acme/local-mcp',
          packages: [{ registryType: 'npm', identifier: '@acme/local-mcp' }],
          remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.com/v1' }],
        },
      ]),
    );

    const result = await resolveHostingRequirements([
      hosting({ packageIdentity: { registryType: 'npm', name: '@acme/local-mcp' } }),
    ]);

    expect(result.mcp).toHaveLength(1);
    expect(result.mcp[0]).toMatchObject({
      sourceRef: 'mcp:localtools',
      name: 'localtools',
      url: 'https://mcp.acme.com/v1',
      transport: 'http',
      // No credential crosses the import boundary, so it starts unauthenticated
      // and is completed through the normal custom-MCP flow.
      authScheme: 'none',
    });
    expect(result.remaining).toHaveLength(0);
  });

  it('matches on the DECLARED package, not on what the search happened to return', async () => {
    // The registry's search is a substring match on the server NAME, so its
    // hits are routinely different servers that merely share a word. Taking the
    // top hit would point the user's server at somebody else's endpoint.
    fetchMock.mockResolvedValue(
      registryPage([
        {
          name: 'io.github.someone-else/local-mcp-fork',
          packages: [{ registryType: 'npm', identifier: 'a-different-package' }],
          remotes: [{ type: 'streamable-http', url: 'https://not-ours.example.com/mcp' }],
        },
      ]),
    );

    const result = await resolveHostingRequirements([
      hosting({ packageIdentity: { registryType: 'npm', name: '@acme/local-mcp' } }),
    ]);

    expect(result.mcp).toHaveLength(0);
    expect(result.remaining).toHaveLength(1);
  });

  it('ignores an OCI tag when comparing, because a tag is a version', async () => {
    fetchMock.mockResolvedValue(
      registryPage([
        {
          name: 'com.acme/mcp',
          packages: [{ registryType: 'oci', identifier: 'ghcr.io/acme/mcp:1.0.9' }],
          remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.com/v1' }],
        },
      ]),
    );

    const result = await resolveHostingRequirements([
      hosting({
        command: 'docker',
        args: ['run', '--rm', 'ghcr.io/acme/mcp:1.0.3'],
        packageIdentity: { registryType: 'oci', name: 'ghcr.io/acme/mcp:1.0.3' },
      }),
    ]);

    expect(result.mcp).toHaveLength(1);
  });

  it('leaves the card alone and says so when the registry cannot be reached', async () => {
    fetchMock.mockRejectedValue(new Error('ENOTFOUND'));

    const result = await resolveHostingRequirements([
      hosting({ packageIdentity: { registryType: 'npm', name: '@acme/local-mcp' } }),
    ]);

    expect(result.remaining).toHaveLength(1);
    expect(result.catalog).toHaveLength(0);
    expect(result.mcp).toHaveLength(0);
    expect(result.diagnostics.join(' ')).toMatch(/could not be reached/i);
  });

  it('treats a non-OK registry status as inconclusive rather than as "no such server"', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

    const result = await resolveHostingRequirements([
      hosting({ packageIdentity: { registryType: 'npm', name: '@acme/local-mcp' } }),
    ]);

    expect(result.remaining).toHaveLength(1);
    expect(result.diagnostics.join(' ')).toMatch(/could not be reached/i);
  });

  it('treats a response of the wrong shape as inconclusive', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ unexpected: 'payload' }) });

    const result = await resolveHostingRequirements([
      hosting({ packageIdentity: { registryType: 'npm', name: '@acme/local-mcp' } }),
    ]);

    expect(result.remaining).toHaveLength(1);
    expect(result.diagnostics.join(' ')).toMatch(/could not be reached/i);
  });

  it('leaves a server with no package identity exactly as it arrived', async () => {
    const req = hosting({ command: '/opt/acme/in-house-server', args: [] });
    const result = await resolveHostingRequirements([req]);

    expect(result.remaining).toEqual([req]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not try to resolve an endpoint that was merely unreachable', async () => {
    // Packaging is not that server's problem, and the registry cannot make a
    // URL reachable.
    const req = hosting({
      reason: 'unreachable_mcp_endpoint',
      url: 'https://private.internal/mcp',
      packageIdentity: { registryType: 'npm', name: '@acme/local-mcp' },
    });
    const result = await resolveHostingRequirements([req]);

    expect(result.remaining).toEqual([req]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps a match that publishes no endpoint as a hosting card', async () => {
    fetchMock.mockResolvedValue(
      registryPage([
        {
          name: 'io.github.acme/local-mcp',
          packages: [{ registryType: 'npm', identifier: '@acme/local-mcp' }],
        },
      ]),
    );

    const result = await resolveHostingRequirements([
      hosting({ packageIdentity: { registryType: 'npm', name: '@acme/local-mcp' } }),
    ]);

    expect(result.mcp).toHaveLength(0);
    expect(result.remaining).toHaveLength(1);
  });

  it('prefers the catalog when the matched server also publishes a package we map', async () => {
    // Same capability, published twice. A governed connector beats a raw
    // endpoint whichever package the user happened to install.
    fetchMock.mockResolvedValue(
      registryPage([
        {
          name: 'com.acme/notion',
          packages: [
            { registryType: 'oci', identifier: 'ghcr.io/acme/notion:2' },
            { registryType: 'npm', identifier: '@notionhq/notion-mcp-server' },
          ],
          remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.com/notion' }],
        },
      ]),
    );

    const result = await resolveHostingRequirements([
      hosting({ packageIdentity: { registryType: 'oci', name: 'ghcr.io/acme/notion:2' } }),
    ]);

    expect(result.catalog).toHaveLength(1);
    expect(result.catalog[0].connectorType).toBe('notion');
    expect(result.mcp).toHaveLength(0);
  });

  it('asks the registry once for a package it has already resolved', async () => {
    fetchMock.mockResolvedValue(
      registryPage([
        {
          name: 'io.github.acme/local-mcp',
          packages: [{ registryType: 'npm', identifier: '@acme/local-mcp' }],
          remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.com/v1' }],
        },
      ]),
    );

    await resolveHostingRequirements([
      hosting({ sourceRef: 'mcp:a', packageIdentity: { registryType: 'npm', name: '@acme/local-mcp' } }),
      hosting({ sourceRef: 'mcp:b', packageIdentity: { registryType: 'npm', name: '@acme/local-mcp' } }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
