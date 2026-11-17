// Calibration harness for capability discovery.
//
//   npm run calibrate:capability-discovery -- --inputs /path/to/agents.json
//
// The floors and the weak-fit threshold in src/capability-discovery/config.ts
// carry a calibration contract: validate against REAL production intents,
// hand-check the top-k, then fix the numbers and name the run. This script is
// that run's harness. Feed it the role/responsibilities rows exported from
// the production database (via the psql runbook — this box cannot reach
// Cloud SQL), and it prints, per agent:
//
//   - the derived capability specs (or why none derived),
//   - the ranked candidates with the judge's reasons and every score factor,
//   - the weak-fit verdict under the CURRENT threshold,
//
// plus a distribution summary at the end so a threshold can be chosen from
// evidence instead of invented. It calls the live sources and the judge
// exactly as production does — run it with dev credentials.
//
// Input file shape: [{ "role": "...", "responsibilities": "...",
//                      "integrationTypes": ["slack", ...] }, ...]

import * as fs from 'fs';
import { deriveCapabilitySpecs } from '../src/internal-agents/distill-prior-art-injection';
import { discoverCapabilities } from '../src/capability-discovery';
import { WEAK_FIT_THRESHOLD } from '../src/capability-discovery/config';

interface CalibrationRow {
  role: string;
  responsibilities: string;
  integrationTypes?: string[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const inputPath = args[args.indexOf('--inputs') + 1];
  if (!inputPath || !fs.existsSync(inputPath)) {
    console.error('usage: calibrate-capability-discovery.ts --inputs <agents.json>');
    process.exit(1);
  }
  const rows = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as CalibrationRow[];
  const topScores: number[] = [];
  let derivedNone = 0;

  for (const [i, row] of rows.entries()) {
    console.log(`\n=== [${i}] ${row.role}`);
    const specs = deriveCapabilitySpecs(
      row.role,
      row.responsibilities,
      row.integrationTypes ?? [],
      'calibration',
    );
    if (specs.length === 0) {
      derivedNone += 1;
      console.log('  (no public-data intent derived — no prior art for this agent)');
      continue;
    }
    for (const spec of specs) {
      const result = await discoverCapabilities(spec);
      const top = result.candidates[0];
      topScores.push(top?.finalScore ?? 0);
      console.log(
        `  spec: ${spec.targetSystem ?? '<any>'} / ${spec.operation} ${spec.entity}` +
          `${result.degraded ? '  [DEGRADED]' : ''}`,
      );
      for (const c of result.candidates) {
        console.log(
          `    ${c.finalScore.toFixed(2)}  [${c.route}] ${c.title}` +
            `\n          judge=${c.judge.capabilityMatch} in=${c.judge.inputSupplyable} out=${c.judge.outputCovers}` +
            ` — ${c.judge.reason}`,
        );
      }
      if ((top?.finalScore ?? 0) < WEAK_FIT_THRESHOLD) {
        console.log(`    ** WEAK FIT under current threshold ${WEAK_FIT_THRESHOLD}`);
      }
    }
  }

  topScores.sort((a, b) => a - b);
  const pct = (p: number) => topScores[Math.floor(topScores.length * p)] ?? 0;
  console.log('\n=== distribution of top scores ===');
  console.log(`queries: ${topScores.length}  (agents with no derivable intent: ${derivedNone})`);
  if (topScores.length > 0) {
    console.log(
      `p10=${pct(0.1).toFixed(2)}  p25=${pct(0.25).toFixed(2)}  median=${pct(0.5).toFixed(2)}` +
        `  p75=${pct(0.75).toFixed(2)}  p90=${pct(0.9).toFixed(2)}`,
    );
    console.log(
      `current WEAK_FIT_THRESHOLD=${WEAK_FIT_THRESHOLD} marks ` +
        `${topScores.filter((s) => s < WEAK_FIT_THRESHOLD).length}/${topScores.length} weak`,
    );
  }
  console.log(
    '\nHand-check the reasons above, then fix the constants in ' +
      'src/capability-discovery/config.ts and record this run beside them.',
  );
}

void main();
