// Pick MERGE and FLOOR thresholds for skill-feedback dedup from a labeled
// CSV produced by calibrate-skill-dedup-thresholds.ts + operator labeling.
//
// Reads gs://${CALIBRATION_GCS_BUCKET}/skill-dedup/${ts}/skill-pairs-labeled.csv
// (path provided via LABELED_CSV_GCS_URI). The label column must contain one
// of: duplicate / related / distinct. Pairs without a label are skipped.
//
// Selection criteria:
//   MERGE_THRESHOLD = the highest cosine such that precision-for-duplicate >= 0.95
//     across all pairs with cosine >= the threshold. Walks candidates top-down.
//   FLOOR_THRESHOLD = the lowest cosine such that recall-for-distinct >= 0.95
//     across pairs labeled 'distinct' (i.e., 95% of 'distinct' pairs sit below
//     the threshold). Walks candidates bottom-up.
//
// Output: prints both numbers and the confusion matrix at each. Operator
// signs off; values then go into Terraform env_vars on platform-backend.
//
// Usage (Cloud Run Job — same image as calibrate):
//   gcloud run jobs create skill-dedup-pick \
//     --image=us-west1-docker.pkg.dev/.../platform-backend:<sha> \
//     --region=us-west1 --project=YOUR_CONTROL_PROJECT \
//     --service-account=platform-backend-prod@... \
//     --set-env-vars="LABELED_CSV_GCS_URI=gs://.../skill-pairs-labeled.csv" \
//     --command=node --args="dist/scripts/pick-skill-dedup-thresholds.js" \
//     --memory=512Mi --cpu=1 --task-timeout=300 --max-retries=0
//
// Standalone — no DB, no embedding calls. GCS read only.

import { Storage } from '@google-cloud/storage';

type Label = 'duplicate' | 'related' | 'distinct';

interface Pair {
  cosine: number;
  label: Label;
}

const MERGE_PRECISION_TARGET = 0.95;
const FLOOR_RECALL_TARGET = 0.95;

function parseGcsUri(uri: string): { bucket: string; objectPath: string } {
  if (!uri.startsWith('gs://')) throw new Error(`Not a gs:// URI: ${uri}`);
  const rest = uri.slice('gs://'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) throw new Error(`Malformed gs:// URI: ${uri}`);
  return { bucket: rest.slice(0, slash), objectPath: rest.slice(slash + 1) };
}

async function readCsvFromGcs(uri: string): Promise<string> {
  const { bucket, objectPath } = parseGcsUri(uri);
  const storage = new Storage();
  const [body] = await storage.bucket(bucket).file(objectPath).download();
  return body.toString('utf-8');
}

function parseCsv(body: string): Pair[] {
  const lines = body.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const cosineIdx = header.indexOf('cosine');
  const labelIdx = header.indexOf('label');
  if (cosineIdx < 0 || labelIdx < 0) {
    throw new Error(`CSV missing required columns. Header: ${header.join(',')}`);
  }

  const pairs: Pair[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const cosine = parseFloat(cells[cosineIdx]);
    const labelRaw = (cells[labelIdx] ?? '').trim().toLowerCase();
    if (!Number.isFinite(cosine)) continue;
    if (labelRaw !== 'duplicate' && labelRaw !== 'related' && labelRaw !== 'distinct') continue;
    pairs.push({ cosine, label: labelRaw as Label });
  }
  return pairs;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { buf += '"'; i += 1; continue; }
      if (c === '"') { inQuotes = false; continue; }
      buf += c;
    } else {
      if (c === ',') { out.push(buf); buf = ''; continue; }
      if (c === '"' && buf.length === 0) { inQuotes = true; continue; }
      buf += c;
    }
  }
  out.push(buf);
  return out;
}

interface ConfusionRow {
  threshold: number;
  duplicateAbove: number;
  relatedAbove: number;
  distinctAbove: number;
  duplicateBelow: number;
  relatedBelow: number;
  distinctBelow: number;
}

function confusionAt(pairs: Pair[], threshold: number): ConfusionRow {
  const row: ConfusionRow = {
    threshold,
    duplicateAbove: 0, relatedAbove: 0, distinctAbove: 0,
    duplicateBelow: 0, relatedBelow: 0, distinctBelow: 0,
  };
  for (const p of pairs) {
    const above = p.cosine >= threshold;
    if (p.label === 'duplicate') {
      if (above) row.duplicateAbove += 1; else row.duplicateBelow += 1;
    } else if (p.label === 'related') {
      if (above) row.relatedAbove += 1; else row.relatedBelow += 1;
    } else {
      if (above) row.distinctAbove += 1; else row.distinctBelow += 1;
    }
  }
  return row;
}

