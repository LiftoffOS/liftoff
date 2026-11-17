// Codex adapter.
//
// The property that matters most here is the vendor-internal filter. `~/.codex`
// is shared with the ChatGPT desktop app, which writes its own MCP servers,
// marketplaces and plugins into the same config file. Without the filter a
// person's review screen fills up with OpenAI's internals — and the entries
// that ARE theirs get lost in it.

import { codexAdapter, isVendorInternalMcp, isVendorMarketplace } from '../switch/sources/codex';
import { assertNoSecrets } from '../switch/secret-filter';
import { buildCodexFixture, FAKE_ANTHROPIC_KEY, type FixtureHandle } from './switch-fixtures';

describe('codex adapter', () => {
  let fixture: FixtureHandle;

  beforeAll(() => {
    fixture = buildCodexFixture();
  });

  afterAll(() => fixture.cleanup());

  async function bundleFor(root: string, opts: { includeProjects?: boolean } = {}) {
    const adapter = codexAdapter({ path: root, ...opts });
    const installations = await adapter.detect();
    expect(installations.length).toBeGreaterThan(0);
    const inventory = await adapter.inventory(installations[0]);
    return {
      adapter,
      installation: installations[0],
      inventory,
      bundle: await adapter.normalize(inventory),
    };
  }

  describe('the vendor-internal filter', () => {
    it('recognises the desktop app\'s own servers by name', () => {
      expect(isVendorInternalMcp('node_repl', {})).toBe(true);
      expect(isVendorInternalMcp('computer-use', {})).toBe(true);
    });

    it('recognises them by the path they run from', () => {
      expect(
        isVendorInternalMcp('anything', {
          command: '/Applications/ChatGPT.app/Contents/Resources/x',
        }),
      ).toBe(true);
      expect(
        isVendorInternalMcp('anything', { command: '/Users/x/.cache/codex-runtimes/y' }),
      ).toBe(true);
    });

    it('leaves a real user entry alone', () => {
      expect(isVendorInternalMcp('mytools', { command: 'uvx', args: ['acme-mcp'] })).toBe(false);
    });

    it('recognises the bundled marketplaces', () => {
      expect(isVendorMarketplace('openai-bundled')).toBe(true);
      expect(isVendorMarketplace('browser@openai-bundled')).toBe(true);
      expect(isVendorMarketplace('my-own-marketplace')).toBe(false);
    });

    it('drops them SILENTLY rather than reporting them as gaps', async () => {
      // An unsupported item is a message to a person. "We could not import
      // OpenAI's node_repl" is not a message anybody needs, and it buries the
      // ones that matter.
      const { bundle } = await bundleFor(fixture.root);
      const serialized = JSON.stringify(bundle);
      expect(serialized).not.toContain('node_repl');
      expect(serialized).not.toContain('computer-use');
      expect(serialized).not.toContain('ChatGPT.app');
    });
  });

  describe('detection', () => {
    it('reads the version the installation records', async () => {
      const { installation } = await bundleFor(fixture.root);
      expect(installation.source).toBe('codex');
      expect(installation.sourceVersion).toBe('0.52.0');
    });
  });

  describe('artifacts', () => {
    it('imports AGENTS.md, skills and prompts', async () => {
      const { inventory } = await bundleFor(fixture.root);
      const identity = inventory.identities[0];
      expect(identity.artifacts.some((a) => a.sourcePath.endsWith('AGENTS.md'))).toBe(true);
      expect(identity.skills.map((s) => s.name)).toEqual(expect.arrayContaining(['pdf', 'triage']));
    });

    it("carries a skill's script as one of its files", async () => {
      const { inventory } = await bundleFor(fixture.root);
      const pdf = inventory.identities[0].skills.find((s) => s.name === 'pdf')!;
      expect(pdf.files?.map((f) => f.path)).toEqual(['scripts/extract.py']);
    });

    it('creates exactly one identity, because Codex has no sub-agent registry', async () => {
      const { inventory } = await bundleFor(fixture.root);
      expect(inventory.identities).toHaveLength(1);
    });
  });

  describe('connections', () => {
    it('keeps a url entry as a customer-owned MCP endpoint', async () => {
      const { bundle } = await bundleFor(fixture.root);
      expect(bundle.customMcpServerRequirements.map((s) => s.name)).toContain(
        'openaiDeveloperDocs',
      );
    });

    it('records the package behind a stdio entry', async () => {
      const { bundle } = await bundleFor(fixture.root);
      const local = bundle.hostingRequirements.find((h) => h.name === 'localtools');
      expect(local?.packageIdentity).toEqual({ registryType: 'pypi', name: 'acme-mcp' });
    });
  });

  describe('policies', () => {
    it('maps sandbox_mode, which has an exact equivalent', async () => {
      const { bundle } = await bundleFor(fixture.root);
      expect((bundle.governanceRules ?? []).map((r) => r.kind)).toContain('sandbox_required');
    });

    it('carries a deny prefix rule and ignores the allow ones', async () => {
      // An allow prefix stops Codex asking its user. Liftoff has nothing that
      // asks that way, so importing it would turn prompt-suppression into a
      // permission grant.
      const { bundle } = await bundleFor(fixture.root);
      const denied = (bundle.governanceRules ?? []).find((r) => r.kind === 'tool_denied');
      expect(denied?.description).toContain('rm -rf');
      expect(denied?.description).not.toContain('npm test');
    });

    it('refuses to equate approval_policy with the Liftoff approval gate', async () => {
      const { bundle } = await bundleFor(fixture.root);
      expect(
        bundle.unsupportedItems.some((u) => u.sourceRef === 'config:approval_policy'),
      ).toBe(true);
    });

    it('records model, effort and personality as a preference', async () => {
      const { bundle } = await bundleFor(fixture.root);
      expect(bundle.modelPreferences[0]?.model).toBe('gpt-5.6-sol');
      expect(bundle.modelPreferences[0]?.note).toMatch(/medium/i);
      expect(bundle.modelPreferences[0]?.note).toMatch(/pragmatic/i);
    });
  });

  describe('what it never reads', () => {
    it('reports session history as excluded', async () => {
      const { bundle } = await bundleFor(fixture.root);
      expect(
        bundle.unsupportedItems.some((u) => u.reason === 'session_history_excluded'),
      ).toBe(true);
    });

    it('produces a bundle with no credential-shaped value', async () => {
      const { bundle } = await bundleFor(fixture.root);
      const serialized = JSON.stringify(bundle);
      expect(() => assertNoSecrets(serialized)).not.toThrow();
      expect(serialized).not.toContain(FAKE_ANTHROPIC_KEY);
    });
  });

  describe('pause guidance', () => {
    it('says there is nothing to stop', async () => {
      const { adapter, installation } = await bundleFor(fixture.root);
      expect(adapter.pauseGuidance(installation).steps.join(' ')).toMatch(
        /nothing needs to be stopped/i,
      );
    });
  });

  describe('contract neutrality', () => {
    it('produces the same bundle shape as the other adapters', async () => {
      const { bundle } = await bundleFor(fixture.root);
      expect(Object.keys(bundle).sort()).toEqual(
        [
          'adapterVersion',
          'agents',
          'bundleVersion',
          'catalogConnectorRequirements',
          'customMcpServerRequirements',
          'diagnostics',
          'governanceRules',
          'hostingRequirements',
          'installationFingerprint',
          'instructions',
          'memories',
          'modelPreferences',
          'routines',
          'skills',
          'source',
          'sourceVersion',
          'agentRelationships',
          'unsupportedItems',
        ].sort(),
      );
    });
  });
});
