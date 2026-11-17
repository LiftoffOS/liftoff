// OpenClaw adapter: detection, inventory, normalization, pause guidance.

import fs from 'fs';
import path from 'path';
import { openclawAdapter, normalizeCron } from '../switch/sources/openclaw';
import { assertNoSecrets } from '../switch/secret-filter';
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_CONTENT_CHARS,
  packArtifacts,
  prioritizeArtifacts,
  normalizeIdentity,
  splitSchedules,
  recordNormalizationLosses,
  boundDiagnostics,
  MAX_DIAGNOSTIC_CHARS,
  MAX_DIAGNOSTIC_LINES,
  MAX_INTEGRATIONS,
  type NormalizableArtifact,
} from '../switch/normalizer';
import type { ArtifactCategory } from '../switch/normalizer';
import {
  buildOpenClawFixture,
  buildOversizedOpenClawFixture,
  write,
  FAKE_ANTHROPIC_KEY,
  FAKE_ENV_ANTHROPIC,
  FAKE_GITHUB_TOKEN,
  FAKE_SLACK_TOKEN,
  type FixtureHandle,
} from './switch-fixtures';

// Overflow packing.
//
// An installation with more files than Liftoff can attach must still import. The
// question is WHICH material survives, and the answer cannot be "whatever the
// filesystem listed last" — nor can it be "ask the person to pick four files to
// delete", which is not a question anyone can answer well. Instructions are the
// member's identity and the distiller's primary input; skills are how it works;
// memories are the most reconstructible, because the member re-learns them in
// use. So that is the order material is given up in.
describe('artifact overflow', () => {
  const artifact = (sourcePath: string, category: ArtifactCategory): NormalizableArtifact => ({
    sourcePath,
    text: `contents of ${sourcePath}`,
    category,
  });

  it('gives up the most reconstructible material first', () => {
    const ordered = prioritizeArtifacts([
      artifact('memories/2026-01-02.md', 'memory'),
      artifact('routines/weekly.md', 'routine'),
      artifact('skills/triage.md', 'skill'),
      artifact('AGENTS.md', 'instructions'),
    ]).map((a) => a.category);

    expect(ordered).toEqual(['instructions', 'skill', 'routine', 'memory']);
  });

  it('drops the OLDEST memory, not the newest', () => {
    // Dated filenames sort descending so the newest is nearest the front and
    // the oldest is what falls off the end. Reversed, an import would keep a
    // member's earliest recollections and discard everything it just learned.
    const ordered = prioritizeArtifacts([
      artifact('memories/2026-01-01.md', 'memory'),
      artifact('memories/2026-08-01.md', 'memory'),
      artifact('memories/2026-04-01.md', 'memory'),
    ]).map((a) => a.sourcePath);

    expect(ordered).toEqual([
      'memories/2026-08-01.md',
      'memories/2026-04-01.md',
      'memories/2026-01-01.md',
    ]);
  });

  it('imports every category even when slots are scarce', () => {
    // Every present category gets a slot before any gets a second one. Spending
    // all three on instructions would import a member with no skills at all,
    // which reads as a successful import of the wrong thing.
    //
    // And with three slots for fifteen small files, NOTHING is dropped: a slot
    // holds as many files as fit inside the content bound. The attachment limit
    // costs material only when the corpus is also large, which is why the
    // person importing is not asked to choose.
    const many = (category: ArtifactCategory, n: number) =>
      Array.from({ length: n }, (_, i) => artifact(`${category}/${i}.md`, category));

    const packed = packArtifacts(
      prioritizeArtifacts([...many('instructions', 5), ...many('skill', 5), ...many('memory', 5)]),
      3,
    );

    expect(packed.attachments).toHaveLength(3);
    expect(packed.attachments.map((a) => a.category).sort()).toEqual([
      'instructions',
      'memory',
      'skill',
    ]);
    expect(packed.excludedSourcePaths).toEqual([]);
  });

  describe('when the content bound is reached too', () => {
    // Same three slots, files large enough that joining cannot rescue them.
    const big = (sourcePath: string, category: ArtifactCategory): NormalizableArtifact => ({
      sourcePath,
      text: 'x'.repeat(MAX_ATTACHMENT_CONTENT_CHARS),
      category,
    });
    const pack = () =>
      packArtifacts(
        prioritizeArtifacts([
          big('AGENTS.md', 'instructions'),
          big('skills/triage.md', 'skill'),
          big('memories/2026-01-01.md', 'memory'),
          big('memories/2026-02-01.md', 'memory'),
          big('memories/2026-03-01.md', 'memory'),
        ]),
        3,
      );

    it('gives up whole memories rather than the instructions', () => {
      const packed = pack();
      expect(packed.excludedSourcePaths).toEqual([
        'memories/2026-02-01.md',
        'memories/2026-01-01.md',
      ]);
      expect(packed.attachments.some((a) => a.sourcePaths.includes('AGENTS.md'))).toBe(true);
    });

    it('never reports an imported file as excluded', () => {
      // A file whose first chunk was attached and whose tail was dropped used to
      // land in BOTH lists, so a support case reading the exclusions was told a
      // file had not arrived while its content sat in an attachment.
      const packed = pack();
      const attached = new Set(packed.attachments.flatMap((a) => a.sourcePaths));
      for (const path of packed.excludedSourcePaths) {
        expect(attached.has(path)).toBe(false);
      }
    });

    it('reports a shortened file as truncated, not excluded', () => {
      const packed = pack();
      expect(packed.truncatedSourcePaths).toContain('AGENTS.md');
      expect(packed.excludedSourcePaths).not.toContain('AGENTS.md');
    });

    it('records each path once', () => {
      // The flush and the packing loop each used to push the same path.
      const all = [...packed().excludedSourcePaths, ...packed().truncatedSourcePaths];
      expect(new Set(all).size).toBe(all.length);
      function packed() {
        return pack();
      }
    });
  });

  it('never exceeds the attachment limit', () => {
    const packed = packArtifacts(
      prioritizeArtifacts(
        Array.from({ length: MAX_ATTACHMENTS * 3 }, (_, i) =>
          artifact(`skills/${i}.md`, 'skill'),
        ),
      ),
      MAX_ATTACHMENTS,
    );
    expect(packed.attachments.length).toBeLessThanOrEqual(MAX_ATTACHMENTS);
  });

  it('keeps every attachment inside the content bound', () => {
    // Packing joins several files into one attachment, which is exactly how a
    // bound gets exceeded by accident.
    const packed = packArtifacts(
      Array.from({ length: 40 }, (_, i) => ({
        sourcePath: `skills/${i}.md`,
        text: 'x'.repeat(20_000),
        category: 'skill' as const,
      })),
      MAX_ATTACHMENTS,
    );
    for (const attachment of packed.attachments) {
      expect(attachment.content.length).toBeLessThanOrEqual(MAX_ATTACHMENT_CONTENT_CHARS);
    }
  });

  it('excludes everything when there are no slots at all', () => {
    // Reported, not silently empty: the caller records exclusions in
    // diagnostics, and an empty list there would say nothing was dropped.
    const packed = packArtifacts([artifact('AGENTS.md', 'instructions')], 0);
    expect(packed.attachments).toEqual([]);
    expect(packed.excludedSourcePaths).toEqual(['AGENTS.md']);
  });

  it('packs identically on a re-run', () => {
    // The normalized-input hash is what makes a re-import skip work already
    // paid for. Non-deterministic packing would change the hash and redistill
    // an unchanged installation.
    const input = [
      artifact('skills/b.md', 'skill'),
      artifact('AGENTS.md', 'instructions'),
      artifact('memories/2026-01-01.md', 'memory'),
    ];
    const first = packArtifacts(prioritizeArtifacts(input), 2);
    const second = packArtifacts(prioritizeArtifacts([...input].reverse()), 2);
    expect(first).toEqual(second);
  });
});

