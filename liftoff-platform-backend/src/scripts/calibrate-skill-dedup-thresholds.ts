// Calibrate cosine thresholds for skill-feedback dedup.
//
// This script reads existing internal_agents.skills[] from the platform-
// backend control-plane DB, generates ~500 candidate pairs (intra-agent and
// cross-agent within the same role), embeds every unique skill ONCE via
// gemini-embedding-001 at 768d, computes pairwise cosines, and uploads a
// CSV to GCS for the operator to label. After labeling, the operator runs
// pick-skill-dedup-thresholds.ts on the labeled CSV to derive the two
// threshold values that go into SKILL_DEDUP_MERGE_THRESHOLD /
// SKILL_DEDUP_FLOOR_THRESHOLD.
//
// Where it runs.
//   Cloud Run Job (required) — Cloud SQL is private-IP only; laptop direct
//   access does not work. Image: the platform-backend image at the SHA that
//   contains this script. See CLAUDE.md "Pattern for a TypeScript script in
//   this repo".
//
// Required env:
//   CLOUD_SQL_CONNECTION_NAME=YOUR_CONTROL_PROJECT:us-west1:control-plane-pg-prod
//   DB_USER=liftoff_app  DB_NAME=liftoff_control  DB_PASSWORD=...
//   GCP_PROJECT_ID=YOUR_CONTROL_PROJECT
//   CALIBRATION_GCS_BUCKET=YOUR_CONTROL_PROJECT-calibration
//   GOOGLE_CLOUD_PROJECT (for vertex embedding)
//
// Optional env:
//   PAIR_CAP=500            (default; caps the number of pairs sampled)
//   USE_LLM_LABELER=true    (LLM pre-labels pairs; operator spot-checks)
//   ANTHROPIC_API_KEY       (only if USE_LLM_LABELER=true)
//
// Output: gs://${CALIBRATION_GCS_BUCKET}/skill-dedup/${timestamp}/skill-pairs-to-label.csv
//
// Usage (Cloud Run Job, dual-mode compiled entry):
//   gcloud run jobs create skill-dedup-calibrate \
//     --image=us-west1-docker.pkg.dev/.../platform-backend:<sha> \
//     --region=us-west1 --project=YOUR_CONTROL_PROJECT \
//     --service-account=platform-backend-prod@... \
//     --set-cloudsql-instances=YOUR_CONTROL_PROJECT:us-west1:control-plane-pg-prod \
//     --vpc-connector=serverless-connector --vpc-egress=private-ranges-only \
//     --set-env-vars="...as above..." \
//     --set-secrets="DB_PASSWORD=control-plane-db-password:latest" \
//     --command=node --args="dist/scripts/calibrate-skill-dedup-thresholds.js" \
//     --memory=2Gi --cpu=2 --task-timeout=1800 --max-retries=0
//   gcloud run jobs execute skill-dedup-calibrate --wait ...
//
// READ-ONLY against the DB; the script never writes to internal_agents.

import { Storage } from '@google-cloud/storage';
import { embeddingClient } from '@liftoffos/embedding';
import { initEmbeddingClient } from '../embedding/init';
import { withAdminScope, initDatabase } from '../infrastructure/database';
import { llmClient } from '../llm';
import { initLLMUsageTracking } from '../llm/usage-tracker';
import type { JSONSchema } from '../llm/types';

const EMBED_PROVIDER = 'google' as const;
const EMBED_DIMENSIONS = 768;
const DEFAULT_PAIR_CAP = 500;
const MAX_INTRA_AGENT_PAIRS = 200;
const MAX_CROSS_AGENT_PAIRS = 300;

interface SkillRow {
  agent_id: string;
  agent_role: string;
  skill: { id: string; name: string; description: string; instruction: string; tags?: string[] };
}

interface PairRow {
  pair_id: string;
  agent_a: string;
  skill_a_name: string;
  skill_a_text: string;
  agent_b: string;
  skill_b_name: string;
  skill_b_text: string;
  cosine: number;
}