function pickMergeThreshold(pairs: Pair[]): { threshold: number; confusion: ConfusionRow } | null {
  // Walk candidate thresholds from highest cosine down. The first threshold
  // at which precision-for-duplicate drops below MERGE_PRECISION_TARGET, we
  // stop and return the previous threshold (i.e., the lowest cosine where
  // precision was still >= target).
  const candidates = Array.from(new Set(pairs.map(p => p.cosine))).sort((a, b) => b - a);
  let last: { threshold: number; confusion: ConfusionRow } | null = null;
  for (const t of candidates) {
    const c = confusionAt(pairs, t);
    const above = c.duplicateAbove + c.relatedAbove + c.distinctAbove;
    if (above === 0) continue;
    const precision = c.duplicateAbove / above;
    if (precision >= MERGE_PRECISION_TARGET) {
      last = { threshold: t, confusion: c };
    } else {
      break;
    }
  }
  return last;
}

function pickFloorThreshold(pairs: Pair[]): { threshold: number; confusion: ConfusionRow } | null {
  // Walk candidate thresholds from lowest cosine up. We want the highest
  // threshold at which recall-for-distinct (distinctBelow / totalDistinct)
  // is still >= FLOOR_RECALL_TARGET.
  const totalDistinct = pairs.filter(p => p.label === 'distinct').length;
  if (totalDistinct === 0) return null;
  const candidates = Array.from(new Set(pairs.map(p => p.cosine))).sort((a, b) => a - b);
  let last: { threshold: number; confusion: ConfusionRow } | null = null;
  for (const t of candidates) {
    const c = confusionAt(pairs, t);
    const recall = c.distinctBelow / totalDistinct;
    if (recall >= FLOOR_RECALL_TARGET) {
      last = { threshold: t, confusion: c };
    } else {
      break;
    }
  }
  return last;
}

function printConfusion(label: string, picked: { threshold: number; confusion: ConfusionRow } | null): void {
  if (!picked) {
    console.log(`${label}: no threshold satisfies the criterion.`);
    return;
  }
  const c = picked.confusion;
  const total = c.duplicateAbove + c.relatedAbove + c.distinctAbove + c.duplicateBelow + c.relatedBelow + c.distinctBelow;
  console.log(`${label}: ${picked.threshold.toFixed(4)}`);
  console.log(`  At this threshold (${total} pairs total):`);
  console.log(`    above threshold: duplicate=${c.duplicateAbove}, related=${c.relatedAbove}, distinct=${c.distinctAbove}`);
  console.log(`    below threshold: duplicate=${c.duplicateBelow}, related=${c.relatedBelow}, distinct=${c.distinctBelow}`);
  const above = c.duplicateAbove + c.relatedAbove + c.distinctAbove;
  const below = c.duplicateBelow + c.relatedBelow + c.distinctBelow;
  if (above > 0) {
    const prec = (c.duplicateAbove / above * 100).toFixed(1);
    console.log(`    precision-for-duplicate (above): ${prec}%`);
  }
  if (below > 0) {
    const totalDistinct = c.distinctAbove + c.distinctBelow;
    if (totalDistinct > 0) {
      const recall = (c.distinctBelow / totalDistinct * 100).toFixed(1);
      console.log(`    recall-for-distinct (below): ${recall}%`);
    }
  }
}

export async function runPickThresholds(): Promise<void> {
  const uri = process.env.LABELED_CSV_GCS_URI;
  if (!uri) throw new Error('LABELED_CSV_GCS_URI env var is required');

  console.log(`Reading labeled CSV from ${uri}...`);
  const body = await readCsvFromGcs(uri);
  const pairs = parseCsv(body);
  console.log(`  parsed ${pairs.length} labeled pairs`);
  const byLabel = pairs.reduce<Record<Label, number>>((acc, p) => {
    acc[p.label] = (acc[p.label] ?? 0) + 1;
    return acc;
  }, { duplicate: 0, related: 0, distinct: 0 });
  console.log(`  label distribution: ${JSON.stringify(byLabel)}`);

  if (byLabel.duplicate < 5 || byLabel.distinct < 5) {
    console.warn('  WARN: very few duplicate or distinct labels — thresholds may not be defensible. Consider labeling more pairs.');
  }

  console.log('');
  const merge = pickMergeThreshold(pairs);
  printConfusion('MERGE_THRESHOLD', merge);
  console.log('');
  const floor = pickFloorThreshold(pairs);
  printConfusion('FLOOR_THRESHOLD', floor);
  console.log('');

  if (!merge || !floor) {
    console.error('Could not pick both thresholds. Label more pairs or revisit criteria.');
    process.exit(1);
  }
  if (merge.threshold <= floor.threshold) {
    console.error(
      `ERROR: MERGE_THRESHOLD (${merge.threshold}) must be strictly greater than FLOOR_THRESHOLD (${floor.threshold}). Inspect the labels — likely too few duplicates near the boundary.`,
    );
    process.exit(1);
  }

  console.log('Set on platform-backend via Terraform (modules/platform-backend → env_vars):');
  console.log(`  SKILL_DEDUP_ENABLED=true`);
  console.log(`  SKILL_DEDUP_MERGE_THRESHOLD=${merge.threshold.toFixed(4)}`);
  console.log(`  SKILL_DEDUP_FLOOR_THRESHOLD=${floor.threshold.toFixed(4)}`);
}

if (require.main === module) {
  runPickThresholds().then(() => process.exit(0)).catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
