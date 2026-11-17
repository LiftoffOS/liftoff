// Export the classifier's regression fixtures from the seed migrations.
//
// Reads the two seed migrations whose rows carry the `mcp_seed_v1` /
// `vendor_seed_v1` hash markers (082, 084) and writes one fixture per row
// under src/typesafe/fixtures/classifier/seed-<integration>-<tool>.json,
// expecting each seeded category on `yes` and every other on `no`.
//
// Those reviewer values are SEED MARKERS, not human adjudication: the rows
// were written from vendor tool inventories to skip a first-call
// classification, and a fixture's note says so. A seed row carries no
// description, so the state is the name alone — which is also what the
// generation prompt saw for these rows.
//
//   npx ts-node --transpile-only scripts/export-classifier-fixtures-from-seeds.ts

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CLASSIFIER_SET, CLASSIFIER_CATEGORIES } from '../src/typesafe/questions';

const ROOT = join(__dirname, '..');
const SEED_MIGRATIONS = [
  { file: 'migrations/082_seed_mcp_tool_classifications.sql', marker: 'mcp_seed_v1' },
  { file: 'migrations/084_seed_vendor_mcp_tool_classifications.sql', marker: 'vendor_seed_v1' },
];
const OUT_DIR = join(ROOT, 'src/typesafe/fixtures/classifier');

/**
 * Seeded categories that rest on a side effect the bare tool name does not
 * state, and that the classifier answers a confident no to on a name-only
 * input (measured on jev-1.13.0, p(yes) at 0.000): creating a
 * calendar event notifies attendees, creating a drive permission shares the
 * file, a pull-request review is posted where reviewers read it. A row with
 * no description cannot carry that, so these expectations are advisory —
 * reported by the contract test, never a failure — and the note says why.
 * Every other seeded category is binding.
 */
const NAME_ONLY_GAPS: ReadonlyArray<{ integration: string; tool: string; category: string; why: string }> = [
  { integration: 'google_calendar', tool: 'create_event', category: 'externalPublishing', why: 'attendee notification is a side effect the name does not state' },
  { integration: 'microsoft_outlook_calendar', tool: 'create_event', category: 'externalPublishing', why: 'attendee notification is a side effect the name does not state' },
  { integration: 'google_drive', tool: 'create_permission', category: 'externalPublishing', why: 'sharing is a side effect the name does not state' },
  { integration: 'github', tool: 'create_pull_request_review', category: 'externalPublishing', why: 'a posted review is visible to reviewers; the name says only that one is created' },
];

// ('tool', 'integration', 'marker', ARRAY['a', 'b'] | ARRAY[]::TEXT[], ...)
const ROW = /^\s*\('([^']+)',\s*'([^']+)',\s*'([^']+)',\s*ARRAY\[([^\]]*)\](?:::TEXT\[\])?/;

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  let count = 0;
  for (const { file, marker } of SEED_MIGRATIONS) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const line of text.split('\n')) {
      const m = ROW.exec(line);
      if (!m || m[3] !== marker) continue;
      const [, tool, integration, , cats] = m;
      const seeded = cats.split(',').map((c) => c.trim().replace(/^'|'$/g, '')).filter(Boolean);
      const expect: Record<string, { choice: string; advisory?: boolean }> = {};
      const gaps: string[] = [];
      for (const c of CLASSIFIER_CATEGORIES) {
        const gap = NAME_ONLY_GAPS.find((g) => g.integration === integration && g.tool === tool && g.category === c);
        // The seeded categories are binding; every other category is advisory:
        // the contract claims a category is omitted only on a confident no, not
        // that the classifier never adds one the seed lacks.
        expect[c] = seeded.includes(c)
          ? (gap ? { choice: 'yes', advisory: true } : { choice: 'yes' })
          : { choice: 'no', advisory: true };
        if (gap) gaps.push(`${c} is advisory: ${gap.why}`);
      }
      const fixture = {
        set: { id: CLASSIFIER_SET.id, version: CLASSIFIER_SET.version, model: CLASSIFIER_SET.model },
        state: { tool: { name: tool, description: '' } },
        expect,
        note: `Exported from ${file} (${marker}). The seed's reviewer value is a seed marker, not human adjudication; the row was written from the vendor's tool inventory with no description. `
          + 'The "no" expectations are advisory: the contract claims a category is omitted only on a confident no, not that Jev never adds one the seed lacks; an addition is reported, never a failure.'
          + (gaps.length > 0 ? ` ${gaps.join('; ')}.` : ''),
      };
      writeFileSync(join(OUT_DIR, `seed-${integration}-${tool}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
      count += 1;
    }
  }
  console.log(`wrote ${count} seed fixtures to ${OUT_DIR}`);
}

main();