// Which schedule the identity keeps.
//
// Liftoff models exactly one trigger per team member, and the source hangs a
// list of cron jobs off one agent. The member that keeps the identity's
// instructions, skills and memories is the one whose schedule this picks, so the
// choice decides what the imported team member actually does. Pure alphabetical
// order made it an accident: an identity called Support Triage whose main job
// ran hourly took its 9am digest instead, because "digest" sorts before
// "hourly", and the hourly work became a separate member with one attachment.
describe('splitSchedules', () => {
  const job = (sourceRef: string, cronExpr: string) => ({
    sourceRef,
    name: sourceRef,
    cronExpr,
    prompt: 'do the thing',
  });

  it('gives the identity its most frequent schedule', () => {
    const split = splitSchedules([
      job('routine:triage-digest', '0 9 * * *'),
      job('routine:triage-hourly', '0 * * * *'),
    ]);

    expect(split.ownerCronExpr).toBe('0 * * * *');
    expect(split.spawned.map((s) => s.sourceRef)).toEqual(['routine:triage-digest']);
  });

  it('orders every remaining schedule most frequent first', () => {
    const split = splitSchedules([
      job('routine:monthly', '0 0 1 * *'),
      job('routine:weekly', '0 8 * * 1'),
      job('routine:minutely', '*/5 * * * *'),
      job('routine:daily', '0 9 * * *'),
    ]);

    expect(split.ownerCronExpr).toBe('*/5 * * * *');
    expect(split.spawned.map((s) => s.sourceRef)).toEqual([
      'routine:daily',
      'routine:weekly',
      'routine:monthly',
    ]);
  });

  it('breaks ties deterministically so a re-run produces the same team', () => {
    // Two schedules at the same cadence must not swap owner between runs; the
    // normalized-input hash depends on the result.
    const jobs = [job('routine:b', '0 9 * * *'), job('routine:a', '0 9 * * *')];
    const first = splitSchedules(jobs);
    const second = splitSchedules([...jobs].reverse());

    expect(first).toEqual(second);
    expect(first.spawned.map((s) => s.sourceRef)).toEqual(['routine:b']);
  });

  it('never lets an unparseable schedule win the identity', () => {
    // A cadence Liftoff cannot read is the last thing that should define what
    // the identity does.
    const split = splitSchedules([job('routine:odd', 'not a cron'), job('routine:daily', '0 9 * * *')]);
    expect(split.ownerCronExpr).toBe('0 9 * * *');
  });

  it('has no owner and nothing spawned when there are no schedules', () => {
    expect(splitSchedules([])).toEqual({ spawned: [] });
  });
});