function skillText(s: { description: string; instruction: string }): string {
  return `${s.description}\n${s.instruction}`.trim();
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function escapeCsv(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

async function loadAllSkills(): Promise<SkillRow[]> {
  return withAdminScope(
    { caller: 'scripts.calibrate-skill-dedup.load', reason: 'cross-tenant skill load' },
    async (client) => {
      const result = await client.query<{ id: string; role: string; skills: unknown }>(
        `SELECT id, role, skills
         FROM internal_agents
         WHERE status = 'active' AND deleted_at IS NULL AND skills IS NOT NULL`,
      );
      const out: SkillRow[] = [];
      for (const row of result.rows) {
        if (!Array.isArray(row.skills)) continue;
        for (const skill of row.skills) {
          if (
            skill &&
            typeof skill === 'object' &&
            typeof (skill as { id?: unknown }).id === 'string' &&
            typeof (skill as { description?: unknown }).description === 'string' &&
            typeof (skill as { instruction?: unknown }).instruction === 'string'
          ) {
            out.push({
              agent_id: row.id,
              agent_role: row.role,
              skill: skill as SkillRow['skill'],
            });
          }
        }
      }
      return out;
    },
  );
}

function sampleIntraAgentPairs(skills: SkillRow[]): Array<[SkillRow, SkillRow]> {
  // Group by agent, take all C(n,2) within the agent up to a per-agent cap.
  const byAgent = new Map<string, SkillRow[]>();
  for (const s of skills) {
    const arr = byAgent.get(s.agent_id) ?? [];
    arr.push(s);
    byAgent.set(s.agent_id, arr);
  }
  const pairs: Array<[SkillRow, SkillRow]> = [];
  for (const group of byAgent.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        pairs.push([group[i], group[j]]);
        if (pairs.length >= MAX_INTRA_AGENT_PAIRS) return pairs;
      }
    }
  }
  return pairs;
}

