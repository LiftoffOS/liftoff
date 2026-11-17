// A storage listing must carry files AND folders, or the picker cannot move.
//
// The knowledge picker and the destination picker are both trees: they split
// one response into folders to open and files to tick. Four clients narrowed
// that response to files alone, each in its own way, so the tree had nothing to
// expand and only whatever sat at the current level was ever reachable:
//
//   google-drive  a mimeType filter of document types excluded the folder mime
//   google-docs   'file' fell through to the folder-only branch, so documents
//                 were the ones missing
//   dropbox       filtered entries to .tag === 'file'
//   box           filtered entries to type === 'file'
//
// microsoft-onedrive was already correct: it returns the drive's children
// unfiltered. That is the behaviour the others now match.
//
// 'folder' still narrows to folders, because a destination pick asks where
// output goes rather than which file to overwrite. Both directions are asserted
// so a future "simplification" cannot collapse them again.

import { DropboxClient } from '../dropbox.js';
import { BoxClient } from '../box.js';
import { GoogleDocsClient } from '../google-docs.js';

const creds = async () => ({ accessToken: 'test-token' });

describe('Dropbox listing', () => {
  function clientReturning(entries: Array<Record<string, unknown>>) {
    const c = new DropboxClient(creds);
    (c as unknown as { listFolder: (o: unknown) => Promise<unknown> }).listFolder =
      async () => ({ entries, has_more: false });
    return c;
  }

  const ENTRIES = [
    { '.tag': 'folder', id: 'f1', name: 'Reports' },
    { '.tag': 'file', id: 'd1', name: 'Q3.pdf' },
  ];

  it('returns folders alongside files', async () => {
    const res = await clientReturning(ENTRIES).list('file', {} as never);
    expect(res.records.map(r => r.id).sort()).toEqual(['d1', 'f1']);
  });

  it('narrows to folders when folders are asked for', async () => {
    const res = await clientReturning(ENTRIES).list('folder', {} as never);
    expect(res.records.map(r => r.id)).toEqual(['f1']);
  });
});

describe('Box listing', () => {
  function clientReturning(entries: Array<Record<string, unknown>>) {
    const c = new BoxClient(creds);
    (c as unknown as { listFolder: (o: unknown) => Promise<unknown> }).listFolder =
      async () => ({ entries, total_count: entries.length });
    return c;
  }

  const ENTRIES = [
    { type: 'folder', id: 'f1', name: 'Contracts' },
    { type: 'file', id: 'd1', name: 'MSA.pdf' },
  ];

  it('returns folders alongside files', async () => {
    const res = await clientReturning(ENTRIES).list('file', {} as never);
    expect(res.records.map(r => r.id).sort()).toEqual(['d1', 'f1']);
  });

  it('narrows to folders when folders are asked for', async () => {
    const res = await clientReturning(ENTRIES).list('folder', {} as never);
    expect(res.records.map(r => r.id)).toEqual(['f1']);
  });
});

describe('Google Docs listing', () => {
  /** Capture the Drive `q` this client asks for, without performing a request. */
  function clientCapturing(captured: { q?: string }) {
    const c = new GoogleDocsClient(creds);
    (c as unknown as {
      requestDrive: (p: string, q: Record<string, string>) => Promise<unknown>;
    }).requestDrive = async (_path, query) => {
      captured.q = query?.q;
      return { files: [] };
    };
    return c;
  }

  const DOC = 'application/vnd.google-apps.document';
  const FOLDER = 'application/vnd.google-apps.folder';

  it('asks for documents AND folders when files are requested', async () => {
    const captured: { q?: string } = {};
    await clientCapturing(captured).list('file', {} as never);
    expect(captured.q).toContain(DOC);
    expect(captured.q).toContain(FOLDER);
  });

  it('asks only for folders when folders are requested', async () => {
    const captured: { q?: string } = {};
    await clientCapturing(captured).list('folder', {} as never);
    expect(captured.q).toContain(FOLDER);
    expect(captured.q).not.toContain(DOC);
  });

  it('asks only for documents when documents are requested', async () => {
    const captured: { q?: string } = {};
    await clientCapturing(captured).list('document', {} as never);
    expect(captured.q).toContain(DOC);
    expect(captured.q).not.toContain(FOLDER);
  });
});
