#!/usr/bin/env npx ts-node
// Promote a family of templates' sub-workflow headers into flow stubs, their
// clock lines into companionCrons, and their edge-case bullets into eval
// skeletons. The lifting lives in src/scripts/promote-template-flows.ts; this
// is its command line.
//
//   npx ts-node --transpile-only scripts/promote-template-flows.ts nda-analyst spa-analyst --dry-run
//   npx ts-node --transpile-only scripts/promote-template-flows.ts nda-analyst spa-analyst --write
//
// Everything it writes is REFUSED by the validator until authored: useWhen and
// notNeededFor are empty, eval turns are empty. Run once per family, author,
// commit the family.

import { run, FlowIdCollisionError } from '../src/scripts/promote-template-flows';

const args = process.argv.slice(2);
const write = args.includes('--write');
const dryRun = args.includes('--dry-run');
const ids = args.filter((a) => !a.startsWith('--'));

if (!write && !dryRun) {
  console.error('Pass --dry-run or --write, and at least one template id.');
  process.exit(1);
}

try {
  run(ids, write);
} catch (err) {
  // A collision is the one failure this script exists to make visible: it is
  // printed whole and nothing is written.
  console.error(err instanceof FlowIdCollisionError ? err.message : (err as Error).stack ?? String(err));
  process.exit(1);
}
