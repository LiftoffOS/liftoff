// Discarding bytes nobody published.
//
// A staged file is one that was written and never shown: what a custom API
// answered with, what a producer put down while deciding whether it mattered.
// It is attributed and reachable, and it is not an artifact, so it carries a
// lifetime (`generated_files.discard_after`). Presenting the file clears that
// column, which is the whole point — publishing is what makes a file
// permanent, so this only ever removes files that were never put in front of
// anyone.
//
// Deliberately NOT the same sweep as the one beside it in media/inbound.ts.
// That one removes a PERSON's upload that no message ever claimed, keyed on
// `claimed_at` and bounded to rows with an uploader. This one removes a
// PRODUCER's staged bytes, keyed on a lifetime the producer itself asked for.
// The two never see each other's rows, and merging them would mean one
// predicate that is true for two different reasons.

import { withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { generatedFilesBucket } from './gcs-client';

/**
 * Delete staged files whose lifetime has run out.
 *
 * Cross-tenant by construction, like every retention sweep: it runs on a
 * schedule with no tenant in scope.
 *
 * The ROW goes first, under the same predicate the select used, and the object
 * is deleted only if that removed something. Ordering it the other way loses a
 * race that this sweep uniquely has: a file presented between the select and
 * the delete has had its lifetime cleared and must survive, and deleting its
 * bytes first would leave a person holding a card for a file that no longer
 * exists. An object left behind by a failure here is a storage leak; bytes
 * taken out from under a published card is a broken promise.
 */
export async function sweepStagedFiles(
  options: { limit?: number } = {},
): Promise<{ deleted: number; failed: number }> {
  const limit = options.limit ?? 500;

  const expired = await withAdminScope(
    {
      caller: 'generated-files.sweepStagedFiles',
      reason: 'retention sweep of staged files nobody published, across tenants',
    },
    (client) =>
      client.query(
        `SELECT id, tenant_id, gcs_path
           FROM generated_files
          WHERE discard_after IS NOT NULL
            AND discard_after < NOW()
          ORDER BY discard_after
          LIMIT $1`,
        [limit],
      ),
  );

  let deleted = 0;
  let failed = 0;
  for (const row of expired.rows as Array<{ id: string; tenant_id: string; gcs_path: string | null }>) {
    try {
      const removed = await withAdminScope(
        {
          caller: 'generated-files.sweepStagedFiles',
          reason: 'delete one staged file past its lifetime',
        },
        (client) =>
          // The predicate is repeated rather than trusting the id from the
          // select: a file presented in between has had its lifetime cleared,
          // and this then removes nothing.
          client.query(
            `DELETE FROM generated_files
              WHERE id = $1 AND discard_after IS NOT NULL AND discard_after < NOW()`,
            [row.id],
          ),
      );
      if (removed.rowCount === 0) continue; // presented in the meantime; it stays.

      if (row.gcs_path) {
        await generatedFilesBucket().file(row.gcs_path).delete({ ignoreNotFound: true });
      }
      deleted += 1;
    } catch (err) {
      // One unreachable object must not stop the pass.
      failed += 1;
      // ERROR, and a named event, because of where this can land. The row is
      // deleted before the bytes on purpose — the other order can strip a file
      // somebody was just shown — so a failure AFTER the row is gone leaves an
      // object nothing points at and no later run can find. That is a storage
      // leak rather than anything a person sees, and this line is the only
      // record of it, so it is worth alerting on rather than burying at warn.
      log.error(
        {
          error: (err as Error).message,
          generatedFileId: row.id,
          tenantId: row.tenant_id,
          gcsPath: row.gcs_path,
          event: 'staged_file_object_orphaned',
        },
        'generated-files: staged file row deleted but its object was not',
      );
    }
  }

  if (deleted > 0 || failed > 0) {
    log.info({ deleted, failed }, 'generated-files: swept staged files');
  }
  return { deleted, failed };
}
