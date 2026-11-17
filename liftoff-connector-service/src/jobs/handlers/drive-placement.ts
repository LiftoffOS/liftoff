import { logger } from '../../infra/logging.js';

/**
 * Move a finished Drive file into the caller's folder.
 *
 * Both the Docs and the Slides creation APIs leave the new file wherever Drive
 * puts it — a blank file in My Drive root, a copy beside its template — and
 * neither takes a parent at creation. So the folder the person asked for is
 * applied as one `addParents` move once the file is complete.
 *
 * Non-fatal by design: a document that exists in the wrong folder is one the
 * person can find and move; a document deleted because its move failed is
 * not. The warning names the folder, so the failure is diagnosable from the
 * log alone.
 */
export async function placeInDriveFolder(
  gFetch: (url: string, init?: RequestInit) => Promise<globalThis.Response>,
  fileId: string,
  parentFolderId: string | undefined,
  what: 'document' | 'presentation',
): Promise<void> {
  if (!parentFolderId) return;
  try {
    const resp = await gFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?addParents=${encodeURIComponent(parentFolderId)}&fields=id,parents`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
    );
    if (!resp.ok) {
      logger.warn({ fileId, parentFolderId, status: resp.status }, `${what} created but not moved into the requested folder`);
    }
  } catch (err) {
    logger.warn({ err, fileId, parentFolderId }, `${what} created but the folder move threw`);
  }
}