// What the import gave up, recorded for support.
//
// This exists because the fact was being computed and thrown away: packing
// decided which files to drop, and nothing kept the decision, so "my
// instructions file did not come across" had no answer anywhere in the system.
describe('normalization diagnostics', () => {
  const overflowing = () =>
    normalizeIdentity({
      sourceRef: 'agent:support',
      label: 'Support Triage',
      responsibilities: 'Triage tickets.',
      artifacts: Array.from({ length: 30 }, (_, i) => ({
        sourcePath: `memories/2026-${String(i + 1).padStart(2, '0')}.md`,
        text: 'x'.repeat(MAX_ATTACHMENT_CONTENT_CHARS),
        category: 'memory' as const,
      })),
      integrationRefs: Array.from({ length: MAX_INTEGRATIONS + 3 }, (_, i) => `int-${i}`),
      mcpServerRefs: [],
      routineRefs: [],
    });

  it('names what was dropped and why', () => {
    const lines: string[] = [];
    recordNormalizationLosses(lines, 'agent:support', overflowing());

    expect(lines.some((l) => l.includes('were not imported'))).toBe(true);
    expect(lines.some((l) => l.includes('integration(s) beyond the'))).toBe(true);
    expect(lines.every((l) => l.startsWith('agent:support:'))).toBe(true);
  });

  it('stays under the size the server accepts', () => {
    // The server validates each line at 1024 characters and rejects the WHOLE
    // bundle when one is longer. An installation with enough overflow to write
    // a long note would then fail to import BECAUSE of the note explaining why
    // material was dropped — the diagnostic breaking the thing it describes.
    const lines: string[] = [];
    recordNormalizationLosses(lines, 'agent:support', {
      excludedSourcePaths: Array.from({ length: 400 }, (_, i) => `memories/very-long-name-${i}.md`),
      truncatedSourcePaths: [],
      unselectedIntegrationRefs: [],
    });

    expect(lines).toHaveLength(1);
    expect(lines[0].length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CHARS);
    // Still says how many, even though it cannot name them all.
    expect(lines[0]).toContain('400 file(s)');
  });

  it('says nothing when nothing was lost', () => {
    // An empty list is the normal case, and a diagnostics array full of "0
    // files dropped" lines would bury the one entry that matters.
    const lines: string[] = [];
    recordNormalizationLosses(lines, 'agent:support', {
      excludedSourcePaths: [],
      truncatedSourcePaths: [],
      unselectedIntegrationRefs: [],
    });
    expect(lines).toEqual([]);
  });

});

