// The file picker is a tree, so a Drive listing must carry files AND folders.
//
// Two separate bugs converged on the same symptom here, and both were invisible
// to every other test:
//
//   1. A mimeType filter of document types excluded folders from the query, so
//      the tree had nothing to expand and only the current level was reachable.
//   2. Defaulting the browse entityType to 'folder' inverted it: Drive reads
//      'folder' as a mimeType filter, so the picker listed folders and not one
//      selectable file.
//
// The picker must let someone tick an individual file or take a whole folder.
// That requires both kinds in one response, which is what these assert.

import { GoogleDriveClient } from '../google-drive.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Capture the `q` Drive was asked for, without performing a request. */
function clientCapturing(captured: { q?: string }) {
  const client = new GoogleDriveClient(async () => ({ accessToken: 'test-token' }));
  // listFiles owns query assembly; stubbing it keeps this about what list()
  // ASKS for, which is where both defects lived.
  (client as unknown as {
    listFiles: (o: Record<string, unknown>) => Promise<unknown>;
  }).listFiles = async (options: Record<string, unknown>) => {
    captured.q = options.query as string | undefined;
    return { files: [] };
  };
  return client;
}

describe('GoogleDriveClient.list — the picker needs files and folders', () => {
  it('includes folders when filtering to document types', async () => {
    const captured: { q?: string } = {};
    await clientCapturing(captured).list('file', {
      mimeTypes: ['application/pdf', 'text/plain'],
    } as never);

    expect(captured.q).toContain('application/pdf');
    // The regression: without this the tree cannot expand.
    expect(captured.q).toContain(FOLDER_MIME);
  });

  it('does not filter at all when no mimeTypes are given', async () => {
    const captured: { q?: string } = {};
    await clientCapturing(captured).list('file', {} as never);

    // No query means Drive returns everything in scope, folders included.
    expect(captured.q).toBeUndefined();
  });

  it('restricts to folders only when folders are explicitly asked for', async () => {
    // Still needed: a destination picker wants somewhere to write, not a file
    // to overwrite. The bug was making this the DEFAULT, not offering it.
    const captured: { q?: string } = {};
    await clientCapturing(captured).list('folder', {} as never);

    expect(captured.q).toBe(`mimeType = '${FOLDER_MIME}'`);
  });

  it('reports an entity it cannot enumerate rather than returning empty', async () => {
    const result = await clientCapturing({}).list('spreadsheet', {} as never);
    expect(result.unsupported).toBe(true);
  });
});
