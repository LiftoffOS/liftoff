// Reading stored media back out, for the code paths that need the BYTES.
//
// Everything else in this estate reads media through a signed URL: the browser
// gets one from the download route and fetches the object directly, which keeps
// the bytes out of this process entirely. A model cannot do that. The vendors
// take an image as base64 in the request body, and the objects are private with
// an hour-long signature, so handing a vendor a URL means either publishing the
// bucket or watching the call fail whenever the model fetches late.
//
// So this is the one place that pulls an object into memory, and it is bounded:
// only allow-listed image types, only within a tenant scope, only up to the
// per-turn ceiling the contract sets.

import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { generatedFilesBucket } from '../generated-files/gcs-client';

export interface StoredMediaBytes {
  mediaId: string;
  mimeType: string;
  bytes: Buffer;
}

/**
 * Fetch the bytes behind one media id, or null when there is nothing to fetch.
 *
 * Null covers every "no bytes" case on purpose — a wrong id, another tenant's
 * id, a row whose object was swept, a connector-native row that never had a GCS
 * object. The caller's response to all of them is the same: describe the media
 * in words instead of showing it. Distinguishing them would only offer a way to
 * probe which ids exist.
 *
 * RLS does the tenant isolation: the SELECT runs in tenant scope, so an id
 * belonging to somebody else matches zero rows rather than erroring.
 */
export async function readMediaBytes(
  tenantId: string,
  mediaId: string,
): Promise<StoredMediaBytes | null> {
  const result = await withTenantScope(tenantId, (client) =>
    client.query(
      `SELECT gcs_path, mime_type FROM generated_files WHERE id = $1 AND output_type = 'media'`,
      [mediaId],
    ),
  );
  const row = result.rows[0] as { gcs_path: string | null; mime_type: string | null } | undefined;
  if (!row?.gcs_path || !row.mime_type) return null;

  try {
    const [bytes] = await generatedFilesBucket().file(row.gcs_path).download();
    return { mediaId, mimeType: row.mime_type, bytes };
  } catch (err) {
    // A missing object is not an error the person can act on, and it must not
    // cost them their turn: the answer degrades to the text notice, which is
    // the same thing that happens for a video.
    log.warn(
      { error: (err as Error).message, mediaId, tenantId },
      'media: could not read stored object for a model turn',
    );
    return null;
  }
}
