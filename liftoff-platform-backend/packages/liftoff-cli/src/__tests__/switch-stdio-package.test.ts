// What published package a local stdio command runs.
//
// Everything downstream compares these identities for EQUALITY against the MCP
// registry, so the property that matters is not how many commands are
// recognised but that a recognised one is RIGHT. A wrong identity resolves the
// user's server to somebody else's and offers them a capability they never had;
// an unrecognised one costs them the Requires hosting card they already had.

import { parseStdioPackage } from '../switch/stdio-package';
import { hermesAdapter } from '../switch/sources/hermes';
import { openclawAdapter } from '../switch/sources/openclaw';
import { buildHermesFixture, buildOpenClawFixture, type FixtureHandle } from './switch-fixtures';

describe('parseStdioPackage', () => {
  describe('npm runners', () => {
    it('reads the package out of npx, with and without -y', () => {
      expect(parseStdioPackage('npx', ['-y', '@acme/mcp-server'])).toEqual({
        registryType: 'npm',
        name: '@acme/mcp-server',
      });
      expect(parseStdioPackage('npx', ['@acme/mcp-server'])).toEqual({
        registryType: 'npm',
        name: '@acme/mcp-server',
      });
    });

    it('drops a version without mistaking a scope for one', () => {
      expect(parseStdioPackage('npx', ['-y', '@acme/mcp-server@1.2.3'])?.name).toBe(
        '@acme/mcp-server',
      );
      expect(parseStdioPackage('npx', ['mcp-server@0.1.0'])?.name).toBe('mcp-server');
      expect(parseStdioPackage('npx', ['@acme/mcp-server'])?.name).toBe('@acme/mcp-server');
    });

    it('skips a flag that consumes the next argument', () => {
      expect(parseStdioPackage('npx', ['-p', 'helper', 'real-package'])?.name).toBe('real-package');
    });

    it('handles the other node runners', () => {
      expect(parseStdioPackage('bunx', ['thing-mcp'])?.name).toBe('thing-mcp');
      expect(parseStdioPackage('pnpm', ['dlx', 'thing-mcp'])?.name).toBe('thing-mcp');
      expect(parseStdioPackage('yarn', ['dlx', 'thing-mcp'])?.name).toBe('thing-mcp');
      expect(parseStdioPackage('bun', ['x', 'thing-mcp'])?.name).toBe('thing-mcp');
    });

    it('reads a runner named by absolute path or with a windows extension', () => {
      expect(parseStdioPackage('/usr/local/bin/npx', ['-y', 'thing-mcp'])?.name).toBe('thing-mcp');
      expect(parseStdioPackage('npx.cmd', ['-y', 'thing-mcp'])?.name).toBe('thing-mcp');
    });
  });

  describe('python runners', () => {
    it('reads uvx, uv tool run and pipx run', () => {
      expect(parseStdioPackage('uvx', ['acme-mcp'])).toEqual({
        registryType: 'pypi',
        name: 'acme-mcp',
      });
      expect(parseStdioPackage('uv', ['tool', 'run', 'acme-mcp'])?.registryType).toBe('pypi');
      expect(parseStdioPackage('pipx', ['run', 'acme-mcp'])?.registryType).toBe('pypi');
    });

    it('strips a PEP 508 version specifier and extras', () => {
      expect(parseStdioPackage('uvx', ['acme-mcp==1.2.3'])?.name).toBe('acme-mcp');
      expect(parseStdioPackage('uvx', ['acme-mcp>=1.0'])?.name).toBe('acme-mcp');
      expect(parseStdioPackage('uvx', ['acme-mcp[all]'])?.name).toBe('acme-mcp');
    });

    it('declines `uv run`, which usually runs a local script', () => {
      expect(parseStdioPackage('uv', ['run', 'server.py'])).toBeNull();
    });
  });

  describe('containers', () => {
    it('finds the image past the flags that carry values', () => {
      expect(
        parseStdioPackage('docker', [
          'run',
          '-i',
          '--rm',
          '-e',
          'API_KEY',
          '-v',
          '/tmp:/tmp',
          'ghcr.io/acme/mcp:1.0.3',
        ]),
      ).toEqual({ registryType: 'oci', name: 'ghcr.io/acme/mcp:1.0.3' });
    });

    it('reads podman the same way', () => {
      expect(parseStdioPackage('podman', ['run', '--rm', 'docker.io/acme/mcp'])?.registryType).toBe(
        'oci',
      );
    });

    it('declines anything but `run`', () => {
      expect(parseStdioPackage('docker', ['compose', 'up'])).toBeNull();
    });
  });

  describe('what it refuses', () => {
    it('returns null for a direct binary, which names no registry', () => {
      expect(parseStdioPackage('my-mcp-server', [])).toBeNull();
      expect(parseStdioPackage('/opt/homebrew/bin/some-server', ['--stdio'])).toBeNull();
    });

    it('returns null for a local path or an interpreter pointed at a file', () => {
      expect(parseStdioPackage('npx', ['./local/server.js'])).toBeNull();
      expect(parseStdioPackage('node', ['/srv/mcp/index.js'])).toBeNull();
      expect(parseStdioPackage('npx', ['https://example.com/x.tgz'])).toBeNull();
    });

    it('returns null when an unknown flag makes the package position ambiguous', () => {
      expect(parseStdioPackage('npx', ['--mystery', 'value', 'thing-mcp'])).toBeNull();
    });

    it('returns null for an empty or shell-quoted command', () => {
      expect(parseStdioPackage(undefined, ['x'])).toBeNull();
      expect(parseStdioPackage('npx', [])).toBeNull();
      expect(parseStdioPackage('npx', ['-y', 'thing && rm -rf /'])).toBeNull();
    });
  });
});

describe('adapters attach the identity to a hosting requirement', () => {
  let openclaw: FixtureHandle;
  let hermes: FixtureHandle;

  beforeAll(() => {
    openclaw = buildOpenClawFixture();
    hermes = buildHermesFixture();
  });

  afterAll(() => {
    openclaw.cleanup();
    hermes.cleanup();
  });

  it('records the npm package behind an OpenClaw stdio server', async () => {
    const adapter = openclawAdapter({ path: openclaw.root });
    const [installation] = await adapter.detect();
    const bundle = await adapter.normalize(await adapter.inventory(installation));

    const local = bundle.hostingRequirements.find((h) => h.name === 'localtools');
    expect(local).toBeDefined();
    expect(local!.packageIdentity).toEqual({ registryType: 'npm', name: '@acme/local-mcp' });
  });

  it('records the pypi package behind a Hermes stdio server', async () => {
    const adapter = hermesAdapter({ path: hermes.root });
    const [installation] = await adapter.detect();
    const bundle = await adapter.normalize(await adapter.inventory(installation));

    const local = bundle.hostingRequirements.find((h) => h.name === 'localtools');
    expect(local).toBeDefined();
    expect(local!.packageIdentity).toEqual({ registryType: 'pypi', name: 'acme-mcp' });
  });
});
