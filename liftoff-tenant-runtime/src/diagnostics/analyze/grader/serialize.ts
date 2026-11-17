// Grader input assembly. Downloads admitted artifact files with hard per-file
// and aggregate character budgets so the 25 MB capture cap can never become a
// 25 MB LLM prompt. Downloads are stream-based with an idle deadline (the
// installed Storage package has no `timeout` option on File downloads) and are
// destroyed once the per-file cap is reached.

import { Storage } from '@google-cloud/storage';
import type { CanonicalTrajectory } from '../../../trajectories/types';
import { objective, finalAssistantText } from '../trajectory-util';
import { logger } from '../../../infrastructure/logging';

const MSG_TEXT_CAP = 16_000;
const FINAL_ANSWER_CAP = 8_000;
const PER_FILE_CHAR_CAP = 6_000;
const AGGREGATE_CHAR_CAP = 24_000;
const READ_IDLE_MS = 2_000;

function bucketName(): string {
  return `trajectories-${process.env.ENVIRONMENT ?? 'dev'}`;
}

interface ManifestFile { path: string; bytes: number; contentType: string }

/** GET the known-path manifest and return admitted artifact URIs. Never lists.
 *  404/403 (no manifest / no read access on a non-eval tenant) → []. Only URIs
 *  under the exact tenant/invocation prefix are returned. */
export async function readManifestUris(tenantId: string, invocationId: string): Promise<string[]> {
  const prefix = `${tenantId}/artifacts/${invocationId}`;
  try {
    const [buf] = await new Storage().bucket(bucketName()).file(`${prefix}/manifest.json`).download();
    const parsed = JSON.parse(buf.toString('utf8')) as { files?: ManifestFile[] };
    const files = Array.isArray(parsed.files) ? parsed.files : [];
    const uris: string[] = [];
    for (const f of files) {
      if (typeof f?.path !== 'string' || f.path.includes('..')) continue;
      const uri = `gs://${bucketName()}/${prefix}/${f.path}`;
      // Defence in depth: the constructed URI must sit under the exact prefix.
      if (!uri.startsWith(`gs://${bucketName()}/${prefix}/`)) continue;
      uris.push(uri);
    }
    return uris;
  } catch (err) {
    logger.debug({ tenantId, invocationId, err: (err as Error).message }, 'grader: manifest unavailable; no artifacts');
    return [];
  }
}

/** Download up to `cap` chars from a gs:// object via a bounded read stream. */
function downloadCapped(uri: string, cap: number): Promise<{ text: string; ok: boolean }> {
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!m) return Promise.resolve({ text: '', ok: false });
  const file = new Storage().bucket(m[1]).file(m[2]);
  return new Promise((resolve) => {
    let text = '';
    let done = false;
    const stream = file.createReadStream();
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(idle);
      try { stream.destroy(); } catch { /* noop */ }
      resolve({ text, ok });
    };
    const idle = setTimeout(() => finish(false), READ_IDLE_MS);
    stream.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
      if (text.length >= cap) { text = text.slice(0, cap); finish(true); }
    });
    stream.on('end', () => finish(true));
    stream.on('error', () => finish(false));
  });
}

/** True when the buffer decodes as valid UTF-8 (the text allowlist should make
 *  this near-always true; a failed decode drops the file). */
function isValidUtf8(s: string): boolean {
  return !s.includes('�');
}

export interface SerializedGraderInput {
  text: string;
  artifactsPresent: boolean;
}

export async function serializeForGrading(
  traj: CanonicalTrajectory,
  artifactUris: string[],
  /** Multiplies every char budget. Agentic grading passes >1 so the judge sees
   *  more of the deliverable (it can also read the rest via the sandbox). */
  budgetScale = 1,
): Promise<SerializedGraderInput> {
  const msgCap = MSG_TEXT_CAP * budgetScale;
  const finalCap = FINAL_ANSWER_CAP * budgetScale;
  const perFileCap = PER_FILE_CHAR_CAP * budgetScale;
  const aggCap = AGGREGATE_CHAR_CAP * budgetScale;
  const parts: string[] = [`OBJECTIVE: ${objective(traj)}`];

  const convo: string[] = [];
  for (const m of traj.messages) {
    const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
    if (text) convo.push(`${m.role.toUpperCase()}: ${text}`);
  }
  let convoText = convo.join('\n');
  if (convoText.length > msgCap) convoText = convoText.slice(convoText.length - msgCap);
  parts.push(`CONVERSATION:\n${convoText}`);
  parts.push(`FINAL ANSWER:\n${finalAssistantText(traj).slice(0, finalCap)}`);

  let admitted = 0;
  let aggregate = 0;
  const artifactParts: string[] = [];
  for (const uri of artifactUris) {
    const name = uri.split('/').pop() ?? uri;
    if (aggregate >= aggCap) {
      artifactParts.push(`[truncated: budget] ${name}`);
      continue;
    }
    const remaining = aggCap - aggregate;
    const { text, ok } = await downloadCapped(uri, Math.min(perFileCap, remaining));
    if (!ok || !isValidUtf8(text)) {
      artifactParts.push(`[artifact unavailable: ${name}]`);
      continue;
    }
    admitted++;
    aggregate += text.length;
    artifactParts.push(`--- ARTIFACT ${name} ---\n${text}`);
  }
  if (artifactParts.length > 0) parts.push(`DELIVERABLES:\n${artifactParts.join('\n\n')}`);

  return { text: parts.join('\n\n'), artifactsPresent: admitted > 0 };
}
