/**
 * SDK Hook Contract Tests — the PR-time half of the gate.
 *
 * The behaviours themselves live in
 * agent-execution/certification/sdk-hook-contract.ts, so the weekly
 * certification run asserts exactly the same things this suite does. See that
 * file for what changed when the probes were first actually executed: the old
 * version of this suite collected two event types the SDK does not emit, so
 * half of it passed against nothing, and it asserted a `PreToolUse` throw
 * blocks execution, which is false on the pinned version.
 *
 * These probes drive the live API, so they skip without a credential. The pin
 * assertions below always run, and they are what catches the dangerous case:
 * someone moving the SDK version without re-running the contract.
 */
import { SDK_HOOK_CONTRACT_PROBES, hookContractUnrunnableReason } from '../../agent-execution/certification/sdk-hook-contract';

// The probes drive the live API. Without the SDK installed and a credential
// present they cannot run, and the SAME predicate the certification run uses
// decides that — so "can this be checked here" has one answer, not two that can
// disagree.
const describeOrSkip = hookContractUnrunnableReason() ? describe.skip : describe;

// The four behaviours themselves live in
// agent-execution/certification/sdk-hook-contract.ts, because the weekly
// certification run needs to assert exactly the same things this suite does and
// a contract written out twice drifts in whichever copy is run less often.
//
// This suite is the PR-time consumer: it fails when someone moves the pinned
// SDK version and the semantics moved with it. The certification category is
// the scheduled consumer, running against the live API in the
// engine-certification job.
describeOrSkip('SDK hook contract (Phase -1 gate)', () => {
  it.each(SDK_HOOK_CONTRACT_PROBES.map((p) => [p.name, p] as const))(
    '%s',
    async (_name, probe) => {
      await expect(probe.run()).resolves.toBeUndefined();
    },
    120_000,
  );
});

// ── The pin itself ──────────────────────────────────────────────────────────
//
// The contract above is only meaningful against a KNOWN version, and the doc
// that states it had drifted: it said 0.2.98 while the runtime had been on
// 0.3.220 for weeks. Anyone reading that page to decide whether an upgrade was
// safe was reading about a version we do not run.
//
// So the version is read from package.json — the only place that decides it —
// and the doc is checked against it rather than trusted.
describe('the pinned SDK version', () => {
  const readJson = (rel: string): Record<string, unknown> =>
    JSON.parse(require('fs').readFileSync(require('path').join(__dirname, rel), 'utf8'));

  const pinned = (): string => {
    const pkg = readJson('../../../package.json') as { dependencies?: Record<string, string> };
    const v = pkg.dependencies?.['@anthropic-ai/claude-agent-sdk'];
    if (!v) throw new Error('@anthropic-ai/claude-agent-sdk is not a dependency');
    return v;
  };

  // A range would let a patch release change hook semantics between two
  // deploys with nothing in the repo recording it, which is precisely what the
  // contract suite exists to prevent.
  it('is an exact version, not a range', () => {
    expect(pinned()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('matches the version the contract document states', () => {
    const doc = require('fs').readFileSync(
      require('path').join(__dirname, '../../../docs/sdk-hook-contract.md'), 'utf8',
    ) as string;
    const stated = /Current pinned version:\s*\*\*([^*]+)\*\*/.exec(doc)?.[1]?.trim();
    expect(stated).toBe(pinned());
  });

  // The adapter header names the version it was verified against. A silent
  // upgrade that left the header behind would make the verification claim false.
  it('matches the version the adapter header names', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../agent-execution/adapter/anthropic/index.ts'), 'utf8',
    ) as string;
    const named = /@anthropic-ai\/claude-agent-sdk@(\d+\.\d+\.\d+)/.exec(src)?.[1];
    expect(named).toBe(pinned());
  });
});
