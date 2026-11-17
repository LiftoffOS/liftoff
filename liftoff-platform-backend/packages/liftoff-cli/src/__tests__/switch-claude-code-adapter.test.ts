// Claude Code adapter.
//
// Two properties matter more than the rest here, and both are negative: the
// installation's `settings.json` holds a real credential and none of it may
// travel, and Liftoff writes its OWN entries into this installation — so an
// import that reads them back hands a workspace a duplicate of its own
// plumbing and points it at itself.

import fs from 'fs';
import path from 'path';
import { claudeCodeAdapter } from '../switch/sources/claude-code';
import { assertNoSecrets } from '../switch/secret-filter';
import {
  buildClaudeCodeFixture,
  makeTempRoot,
  write,
  FAKE_ANTHROPIC_KEY,
  FAKE_GITHUB_TOKEN,
  type FixtureHandle,
} from './switch-fixtures';

describe('claude code adapter', () => {
  let fixture: FixtureHandle;

  beforeAll(() => {
    fixture = buildClaudeCodeFixture();
  });

  afterAll(() => fixture.cleanup());

  async function bundleFor(root: string, opts: { includeProjects?: boolean } = {}) {
    const adapter = claudeCodeAdapter({ path: root, ...opts });
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

  describe('detection', () => {
    it('finds the installation and reads its version without running anything', async () => {
      const { installation } = await bundleFor(fixture.root);
      expect(installation.source).toBe('claude-code');
      expect(installation.sourceVersion).toBe('2.0.31');
    });
  });

  describe('identities', () => {
    it('creates the primary assistant', async () => {
      const { inventory } = await bundleFor(fixture.root);
      expect(inventory.identities.map((i) => i.sourceRef)).toContain('assistant:primary');
    });

    it('treats each sub-agent definition as a durable identity', async () => {
      // A file somebody wrote and named, not a record of something a session
      // spawned — the same distinction the Hermes adapter draws.
      const { inventory, bundle } = await bundleFor(fixture.root);
      expect(inventory.identities.map((i) => i.sourceRef)).toEqual(
        expect.arrayContaining(['subagent:code-reviewer', 'subagent:release-manager']),
      );
      expect(bundle.agentRelationships).toEqual(
        expect.arrayContaining([
          { fromSourceRef: 'assistant:primary', toSourceRef: 'subagent:code-reviewer', kind: 'delegates_to' },
        ]),
      );
    });
  });

  describe('artifacts', () => {
    it('imports the global instructions and the rules beside them', async () => {
      const { inventory } = await bundleFor(fixture.root);
      const primary = inventory.identities.find((i) => i.sourceRef === 'assistant:primary')!;
      const paths = primary.artifacts.map((a) => a.sourcePath);
      expect(paths.some((p) => p.endsWith('CLAUDE.md'))).toBe(true);
      expect(paths.some((p) => p.endsWith('gcloud.md'))).toBe(true);
    });

    it('skips the collaboration file Liftoff itself wrote', async () => {
      const { inventory } = await bundleFor(fixture.root);
      const primary = inventory.identities.find((i) => i.sourceRef === 'assistant:primary')!;
      expect(
        primary.artifacts.some((a) => a.sourcePath.endsWith('collab.md')),
      ).toBe(false);
    });

    it('imports skills and slash commands as skills', async () => {
      const { inventory } = await bundleFor(fixture.root);
      const primary = inventory.identities.find((i) => i.sourceRef === 'assistant:primary')!;
      expect(primary.skills.map((s) => s.name)).toEqual(
        expect.arrayContaining(['deploy', 'review']),
      );
    });

    it("carries a skill's text files and refuses the one nothing can scan", async () => {
      const { inventory, bundle } = await bundleFor(fixture.root);
      const primary = inventory.identities.find((i) => i.sourceRef === 'assistant:primary')!;
      const deploy = primary.skills.find((s) => s.name === 'deploy')!;

      expect(deploy.files?.map((f) => f.path).sort()).toEqual([
        'references/runbook.md',
        'scripts/check.sh',
      ]);
      expect(
        bundle.unsupportedItems.some(
          (u) => u.reason === 'binary_asset_excluded' && u.detail.includes('logo.png'),
        ),
      ).toBe(true);
    });
  });

  describe('memories', () => {
    it('imports memory files and skips the index', async () => {
      const { bundle } = await bundleFor(fixture.root);
      const paths = bundle.memories.map((m) => m.sourcePath);
      expect(paths.some((p) => p.endsWith('prefers-bullets.md'))).toBe(true);
      expect(paths.some((p) => p.endsWith('MEMORY.md'))).toBe(false);
    });

    it('scopes a memory about the PERSON to the workspace and the rest to the member', async () => {
      // Scope decides consent (invariant 9): what describes the person is
      // shared and therefore consented; what describes this member's own work
      // lands immediately.
      const { bundle } = await bundleFor(fixture.root);
      const feedback = bundle.memories.find((m) => m.sourcePath.endsWith('prefers-bullets.md'))!;
      const project = bundle.memories.find((m) => m.sourcePath.endsWith('deploy-cadence.md'))!;
      expect(feedback.scope).toBe('workspace');
      expect(project.scope).toBe('agent');
    });
  });

  describe('connections', () => {
    it('maps a recognised server to a catalog connector', async () => {
      const { bundle } = await bundleFor(fixture.root);
      expect(bundle.catalogConnectorRequirements.map((c) => c.connectorType)).toContain('github');
    });

    it('carries an http server as a customer-owned MCP endpoint', async () => {
      const { bundle } = await bundleFor(fixture.root);
      expect(bundle.customMcpServerRequirements.map((s) => s.name)).toContain('context7');
    });

    it('classifies a stdio server as requiring hosting, with its package recorded', async () => {
      const { bundle } = await bundleFor(fixture.root);
      const local = bundle.hostingRequirements.find((h) => h.name === 'localtools');
      expect(local).toBeDefined();
      expect(local!.packageIdentity).toEqual({ registryType: 'npm', name: '@acme/local-mcp' });
    });

    it("never imports Liftoff's own MCP entry back", async () => {
      const { bundle } = await bundleFor(fixture.root);
      const names = [
        ...bundle.customMcpServerRequirements.map((s) => s.name),
        ...bundle.hostingRequirements.map((h) => h.name),
        ...bundle.catalogConnectorRequirements.map((c) => c.sourceRef),
      ];
      expect(names.join(' ')).not.toContain('liftoff');
    });
  });

  describe('policies', () => {
    it('carries deny and ask, and reports allow as having no equivalent', async () => {
      const { bundle } = await bundleFor(fixture.root);
      const kinds = (bundle.governanceRules ?? []).map((r) => r.kind);
      expect(kinds).toEqual(expect.arrayContaining(['tool_denied', 'tool_approval_required']));
      expect(
        bundle.unsupportedItems.some((u) => u.sourceRef === 'permission:allow'),
      ).toBe(true);
    });

    it('reports hooks rather than importing an enforcement mechanism', async () => {
      const { bundle } = await bundleFor(fixture.root);
      expect(
        bundle.unsupportedItems.some(
          (u) => u.sourceRef === 'hook:PreToolUse' && u.reason === 'executable_plugin',
        ),
      ).toBe(true);
    });

    it('records the model preference', async () => {
      const { bundle } = await bundleFor(fixture.root);
      expect(bundle.modelPreferences[0]?.model).toBe('claude-fable-5');
      expect(bundle.modelPreferences[0]?.note).toMatch(/high/i);
    });
  });

  describe('secrets', () => {
    it('names the env vars it did not read, and reads none of their values', async () => {
      const { bundle } = await bundleFor(fixture.root);
      const excluded = bundle.unsupportedItems.find((u) => u.sourceRef === 'settings:env');
      expect(excluded).toBeDefined();
      expect(excluded!.detail).toContain('ANTHROPIC_API_KEY');
      expect(excluded!.detail).not.toContain(FAKE_ANTHROPIC_KEY);
    });

    it('produces a bundle with no credential-shaped value anywhere', async () => {
      const { bundle } = await bundleFor(fixture.root);
      const serialized = JSON.stringify(bundle);
      expect(() => assertNoSecrets(serialized)).not.toThrow();
      expect(serialized).not.toContain(FAKE_ANTHROPIC_KEY);
      expect(serialized).not.toContain(FAKE_GITHUB_TOKEN);
    });
  });

  describe('projects', () => {
    it('counts registered projects without reading inside them by default', async () => {
      // Reading someone's repositories is a different consent posture from
      // reading their own config directory.
      const { bundle } = await bundleFor(fixture.root);
      expect((bundle.diagnostics ?? []).join(' ')).toMatch(/registered project/i);
    });

    it('reads a project when the person opts in', async () => {
      // The opt-in has to actually reach the scan. A flag that threads through
      // three layers and changes nothing is the shape of defect this codebase
      // keeps finding late.
      const project = makeTempRoot('claude-code-project');
      write(project.root, 'CLAUDE.md', '# Repo rules\nSquash before merge.\n');
      write(
        project.root,
        '.claude/skills/repo-deploy/SKILL.md',
        '---\nname: repo-deploy\n---\n# Repo deploy\nTag first.\n',
      );
      write(project.root, '.claude/agents/repo-reviewer.md', '---\nname: repo-reviewer\n---\nReview.\n');
      write(
        project.root,
        '.mcp.json',
        JSON.stringify({ mcpServers: { repotools: { command: 'uvx', args: ['repo-mcp'] } } }),
      );

      // Point the installation's project registry at the temp repo.
      const registryPath = path.join(path.dirname(fixture.root), '.claude.json');
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as {
        projects: Record<string, unknown>;
      };
      const originalProjects = registry.projects;
      registry.projects = { [project.root]: { hasTrustDialogAccepted: true } };
      fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

      try {
        const { inventory, bundle } = await bundleFor(fixture.root, { includeProjects: true });
        const primary = inventory.identities.find((i) => i.sourceRef === 'assistant:primary')!;

        expect(primary.artifacts.some((a) => a.sourcePath.endsWith('CLAUDE.md'))).toBe(true);
        expect(primary.skills.map((s) => s.name)).toContain('repo-deploy');
        expect(inventory.identities.map((i) => i.sourceRef)).toContain('subagent:repo-reviewer');
        expect(bundle.hostingRequirements.map((h) => h.name)).toContain('repotools');
      } finally {
        registry.projects = originalProjects;
        fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
        project.cleanup();
      }
    });
  });

  describe('pause guidance', () => {
    it('says there is nothing to stop, because there is not', async () => {
      const { adapter, installation } = await bundleFor(fixture.root);
      const guidance = adapter.pauseGuidance(installation);
      expect(guidance.command).toBeUndefined();
      expect(guidance.steps.join(' ')).toMatch(/nothing needs to be stopped/i);
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