describe('openclaw adapter', () => {
  let fixture: FixtureHandle;

  beforeAll(() => {
    fixture = buildOpenClawFixture();
  });

  afterAll(() => fixture.cleanup());

  async function bundleFor(root: string) {
    const adapter = openclawAdapter({ path: root });
    const installations = await adapter.detect();
    expect(installations).toHaveLength(1);
    const inventory = await adapter.inventory(installations[0]);
    return { adapter, installation: installations[0], inventory, bundle: await adapter.normalize(inventory) };
  }

  describe('detection', () => {
    it('finds an installation at an explicit path and reads its version', async () => {
      const adapter = openclawAdapter({ path: fixture.root });
      const found = await adapter.detect();
      expect(found).toHaveLength(1);
      expect(found[0].source).toBe('openclaw');
      expect(found[0].sourceVersion).toBe('2026.8.1');
      expect(found[0].installationFingerprint).toMatch(/^[0-9a-f]{32}$/);
    });

    it('reports nothing for a directory with no configuration', async () => {
      const empty = buildOversizedOpenClawFixture(1);
      fs.rmSync(path.join(empty.root, 'openclaw.json'));
      const adapter = openclawAdapter({ path: empty.root });
      expect(await adapter.detect()).toHaveLength(0);
      empty.cleanup();
    });

    it('produces a stable fingerprint across runs', async () => {
      const a = await openclawAdapter({ path: fixture.root }).detect();
      const b = await openclawAdapter({ path: fixture.root }).detect();
      expect(a[0].installationFingerprint).toBe(b[0].installationFingerprint);
    });
  });

  describe('inventory', () => {
    it('imports both persistent agents and neither manufactures nor drops one', async () => {
      const { inventory } = await bundleFor(fixture.root);
      expect(inventory.identities.map((i) => i.sourceRef).sort()).toEqual([
        'agent:research',
        'agent:triage',
      ]);
    });

    it('collects instructions, memories and skills for an agent', async () => {
      const { inventory } = await bundleFor(fixture.root);
      const research = inventory.identities.find((i) => i.sourceRef === 'agent:research')!;
      expect(research.artifacts.some((a) => a.sourcePath.endsWith('AGENTS.md'))).toBe(true);
      expect(research.artifacts.some((a) => a.sourcePath.endsWith('SOUL.md'))).toBe(true);
      expect(research.memories.length).toBeGreaterThanOrEqual(2);
      expect(research.skills.map((s) => s.name)).toContain('brief-writing');
    });

    // A skill's `references/` and `examples/` files were named for their parent
    // directory, so each became a skill of its own called `references` or
    // `examples`, holding one page of another skill's notes.
    it('imports a skill with support directories as ONE skill', async () => {
      const { inventory, bundle } = await bundleFor(fixture.root);
      const research = inventory.identities.find((i) => i.sourceRef === 'agent:research')!;
      const names = research.skills.map((s) => s.name);

      expect(names.filter((n) => n === 'brief-writing')).toHaveLength(1);
      expect(names).not.toContain('references');
      expect(names).not.toContain('examples');
      expect(bundle.skills.map((s) => s.name)).not.toContain('references');
      expect(bundle.skills.map((s) => s.name)).not.toContain('examples');

      const brief = research.skills.find((s) => s.name === 'brief-writing')!;
      // The body is the skill's own text; its references and examples travel as
      // the skill's FILES rather than being inlined into every prompt.
      expect(brief.text).toContain('One page maximum.');
      expect(brief.text).not.toContain('Active voice. No hedging.');
      expect(brief.files?.map((f) => f.path).sort()).toEqual([
        'examples/q3-brief.md',
        'references/style-guide.md',
      ]);
    });

    it('keeps the flat layout naming a skill for its file', async () => {
      const { inventory } = await bundleFor(fixture.root);
      const triage = inventory.identities.find((i) => i.sourceRef === 'agent:triage')!;
      expect(triage.skills.map((s) => s.name)).toContain('severity');
    });

    it('reports the session store as excluded rather than importing transcripts', async () => {
      const withDb = buildOpenClawFixture();
      // A session database with real-looking rows. The exclusion is only
      // meaningful when the material it excludes actually exists.
      write(withDb.root, 'agents/research/agent/openclaw-agent.sqlite', 'SQLite format 3\0');
      const { inventory } = await bundleFor(withDb.root);
      const excluded = inventory.unsupportedItems.find((u) => u.reason === 'session_history_excluded');
      expect(excluded).toBeDefined();
      expect(excluded!.detail).toMatch(/stay in OpenClaw/i);
      withDb.cleanup();
    });

    it('reports an unknown configuration field by name and never by value', async () => {
      const { inventory } = await bundleFor(fixture.root);
      const unknown = inventory.unsupportedItems.filter(
        (u) => u.reason === 'unknown_configuration_field',
      );
      expect(unknown.some((u) => u.sourceRef === 'config:experimentalTelemetry')).toBe(true);
      expect(JSON.stringify(unknown)).not.toContain('telemetry.example.com');
      expect(JSON.stringify(unknown)).not.toContain('sk-live-nope');
    });

    it('never reads credential files', async () => {
      const { inventory } = await bundleFor(fixture.root);
      const serialized = JSON.stringify(inventory);
      expect(serialized).not.toContain(FAKE_ENV_ANTHROPIC);
      expect(serialized).not.toContain(FAKE_SLACK_TOKEN);
    });
  });

  describe('normalization', () => {
    it('produces a bundle that carries no credential-shaped value', async () => {
      const { bundle } = await bundleFor(fixture.root);
      expect(() => assertNoSecrets(JSON.stringify(bundle))).not.toThrow();
    });

    it('redacts a credential pasted into an instruction file', async () => {
      const { bundle } = await bundleFor(fixture.root);
      const serialized = JSON.stringify(bundle);
      expect(serialized).not.toContain(FAKE_GITHUB_TOKEN);
      expect(serialized).toContain('[REDACTED]');
    });

    it('never carries an MCP header value, only its name', async () => {
      const { bundle } = await bundleFor(fixture.root);
      const serialized = JSON.stringify(bundle);
      expect(serialized).not.toContain(FAKE_ANTHROPIC_KEY);
      const mcp = bundle.customMcpServerRequirements.find((s) => s.name === 'reporting');
      expect(mcp?.customHeaderNames).toEqual(['Authorization']);
      expect(mcp?.authScheme).toBe('bearer');
    });

    it('classifies a stdio MCP server as requiring hosting, not as a connector', async () => {
      const { bundle } = await bundleFor(fixture.root);
      const hosting = bundle.hostingRequirements.find((h) => h.name === 'localtools');
      expect(hosting).toBeDefined();
      expect(hosting!.reason).toBe('stdio_mcp_requires_hosting');
      // Deliberately absent from both connector destinations.
      expect(bundle.customMcpServerRequirements.some((s) => s.name === 'localtools')).toBe(false);
      expect(bundle.catalogConnectorRequirements.some((c) => c.sourceRef === 'mcp:localtools')).toBe(
        false,
      );
    });

    it('maps recognised channels to catalog connectors and reports the rest', async () => {
      const { bundle } = await bundleFor(fixture.root);
      const types = bundle.catalogConnectorRequirements.map((c) => c.connectorType).sort();
      expect(types).toEqual(expect.arrayContaining(['github', 'slack']));
    });

    it('records agent-to-agent permissions as relationships, not as new members', async () => {
      const { bundle } = await bundleFor(fixture.root);
      expect(bundle.agentRelationships).toContainEqual({
        fromSourceRef: 'agent:research',
        toSourceRef: 'agent:triage',
        kind: 'delegates_to',
      });
      // triage could delegate to a non-existent worker: reported, never invented.
      expect(bundle.agents.map((a) => a.sourceRef)).not.toContain('agent:ghost-worker');
      expect(
        bundle.unsupportedItems.some((u) => u.reason === 'transient_delegation_not_an_identity'),
      ).toBe(true);
    });

    it('converts schedules it understands and reports the ones it does not', async () => {
      const { bundle } = await bundleFor(fixture.root);
      const weekly = bundle.routines.find((r) => r.sourceRef === 'routine:weekly-brief');
      expect(weekly?.cronExpr).toBe('0 9 * * 1');
      const hourly = bundle.routines.find((r) => r.sourceRef === 'routine:hourly-triage');
      expect(hourly?.cronExpr).toBe('0 * * * *');
      expect(bundle.routines.some((r) => r.sourceRef === 'routine:broken')).toBe(false);
      expect(bundle.unsupportedItems.some((u) => u.reason === 'unconvertible_schedule')).toBe(true);
    });

    it('marks imported routines with their source enablement without enabling them here', async () => {
      const { bundle } = await bundleFor(fixture.root);
      const weekly = bundle.routines.find((r) => r.sourceRef === 'routine:weekly-brief');
      expect(weekly?.enabledInSource).toBe(true);
      // The bundle carries no "enabled in Liftoff" concept at all; enablement
      // is a cutover decision.
      expect(Object.keys(weekly ?? {})).not.toContain('enabled');
    });

    it('produces byte-identical bundles across runs of the same installation', async () => {
      const first = await bundleFor(fixture.root);
      const second = await bundleFor(fixture.root);
      expect(JSON.stringify(second.bundle)).toEqual(JSON.stringify(first.bundle));
    });
  });

  describe('bundle diagnostics', () => {
    // A file over MAX_FILE_BYTES is skipped by the SCAN, before normalization
    // ever sees it. That is the case worth proving end to end: the finding is
    // made on the user's machine, and the bundle is the only thing that leaves
    // it. Seeded from the inventory or not at all.
    it('carries what the scan skipped off the machine', async () => {
      const big = buildOversizedOpenClawFixture(3_000_000);
      const { bundle } = await bundleFor(big.root);

      expect(bundle.diagnostics?.some((l) => l.includes('skipped oversized file'))).toBe(true);
      for (const line of bundle.diagnostics ?? []) {
        expect(line.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CHARS);
      }
      big.cleanup();
    });

    it('is empty for an installation that fits', async () => {
      // Otherwise every clean import ships noise and the one line that matters
      // is buried.
      const { bundle } = await bundleFor(fixture.root);
      expect(bundle.diagnostics).toEqual([]);
    });

    it('never carries file contents or a secret', async () => {
      // Diagnostics cross the network. Content in them would undo the redaction
      // the secret filter just did.
      const big = buildOversizedOpenClawFixture(3_000_000);
      const { bundle } = await bundleFor(big.root);
      for (const line of bundle.diagnostics ?? []) {
        assertNoSecrets(line);
        expect(line).not.toContain('AAAAAAAAAA');
      }
      big.cleanup();
    });

    it('bounds a runaway list to what the server accepts', () => {
      // A scan that hits the file cap can produce thousands of lines; the
      // server rejects the whole bundle past 500.
      const bounded = boundDiagnostics(
        Array.from({ length: 4000 }, (_, i) => `skipped something ${i}`),
      );
      expect(bounded).toHaveLength(MAX_DIAGNOSTIC_LINES);
      expect(bounded[bounded.length - 1]).toContain('further diagnostic(s) not reported');
    });
  });

  describe('distill bounds', () => {
    it('moves oversized instructions into attachments instead of truncating', async () => {
      const big = buildOversizedOpenClawFixture(250_000);
      const { bundle } = await bundleFor(big.root);
      const agent = bundle.agents[0];

      expect(agent.responsibilities.length).toBeLessThanOrEqual(10_000);
      expect(agent.attachments.length).toBeGreaterThan(0);
      expect(agent.attachments.length).toBeLessThanOrEqual(MAX_ATTACHMENTS);
      for (const att of agent.attachments) {
        expect(att.content.length).toBeLessThanOrEqual(MAX_ATTACHMENT_CONTENT_CHARS);
      }
      // The material survived somewhere: the sum of attachment content is
      // substantial, not a truncated stub.
      const carried = agent.attachments.reduce((n, a) => n + a.content.length, 0);
      expect(carried).toBeGreaterThan(100_000);
      big.cleanup();
    });

    it('keeps every attachment category-homogeneous', async () => {
      const { bundle } = await bundleFor(fixture.root);
      for (const agent of bundle.agents) {
        for (const att of agent.attachments) {
          expect(['instructions', 'skill', 'memory', 'routine']).toContain(att.category);
        }
        // Absorption classifies an attachment as a unit, so two categories
        // must never share one name.
        const names = agent.attachments.map((a) => `${a.category}:${a.name}`);
        expect(new Set(names).size).toBe(names.length);
      }
    });

    it('preserves source-path boundaries inside a packed attachment', async () => {
      const { bundle } = await bundleFor(fixture.root);
      const packed = bundle.agents
        .flatMap((a) => a.attachments)
        .find((a) => a.sourcePaths.length > 1);
      if (packed) {
        for (const p of packed.sourcePaths) {
          expect(packed.content).toContain(p);
        }
      }
    });
  });

  describe('schedules become how a team member runs', () => {
    it("puts the owner's schedule on the team member as its trigger", async () => {
      const { bundle } = await bundleFor(fixture.root);
      // The fixture gives Research one cron: Mondays 09:00.
      const research = bundle.agents.find((a) => a.sourceRef === 'agent:research');
      expect(research?.cronExpr).toBe('0 9 * * 1');
    });

    it('builds a team member for each additional schedule, so all of them run', async () => {
      const many = buildOpenClawFixture();
      write(
        many.root,
        'cron/jobs.json',
        JSON.stringify([
          { id: 'weekly-brief', name: 'Weekly brief', schedule: '0 9 * * 1', prompt: 'Write the weekly brief.', agentId: 'research' },
          { id: 'daily-scan', name: 'Daily scan', schedule: '0 7 * * *', prompt: 'Scan competitor pricing.', agentId: 'research' },
        ]),
      );
      const { bundle } = await bundleFor(many.root);

      // Liftoff gives each team member ONE trigger, so a second schedule
      // cannot ride along — it becomes its own member rather than being
      // silently dropped or parked in an object Liftoff does not model.
      const spawned = bundle.agents.find((a) => a.sourceRef.includes('::routine:'));
      expect(spawned).toBeDefined();
      expect(spawned!.role).toBe('Weekly brief');
      expect(spawned!.cronExpr).toBe('0 9 * * 1');

      // Every imported schedule is represented by exactly one trigger.
      const scheduled = bundle.agents.filter((a) => a.cronExpr).map((a) => a.cronExpr).sort();
      expect(scheduled).toEqual(['0 7 * * *', '0 9 * * 1']);
      many.cleanup();
    });

    it('carries the parent instructions into a spawned member so it inherits context', async () => {
      const many = buildOpenClawFixture();
      write(
        many.root,
        'cron/jobs.json',
        JSON.stringify([
          { id: 'a-first', name: 'First', schedule: '0 9 * * 1', prompt: 'Do the first thing.', agentId: 'research' },
          { id: 'b-second', name: 'Second', schedule: '0 7 * * *', prompt: 'Do the second thing.', agentId: 'research' },
        ]),
      );
      const { bundle } = await bundleFor(many.root);
      const spawned = bundle.agents.find((a) => a.sourceRef.includes('::routine:'))!;
      // It is distilled from its own prompt, not a copy of the parent's.
      expect(spawned.responsibilities).toContain('Do the');
      // But it still carries the parent's instruction files as context.
      expect(spawned.attachments.length).toBeGreaterThan(0);
      many.cleanup();
    });
  });

  describe('pause guidance', () => {
    it('returns copyable guidance and never executes it', async () => {
      const { adapter, installation } = await bundleFor(fixture.root);
      const guidance = adapter.pauseGuidance(installation);
      expect(guidance.command).toBe('openclaw gateway stop --disable --force --json');
      expect(guidance.steps.length).toBeGreaterThan(0);
      expect(guidance.supervisedNote).toMatch(/does not run this command/i);
      expect(guidance.supervisedNote).toMatch(/twice/i);
    });
  });
});

describe('cron normalization', () => {
  it.each([
    ['@hourly', '0 * * * *'],
    ['@daily', '0 0 * * *'],
    ['@weekly', '0 0 * * 0'],
    ['0 9 * * 1', '0 9 * * 1'],
    ['0 0 9 * * 1', '0 9 * * 1'],
  ])('converts %s', (input, expected) => {
    expect(normalizeCron(input)).toBe(expected);
  });

  it.each(['', 'not a schedule', '*/5 * * * * *', 'every monday'])(
    'refuses to guess at %s',
    (input) => {
      // A wrong schedule runs someone's work at the wrong time; reporting is
      // the only safe answer.
      expect(normalizeCron(input)).toBeNull();
    },
  );
});
