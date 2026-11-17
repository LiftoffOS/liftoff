// Which connectors are ready to be ENFORCED, and which are not yet.
//
// Enforcement is per connector because coverage is, so the question "is this
// safe to turn on" has to be asked per connector too. A calendar cannot answer
// it: a quiet week and a clean week look identical on a clock, and a connector
// nothing exercises never becomes ready no matter how long you wait.
//
// Four questions, all answerable from what the gate already records:
//
//   1. Did the gate JUDGE this connector at all? Zero judged writes means no
//      evidence, and flipping is a guess dressed as a decision.
//   2. Are its declarations reaching anything? A write with no declaration is
//      counted not_judged. Mostly-not-judged means enforcement refuses nothing
//      while appearing switched on.
//   3. Which of its write tools were exercised? Enforcement is per connector;
//      the evidence is per tool, and the gap between them is where a surprise
//      lives.
//   4. Was every would_block genuine? This is the only part needing judgement
//      rather than counting, and it is the one that matters: a would_block on
//      legitimate work becomes a refusal the moment you flip.
//
// Reads Cloud Logging, because that is where the gate's telemetry lands. Prints
// a row per connector and says plainly what it cannot answer.
//
//   npx tsx src/scripts/provenance-readiness.ts --project YOUR_TENANT_PROJECT --days 7

import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

interface Row {
  connector: string;
  checked: number;
  notJudged: number;
  wouldBlock: number;
  writeTools: Set<string>;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function readMetric(project: string, freshness: string, metric: string): Promise<Array<{
  connector?: string; actionType?: string;
}>> {
  const { stdout } = await run('gcloud', [
    'logging', 'read', `jsonPayload.metric="${metric}"`,
    `--project=${project}`, '--limit=2000', `--freshness=${freshness}`,
    '--format=json',
  ], { maxBuffer: 64 * 1024 * 1024 });
  const rows = JSON.parse(stdout) as Array<{ jsonPayload?: Record<string, unknown> }>;
  return rows.map((r) => ({
    connector: r.jsonPayload?.connector as string | undefined,
    actionType: r.jsonPayload?.actionType as string | undefined,
  }));
}

async function main(): Promise<void> {
  const project = arg('project', 'YOUR_TENANT_PROJECT');
  const days = arg('days', '7');
  const freshness = `${days}d`;

  const rows = new Map<string, Row>();
  const row = (c: string): Row => {
    const existing = rows.get(c);
    if (existing) return existing;
    const made: Row = { connector: c, checked: 0, notJudged: 0, wouldBlock: 0, writeTools: new Set() };
    rows.set(c, made);
    return made;
  };

  for (const [metric, field] of [
    ['provenance.checked', 'checked'],
    ['provenance.not_judged', 'notJudged'],
    ['provenance.would_block', 'wouldBlock'],
  ] as const) {
    for (const e of await readMetric(project, freshness, metric)) {
      if (!e.connector) continue;
      const r = row(e.connector);
      r[field] += 1;
      if (e.actionType) r.writeTools.add(e.actionType);
    }
  }

  if (rows.size === 0) {
    console.log(`No provenance telemetry in ${project} over ${freshness}.`);
    console.log('That is not "everything is fine" — it is "the gate judged nothing", ');
    console.log('which is the one state enforcement must not be turned on from.');
    return;
  }

  const sorted = [...rows.values()].sort((a, b) => b.checked - a.checked);
  console.log(`\nProvenance readiness — ${project}, last ${freshness}\n`);
  console.log('connector'.padEnd(26) + 'judged'.padStart(8) + 'unjudged'.padStart(10)
    + 'would-block'.padStart(13) + 'tools'.padStart(7) + '  verdict');
  for (const r of sorted) {
    // Ready means: the gate ran, its declarations reached most writes, and it
    // refused nothing legitimate. The last clause is the one a person still has
    // to check by reading them — a count cannot tell a real catch from a false
    // alarm, and this week every alarm in the window was false.
    const judgedShare = r.checked / Math.max(1, r.checked + r.notJudged);
    const verdict = r.checked === 0
      ? 'no evidence — never judged'
      : judgedShare < 0.5
        ? 'declarations reach little of its traffic'
        : r.wouldBlock > 0
          ? `read the ${r.wouldBlock} would-block(s) before flipping`
          : 'ready, pending a look at its write-tool coverage';
    console.log(
      r.connector.padEnd(26)
      + String(r.checked).padStart(8)
      + String(r.notJudged).padStart(10)
      + String(r.wouldBlock).padStart(13)
      + String(r.writeTools.size).padStart(7)
      + '  ' + verdict,
    );
  }
  console.log('\nA connector absent from this table was never exercised, which is');
  console.log('not the same as clean. Enforce with PROVENANCE_ENFORCE_CONNECTORS.\n');
}

void main().catch((err: Error) => {
  console.error('provenance-readiness failed:', err.message);
  process.exit(1);
});
