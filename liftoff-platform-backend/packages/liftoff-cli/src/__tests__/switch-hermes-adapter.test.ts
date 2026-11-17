// Hermes adapter.
//
// Hermes is primarily one persistent agent per profile. The property that
// matters most here is negative: transient delegated workers must NOT become
// permanent Liftoff team members, because handing a switcher a team of ghosts
// on day one is worse than importing nothing.

import { hermesAdapter } from '../switch/sources/hermes';
import { assertNoSecrets } from '../switch/secret-filter';
import {
  buildHermesFixture,
  write,
  FAKE_HERMES_SLACK,
  type FixtureHandle,
} from './switch-fixtures';

describe('hermes adapter', () => {
  let fixture: FixtureHandle;

  beforeAll(() => {
    fixture = buildHermesFixture();
  });

  afterAll(() => fixture.cleanup());

  async function bundleFor(root: string) {
    const adapter = hermesAdapter({ path: root });
    const installations = await adapter.detect();
    expect(installations.length).toBeGreaterThan(0);
    const inventory = await adapter.inventory(installations[0]);
    return { adapter, installation: installations[0], inventory, bundle: await adapter.normalize(inventory) };
  }

  // A schedule with no owner still has to run.
  //
  // Hermes cron jobs carry no agent id at all. Matching them to an identity by
  // that empty field dropped every one of them: no member received a trigger and
  // no member was spawned for the extras. Nothing failed, because the bundle's
  // `routines` array still listed them against a fallback owner — and Liftoff has
  // no routine entity, so a schedule that does not become a member's trigger does
  // not run. A real Hermes import produced three team members and zero schedules.
  describe('unassigned schedules', () => {
    it('gives the first identity the schedule when the job names no owner', async () => {
      const { bundle } = await bundleFor(fixture.root);
      const scheduled = bundle.agents.filter((a) => a.cronExpr);
      expect(scheduled.length).toBeGreaterThan(0);
    });

    it('spawns a member for every schedule beyond the first', async () => {
      // Two jobs in the fixture, both unowned. One becomes the owner's trigger,
      // the other becomes a member of its own, so both actually run.
      const { bundle } = await bundleFor(fixture.root);
      const crons = bundle.agents.map((a) => a.cronExpr).filter(Boolean).sort();
      expect(crons.length).toBeGreaterThanOrEqual(1);
      // Every imported cron job is represented by some member's trigger.
      for (const routine of bundle.routines) {
        expect(bundle.agents.some((a) => a.cronExpr === routine.cronExpr)).toBe(true);
      }
    });
  });

  describe('detection', () => {
    it('detects a profile and reads its version', async () => {
      const { installation } = await bundleFor(fixture.root);
      expect(installation.source).toBe('hermes');
      expect(installation.sourceVersion).toBe('0.9.4');
    });
  });

  describe('identities', () => {
    it('creates one team member for the profile itself', async () => {
      const { inventory } = await bundleFor(fixture.root);
      const profile = inventory.identities.find((i) => i.sourceRef.startsWith('profile:'));
      expect(profile).toBeDefined();
      expect(profile!.displayName).toBe('Ada');
    });

    it('imports a stable registered multi-agent definition', async () => {
      const { inventory } = await bundleFor(fixture.root);
      expect(inventory.identities.map((i) => i.sourceRef)).toContain('agent:analyst');
    });

    it('refuses to manufacture a team member from a transient worker', async () => {
      const { inventory, bundle } = await bundleFor(fixture.root);
      expect(inventory.identities.map((i) => i.sourceRef)).not.toContain('agent:scratch');
      expect(bundle.agents.map((a) => a.sourceRef)).not.toContain('agent:scratch');
      expect(
        bundle.unsupportedItems.some(
          (u) => u.reason === 'transient_delegation_not_an_identity' && u.sourceRef === 'agent:scratch',
        ),
      ).toBe(true);
    });
  });

  describe('artifacts', () => {
    it('imports SOUL.md as instructions and MEMORY.md as a memory', async () => {
      const { inventory } = await bundleFor(fixture.root);
      const profile = inventory.identities.find((i) => i.sourceRef.startsWith('profile:'))!;
      expect(profile.artifacts.some((a) => a.sourcePath.endsWith('SOUL.md'))).toBe(true);
      expect(profile.memories.some((m) => m.sourcePath.endsWith('MEMORY.md'))).toBe(true);
    });

    it('treats USER.md as instructions rather than a memory', async () => {
      const { inventory } = await bundleFor(fixture.root);
      const profile = inventory.identities.find((i) => i.sourceRef.startsWith('profile:'))!;
      expect(profile.artifacts.some((a) => a.sourcePath.endsWith('USER.md'))).toBe(true);
      expect(profile.memories.some((m) => m.sourcePath.endsWith('USER.md'))).toBe(false);
    });

    it('imports local skills', async () => {
      const { inventory } = await bundleFor(fixture.root);
      const profile = inventory.identities.find((i) => i.sourceRef.startsWith('profile:'))!;
      expect(profile.skills.map((s) => s.name)).toContain('reporting');
    });

    // Upstream lays skills out as `skills/<category>/<name>/SKILL.md`. Naming
    // a skill for its FILE called every one of them `SKILL`, and the name-keyed
    // dedupe then kept exactly one: an installation with a dozen skills
    // imported one, under a name that was not its own.
    it('names a nested skill for its directory, and imports every one of them', async () => {
      const { inventory } = await bundleFor(fixture.root);
      const profile = inventory.identities.find((i) => i.sourceRef.startsWith('profile:'))!;
      const names = profile.skills.map((s) => s.name);

      expect(names).toEqual(expect.arrayContaining(['reporting', 'docx', 'gif-search']));
      expect(names).not.toContain('SKILL');
      // The legacy flat layout keeps its file-derived name.
      expect(names).toContain('standup-notes');
    });

    it('folds a support file into its skill rather than importing it as one', async () => {
      const { inventory } = await bundleFor(fixture.root);
      const profile = inventory.identities.find((i) => i.sourceRef.startsWith('profile:'))!;

      expect(profile.skills.map((s) => s.name)).not.toContain('references');
      expect(profile.skills.map((s) => s.name)).not.toContain('formatting');

      const docx = profile.skills.find((s) => s.name === 'docx')!;
      // The body is the skill's own instruction text and nothing else. Its
      // reference doc travels as one of the skill's FILES: a reference is
      // something the agent opens when it needs it, not something that belongs
      // in every prompt.
      expect(docx.text).toContain('Edit documents in place.');
      expect(docx.text).not.toContain('Styles beat direct formatting.');
      expect(docx.files?.map((f) => f.path)).toEqual(['references/formatting.md']);
      expect(docx.files?.[0].text).toContain('Styles beat direct formatting.');
    });

    it('imports memories as agent-scoped so they land without extra consent', async () => {
      const { bundle } = await bundleFor(fixture.root);
      for (const memory of bundle.memories) {
        expect(memory.scope).toBe('agent');
      }
    });
  });

  describe('state.db', () => {
    it('reports message history as excluded rather than importing it', async () => {
      const withDb = buildHermesFixture();
      write(withDb.root, 'state.db', 'SQLite format 3 ');
      const { inventory } = await bundleFor(withDb.root);
      const excluded = inventory.unsupportedItems.find((u) => u.reason === 'session_history_excluded');
      expect(excluded).toBeDefined();
      expect(excluded!.detail).toMatch(/pending delegations/i);
      withDb.cleanup();
    });
  });

  describe('connections', () => {
    it('maps recognised channels and classifies stdio MCP as requiring hosting', async () => {
      const { bundle } = await bundleFor(fixture.root);
      const types = bundle.catalogConnectorRequirements.map((c) => c.connectorType);
      expect(types).toEqual(expect.arrayContaining(['slack', 'telegram']));
      expect(bundle.hostingRequirements.map((h) => h.name)).toContain('localtools');
      expect(bundle.customMcpServerRequirements.map((s) => s.name)).toContain('reporting');
    });
  });

  describe('secrets', () => {
    it('produces a bundle with no credential-shaped value', async () => {
      const { bundle } = await bundleFor(fixture.root);
      expect(() => assertNoSecrets(JSON.stringify(bundle))).not.toThrow();
      expect(JSON.stringify(bundle)).not.toContain(FAKE_HERMES_SLACK);
    });
  });

  describe('unknown fields', () => {
    it('reports an unrecognised config field by name only', async () => {
      const { bundle } = await bundleFor(fixture.root);
      const unknown = bundle.unsupportedItems.filter(
        (u) => u.reason === 'unknown_configuration_field',
      );
      expect(unknown.some((u) => u.sourceRef === 'config:unknown_future_field')).toBe(true);
      expect(JSON.stringify(unknown)).not.toContain('value that must not be reported');
    });
  });

  describe('pause guidance', () => {
    it('returns copyable guidance that Liftoff never executes', async () => {
      const { adapter, installation } = await bundleFor(fixture.root);
      const guidance = adapter.pauseGuidance(installation);
      expect(guidance.command).toBe('hermes gateway stop');
      expect(guidance.steps.some((s) => /launchd or systemd/i.test(s))).toBe(true);
      expect(guidance.supervisedNote).toMatch(/does not run this command/i);
    });
  });

  describe('contract neutrality', () => {
    it('produces the same bundle shape as the OpenClaw adapter', async () => {
      const { bundle } = await bundleFor(fixture.root);
      // Hermes was written against the contract OpenClaw settled. If this list
      // ever needs a Hermes-specific key, the contract was not source-neutral.
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
