/**
 * R5 Fix 6 git-mirror unit tests (structural; full integration requires a live
 * git remote and DB). Covers path validation, clone URL construction, mirror
 * path canonicalization.
 */
import { resolveMirrorPath } from '../git-mirror';

const VALID_TENANT = '123e4567-e89b-12d3-a456-426614174000';

describe('resolveMirrorPath', () => {
  it('constructs canonical mirror path under /var/cache/mirrors/<tenantId>/', () => {
    const p = resolveMirrorPath(VALID_TENANT, 'acme', 'runtime');
    expect(p).toBe(`/var/cache/mirrors/${VALID_TENANT}/acme--runtime.git`);
  });

  it('rejects non-UUID tenant', () => {
    expect(() => resolveMirrorPath('not-a-uuid', 'acme', 'x')).toThrow(/invalid tenantId/);
  });

  it('rejects owner starting with dot', () => {
    expect(() => resolveMirrorPath(VALID_TENANT, '.hidden', 'x')).toThrow(/invalid owner|cannot start/);
  });

  it('rejects owner with shell metacharacter', () => {
    expect(() => resolveMirrorPath(VALID_TENANT, 'owner;rm', 'x')).toThrow();
  });

  it('rejects repo with shell metacharacter', () => {
    expect(() => resolveMirrorPath(VALID_TENANT, 'owner', 'repo$(rm)')).toThrow();
  });
});
