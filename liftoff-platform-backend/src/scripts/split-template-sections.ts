// Split every catalog template's authored prose into `sections`.
//
// Mechanical and reversible: `sections` is a parsed VIEW of `responsibilities`
// and `additionalContext`, which stay authoritative and stay the thing that
// hires an agent. Nothing about a generated agent changes at this step, and the
// validator enforces that the two cannot disagree — a section body that does
// not appear in the prose is an error, not a second copy.
//
// What the split BUYS is routing. `SECTION_DESTINATION` says which layer of the
// compiled agent each heading feeds, and it can only be applied to sections
// that have been separated. A heading with no destination is the interesting
// output of this script rather than a failure of it: it is a section nobody has
// classified, and it has to become a toolNote (material read while writing one
// call's arguments), a flow (a named sub-workflow), or a vocabulary heading.
//
//   npx ts-node src/scripts/split-template-sections.ts --dry-run
//   npx ts-node src/scripts/split-template-sections.ts --write

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { SECTION_DESTINATION } from '@liftoffos/workforce-types';

const CATALOG = join(__dirname, '..', 'agent-templates', 'catalog');

/** Split `## Heading\n\nbody` markdown into a heading→body map, preserving the
 *  body exactly so it can be checked back against the source. */
export function splitSections(markdown: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Split on headings at the start of a line, keeping the heading text.
  const parts = markdown.split(/^(## .+)$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const heading = parts[i].trim();
    const body = (parts[i + 1] ?? '').trim();
    if (body) out[heading] = body;
  }
  return out;
}

interface Report {
  templateId: string;
  sectionCount: number;
  offVocabulary: string[];
}

function run(write: boolean): void {
  const reports: Report[] = [];

  for (const filename of readdirSync(CATALOG).filter((f) => f.endsWith('.yaml')).sort()) {
    const path = join(CATALOG, filename);
    const raw = readFileSync(path, 'utf8');
    const doc = yaml.load(raw) as {
      id: string;
      responsibilities?: string;
      additionalContext?: string;
      sections?: Record<string, string>;
    };

    const sections = {
      ...splitSections(doc.responsibilities ?? ''),
      ...splitSections(doc.additionalContext ?? ''),
    };
    const offVocabulary = Object.keys(sections).filter((h) => !(h in SECTION_DESTINATION));
    reports.push({ templateId: doc.id, sectionCount: Object.keys(sections).length, offVocabulary });

    // A template with an unclassified heading is SKIPPED rather than written.
    // Writing it would put a section in `sections` that routes to no layer of
    // the agent, and the validator rejects exactly that — so the file would be
    // written into a state that fails to load. The classification is the work;
    // this script only does the mechanical half.
    if (!write || offVocabulary.length > 0) continue;

    // Written back through the YAML the file already is, rather than by
    // re-serialising the whole document: a full round-trip through js-yaml
    // reflows every block scalar in the file and the diff becomes unreadable,
    // which for a hand-maintained catalog is the difference between a review
    // and a rubber stamp.
    const block = yaml.dump({ sections }, { lineWidth: -1, noRefs: true, indent: 2 });
    const marker = '\nrequiredConnectors:';
    if (!raw.includes(marker)) {
      throw new Error(`${filename}: no requiredConnectors anchor to insert before`);
    }
    const withoutOld = raw.replace(/\nsections:\n(?:\x20{2}.*\n|\n)*?(?=[a-zA-Z])/, '\n');
    writeFileSync(path, withoutOld.replace(marker, `\n${block}${marker}`), 'utf8');
  }

  const offVocab = reports.filter((r) => r.offVocabulary.length > 0);
   
  console.log(
    `${reports.length} templates, ${reports.reduce((n, r) => n + r.sectionCount, 0)} sections, `
    + `${offVocab.length} carrying a heading with no destination`,
  );
  for (const r of offVocab) {
     
    console.log(`  ${r.templateId}: ${r.offVocabulary.join(' | ')}`);
  }
  if (!write) {
     
    console.log('\nDry run. Re-run with --write to apply.');
  }
}

if (require.main === module) {
  const write = process.argv.includes('--write');
  if (!write && !process.argv.includes('--dry-run')) {
     
    console.error('Pass --dry-run or --write.');
    process.exit(1);
  }
  run(write);
}
