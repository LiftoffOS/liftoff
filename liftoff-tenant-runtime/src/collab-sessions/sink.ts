// Create-only GCS NDJSON writer for collab-session rows.
//
// The runtime SA holds storage.objectCreator (write-only) on the trajectory
// bucket — it cannot overwrite or delete. Writes therefore use
// ifGenerationMatch: 0 and treat a 412 (object already exists, from a previous
// attempt of the same deterministic key) as success. The diagnostics external
// BigQuery tables read these NDJSON objects directly.

import { Storage } from '@google-cloud/storage';
import type { CollabSessionRow, CancelState } from './emit';

const GCS_IDLE_DEADLINE_MS = 2_000;

function bucketName(): string {
  return `trajectories-${process.env.ENVIRONMENT ?? 'dev'}`;
}

/** Write one NDJSON object at diagnostics/collab_sessions/<objectKey>.ndjson.
 *  Stream-based so an in-flight write can be destroyed on abort. Create-only:
 *  412 (precondition failed / already exists) resolves as success. */
export async function sinkCollabSessions(
  rows: CollabSessionRow[],
  objectKey: string,
  cancel?: CancelState,
): Promise<void> {
  if (rows.length === 0) return;
  if (cancel?.aborted) return;
  const payload = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const file = new Storage()
    .bucket(bucketName())
    .file(`diagnostics/collab_sessions/${objectKey}.ndjson`);

  await new Promise<void>((resolve, reject) => {
    const stream = file.createWriteStream({
      resumable: false,
      contentType: 'application/x-ndjson',
      preconditionOpts: { ifGenerationMatch: 0 },
    });
    const idle = setTimeout(() => stream.destroy(new Error('gcs_write_idle_timeout')), GCS_IDLE_DEADLINE_MS);
    cancel?.inflight.add(stream);
    const done = (err?: Error) => {
      clearTimeout(idle);
      cancel?.inflight.delete(stream);
      // 412 = the object already exists (a prior attempt wrote it). Idempotent.
      if (err && (err as { code?: number }).code === 412) return resolve();
      if (err) return reject(err);
      resolve();
    };
    stream.on('error', done);
    stream.on('finish', () => done());
    stream.end(payload);
  }).catch((err) => {
    if ((err as { code?: number }).code === 412) return;
    throw err;
  });
}