function sampleCrossAgentPairs(skills: SkillRow[]): Array<[SkillRow, SkillRow]> {
  // Within each role, take random pairs (agent_a != agent_b) up to a cap.
  const byRole = new Map<string, SkillRow[]>();
  for (const s of skills) {
    const arr = byRole.get(s.agent_role) ?? [];
    arr.push(s);
    byRole.set(s.agent_role, arr);
  }
  const pairs: Array<[SkillRow, SkillRow]> = [];
  for (const group of byRole.values()) {
    if (group.length < 2) continue;
    // Random sample without replacement of unordered pairs.
    const seen = new Set<string>();
    const maxTries = Math.min(group.length * 5, 200);
    for (let attempt = 0; attempt < maxTries && pairs.length < MAX_CROSS_AGENT_PAIRS; attempt++) {
      const i = Math.floor(Math.random() * group.length);
      const j = Math.floor(Math.random() * group.length);
      if (i === j) continue;
      const a = group[i];
      const b = group[j];
      if (a.agent_id === b.agent_id) continue;
      const key = a.skill.id < b.skill.id ? `${a.skill.id}|${b.skill.id}` : `${b.skill.id}|${a.skill.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push([a, b]);
    }
  }
  return pairs;
}

async function embedUniqueSkills(skills: SkillRow[]): Promise<Map<string, number[]>> {
  const byId = new Map<string, SkillRow>();
  for (const s of skills) byId.set(s.skill.id, s);
  const ids = Array.from(byId.keys());
  const vectors = new Map<string, number[]>();
  // Google's per-call cap is 250 inputs; chunk accordingly.
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const inputs = slice.map(id => skillText(byId.get(id)!.skill));
    const response = await embeddingClient.embed({
      provider: EMBED_PROVIDER,
      input: inputs,
      dimensions: EMBED_DIMENSIONS,
      taskType: 'retrieval_document',
      context: { purpose: 'skill_dedup_calibration' },
    });
    for (let k = 0; k < slice.length; k++) {
      vectors.set(slice[k], response.embeddings[k]);
    }
  }
  return vectors;
}

function pairsToCsv(rows: PairRow[], labels?: Map<string, Label>): string {
  const header = 'pair_id,agent_a,skill_a_name,skill_a_text,agent_b,skill_b_name,skill_b_text,cosine,label\n';
  const lines = rows.map(r => [
    r.pair_id,
    r.agent_a,
    escapeCsv(r.skill_a_name),
    escapeCsv(r.skill_a_text),
    r.agent_b,
    escapeCsv(r.skill_b_name),
    escapeCsv(r.skill_b_text),
    r.cosine.toFixed(6),
    labels?.get(r.pair_id) ?? '',
  ].join(','));
  return header + lines.join('\n') + '\n';
}

// LLM-as-labeler — optional path. Sequentially classifies each pair via
// llmClient with a forced-tool structured output. Returns null on failure
// so the caller can fall back to operator-only labeling.
type Label = 'duplicate' | 'related' | 'distinct';

const LABEL_RESPONSE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    label: { type: 'string', enum: ['duplicate', 'related', 'distinct'] },
    reasoning: { type: 'string', maxLength: 200 },
  },
  required: ['label'],
};

const LABEL_SYSTEM = `You classify pairs of AI-agent skills by semantic relationship. Each skill has a description and an instruction.

Labels:
- "duplicate" — the two skills say substantially the same thing. Only one should exist in the library.
- "related" — overlapping topic but each contributes distinct actionable guidance the other lacks. Both should exist.
- "distinct" — different concerns; the skills do not overlap meaningfully.

Be strict on "duplicate": if either skill carries a specific condition, example, or caveat the other lacks, the correct label is "related", not "duplicate".

Emit the label via emit_label.`;

async function llmLabelPair(row: PairRow): Promise<Label | null> {
  const userMsg = `Skill A:\nDESCRIPTION: ${row.skill_a_text}\n\nSkill B:\nDESCRIPTION: ${row.skill_b_text}\n\nEmit the label via emit_label.`;
  try {
    const response = await llmClient.complete(
      {
        messages: [
          { role: 'system', content: LABEL_SYSTEM },
          { role: 'user', content: userMsg },
        ],
        tier: 'medium',
        maxTokens: 256,
        temperature: 0.0,
        responseSchema: {
          name: 'emit_label',
          description: 'Emit the semantic-relationship label for the pair.',
          schema: LABEL_RESPONSE_SCHEMA,
        },
      },
      undefined,
      { purpose: 'skill_dedup_calibration' },
    );
    const toolCall = response.toolCalls?.[0];
    if (!toolCall || toolCall.name !== 'emit_label') return null;
    const label = (toolCall.input as { label?: unknown }).label;
    if (label === 'duplicate' || label === 'related' || label === 'distinct') return label;
    return null;
  } catch (err) {
    console.warn(`  LLM label failed for ${row.pair_id}: ${(err as Error).message}`);
    return null;
  }
}

async function llmLabelAllPairs(rows: PairRow[]): Promise<Map<string, Label>> {
  const labels = new Map<string, Label>();
  let n = 0;
  for (const row of rows) {
    const label = await llmLabelPair(row);
    if (label) labels.set(row.pair_id, label);
    n += 1;
    if (n % 25 === 0) {
      console.log(`  labeled ${n}/${rows.length} (${labels.size} successful)`);
    }
  }
  return labels;
}

async function uploadToGcs(bucket: string, objectPath: string, body: string): Promise<string> {
  const storage = new Storage();
  const file = storage.bucket(bucket).file(objectPath);
  await file.save(body, { contentType: 'text/csv', resumable: false });
  return `gs://${bucket}/${objectPath}`;
}

export async function runCalibration(): Promise<void> {
  const pairCap = parseInt(process.env.PAIR_CAP ?? String(DEFAULT_PAIR_CAP), 10);
  const bucket = process.env.CALIBRATION_GCS_BUCKET;
  const useLlmLabeler = process.env.USE_LLM_LABELER === 'true';
  if (!bucket) throw new Error('CALIBRATION_GCS_BUCKET env var is required');

  console.log('Initializing DB + embedding client...');
  await initDatabase();
  await initEmbeddingClient();
  if (useLlmLabeler) {
    // Usage tracking is set up so LLM-as-labeler calls land in llm_usage_log
    // for cost visibility. Purpose 'skill_dedup_calibration' is unknown to
    // purposeToGroup → falls through to the 'agent-execution' Anthropic API
    // key group. Fine for a one-off calibration run; no tenant attribution
    // because this is a cross-tenant platform operation.
    initLLMUsageTracking();
  }

  console.log('Loading skills from internal_agents...');
  const skills = await loadAllSkills();
  console.log(`  loaded ${skills.length} skills across agents`);

  console.log('Generating candidate pairs...');
  const intra = sampleIntraAgentPairs(skills);
  const cross = sampleCrossAgentPairs(skills);
  const allPairs = [...intra, ...cross].slice(0, pairCap);
  console.log(`  intra-agent: ${intra.length}, cross-agent: ${cross.length}, total: ${allPairs.length}`);

  if (allPairs.length === 0) {
    console.error('No pairs generated — too few skills or all unique-agents. Aborting.');
    process.exit(1);
  }

  console.log('Embedding skills...');
  const vectors = await embedUniqueSkills(skills);
  console.log(`  embedded ${vectors.size} unique skills`);

  console.log('Computing pairwise cosines...');
  const rows: PairRow[] = [];
  for (let i = 0; i < allPairs.length; i++) {
    const [a, b] = allPairs[i];
    const va = vectors.get(a.skill.id);
    const vb = vectors.get(b.skill.id);
    if (!va || !vb) continue;
    rows.push({
      pair_id: `pair-${i}`,
      agent_a: a.agent_id,
      skill_a_name: a.skill.name,
      skill_a_text: skillText(a.skill),
      agent_b: b.agent_id,
      skill_b_name: b.skill.name,
      skill_b_text: skillText(b.skill),
      cosine: cosine(va, vb),
    });
  }
  rows.sort((a, b) => b.cosine - a.cosine);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  let labels: Map<string, Label> | undefined;
  if (useLlmLabeler) {
    console.log(`Labeling ${rows.length} pairs with LLM-as-labeler...`);
    labels = await llmLabelAllPairs(rows);
    console.log(`  labeled ${labels.size}/${rows.length} successfully`);
  }

  const unlabeledPath = `skill-dedup/${ts}/skill-pairs-to-label.csv`;
  const unlabeledCsv = pairsToCsv(rows);
  const unlabeledUrl = await uploadToGcs(bucket, unlabeledPath, unlabeledCsv);
  console.log(`Uploaded unlabeled pairs to ${unlabeledUrl}`);

  if (labels && labels.size > 0) {
    const labeledPath = `skill-dedup/${ts}/skill-pairs-labeled.csv`;
    const labeledCsv = pairsToCsv(rows, labels);
    const labeledUrl = await uploadToGcs(bucket, labeledPath, labeledCsv);
    console.log(`Uploaded LLM-labeled pairs to ${labeledUrl}`);
    console.log('');
    console.log('Next steps (LLM-as-labeler path):');
    console.log(`  1. Download ${labeledUrl}`);
    console.log('  2. Spot-check ~30 LLM labels. If disagreement rate > 10%, fall back to manual labeling.');
    console.log(`  3. Run pick-skill-dedup-thresholds.ts with LABELED_CSV_GCS_URI=${labeledUrl}.`);
    return;
  }

  console.log('');
  console.log('Next steps:');
  console.log(`  1. Download the CSV from ${unlabeledUrl}`);
  console.log('  2. Label ~150 pairs in the `label` column (duplicate / related / distinct).');
  console.log(`  3. Upload as gs://${bucket}/skill-dedup/${ts}/skill-pairs-labeled.csv`);
  console.log('  4. Run pick-skill-dedup-thresholds.ts against that path.');
}

if (require.main === module) {
  runCalibration().then(() => process.exit(0)).catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
