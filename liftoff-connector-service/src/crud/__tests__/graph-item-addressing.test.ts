// Addressing for Microsoft 365 driveItems.
//
// A Graph driveItem id is unique only WITHIN its drive. list_files and
// read_document are separate calls with no shared state, so the id string is
// the entire channel between them — if the drive does not travel inside it,
// the only drive left to guess is /me/drive, the caller's personal OneDrive.
//
// That guess is what made SharePoint documents unreachable: the lookup was
// well-formed and simply pointed at the wrong drive, so Graph answered 404 and
// the agent reported "file not found" for a file that plainly existed.

import { resolveGraphItemTarget } from '../router';

const ok = (r: ReturnType<typeof resolveGraphItemTarget>) => {
  if ('error' in r) throw new Error(`expected a target, got error: ${r.error}`);
  return r;
};

describe('resolveGraphItemTarget', () => {
  describe('drive-qualified ids (what list_files emits)', () => {
    it('splits <driveId>|<itemId> and addresses the item in ITS drive', () => {
      const r = ok(resolveGraphItemTarget({
        connectorType: 'microsoft_sharepoint',
        fileId: 'b!AbC-dEf_123|01ABCDEFGHIJKLMNOP',
      }));
      expect(r.itemPath).toBe('/drives/b!AbC-dEf_123/items/01ABCDEFGHIJKLMNOP');
      expect(r.itemId).toBe('01ABCDEFGHIJKLMNOP');
    });

    it('wins over an explicit driveId — the id describes itself', () => {
      const r = ok(resolveGraphItemTarget({
        connectorType: 'microsoft_sharepoint',
        fileId: 'b!real|item1',
        driveId: 'b!other',
      }));
      expect(r.itemPath).toContain('/drives/b!real/');
      expect(r.itemPath).not.toContain('b!other');
    });

    it('rejects a trailing separator rather than addressing an empty item', () => {
      const r = resolveGraphItemTarget({ connectorType: 'microsoft_sharepoint', fileId: 'b!drive|' });
      expect('error' in r && r.error).toMatch(/Malformed/);
    });

    it('does not treat a leading separator as drive-qualified', () => {
      // '|item' has sepAt === 0, which is not a drive id.
      const r = resolveGraphItemTarget({ connectorType: 'microsoft_onedrive', fileId: '|item' });
      expect(ok(r).itemPath).toBe('/me/drive/items/%7Citem');
    });
  });

  describe('explicit scoping params', () => {
    it('uses driveId when the id is bare', () => {
      const r = ok(resolveGraphItemTarget({
        connectorType: 'microsoft_sharepoint', fileId: 'item1', driveId: 'b!lib',
      }));
      expect(r.itemPath).toBe('/drives/b!lib/items/item1');
    });

    it('uses siteId via the site default drive', () => {
      const r = ok(resolveGraphItemTarget({
        connectorType: 'microsoft_sharepoint', fileId: 'item1', siteId: 'contoso.sharepoint.com,guid1,guid2',
      }));
      expect(r.itemPath).toBe('/sites/contoso.sharepoint.com%2Cguid1%2Cguid2/drive/items/item1');
    });

    it('prefers driveId over siteId when both are given', () => {
      const r = ok(resolveGraphItemTarget({
        connectorType: 'microsoft_sharepoint', fileId: 'i', driveId: 'b!d', siteId: 's',
      }));
      expect(r.itemPath).toContain('/drives/b!d/');
    });
  });

  describe('defaults', () => {
    it('OneDrive with a bare id falls back to /me/drive, which is correct there', () => {
      const r = ok(resolveGraphItemTarget({ connectorType: 'microsoft_onedrive', fileId: '01ITEM' }));
      expect(r.itemPath).toBe('/me/drive/items/01ITEM');
    });

    // The regression this whole change exists for.
    it('SharePoint with NO drive context is refused, not sent to the personal OneDrive', () => {
      const r = resolveGraphItemTarget({ connectorType: 'microsoft_sharepoint', fileId: '01ITEM' });
      expect('error' in r).toBe(true);
      if (!('error' in r)) throw new Error('unreachable');
      expect(r.error).toMatch(/needs its drive/);
      // The failure has to name the cause. A bare 404 from /me/drive reads as
      // "no such file", which is what hid this for as long as it did.
      expect(r.error).toMatch(/personal OneDrive/);
      expect(JSON.stringify(r)).not.toContain('/me/drive/items');
    });
  });

  it('percent-encodes ids so a Graph path cannot be broken out of', () => {
    const r = ok(resolveGraphItemTarget({
      connectorType: 'microsoft_onedrive', fileId: 'a/../../b?x=1',
    }));
    expect(r.itemPath).toBe('/me/drive/items/a%2F..%2F..%2Fb%3Fx%3D1');
    expect(r.itemPath).not.toContain('?');
  });
});
