// Files that belong to a skill.
//
// The caps are the interesting part and they are not arbitrary: they were
// calibrated against 160 real skills, and what sits past them is a vendored
// repository rather than a skill. The other property under test is that a
// refusal is REPORTED — a file that vanishes silently leaves a skill describing
// a script that is not there.

import {
  MAX_BUNDLE_FILES,
  MAX_BUNDLE_FILE_BYTES,
  MAX_BUNDLE_TOTAL_BYTES,
  bundleObjectPath,
  isSafeBundlePath,
  sha256Of,
  storeSkillBundle,
} from '../skill-bundle';

const saveMock = jest.fn();
const existsMock = jest.fn();
const fileMock = jest.fn(() => ({ save: saveMock, exists: existsMock }));

jest.mock('../../generated-files/gcs-client', () => ({
  generatedFilesBucket: () => ({ file: fileMock }),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const TENANT = 'tenant-1';
const SKILL = 'skill-1';

beforeEach(() => {
  jest.clearAllMocks();
  existsMock.mockResolvedValue([false]);
  saveMock.mockResolvedValue(undefined);
});

describe('path safety', () => {
  it('accepts a relative path inside the skill', () => {
    expect(isSafeBundlePath('scripts/run.py')).toBe(true);
    expect(isSafeBundlePath('references/api.md')).toBe(true);
  });

  it('refuses anything that would escape the skill directory', () => {
    // These are joined onto a sandbox directory, so an escape here is an
    // escape there.
    expect(isSafeBundlePath('../../etc/passwd')).toBe(false);
    expect(isSafeBundlePath('/etc/passwd')).toBe(false);
    expect(isSafeBundlePath('C:/windows/system32')).toBe(false);
    expect(isSafeBundlePath('scripts/../../out.py')).toBe(false);
    expect(isSafeBundlePath('scripts\\run.py')).toBe(false);
    expect(isSafeBundlePath('')).toBe(false);
  });
});

describe('storeSkillBundle', () => {
  it('stores a file under its own digest and returns the pointer', async () => {
    const text = '#!/usr/bin/env python\nprint("hi")\n';
    const result = await storeSkillBundle(TENANT, SKILL, [
      { path: 'scripts/run.py', text, executable: true },
    ]);

    const sha = sha256Of(text);
    expect(result.bundle?.files).toEqual([
      {
        path: 'scripts/run.py',
        bytes: Buffer.byteLength(text, 'utf8'),
        sha256: sha,
        storageRef: bundleObjectPath(TENANT, SKILL, sha),
        executable: true,
      },
    ]);
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it('does not re-upload content the bucket already holds', async () => {
    // The digest IS the object name, so existence is equality.
    existsMock.mockResolvedValue([true]);

    const result = await storeSkillBundle(TENANT, SKILL, [
      { path: 'references/a.md', text: 'same' },
      { path: 'references/b.md', text: 'same' },
    ]);

    expect(result.bundle?.files).toHaveLength(2);
    expect(result.bundle?.files[0].storageRef).toBe(result.bundle?.files[1].storageRef);
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('reports an oversized file by name instead of dropping it', async () => {
    const result = await storeSkillBundle(TENANT, SKILL, [
      { path: 'ok.md', text: 'small' },
      { path: 'huge.md', text: 'x'.repeat(MAX_BUNDLE_FILE_BYTES + 1) },
    ]);

    expect(result.bundle?.files.map((f) => f.path)).toEqual(['ok.md']);
    expect(result.rejected).toEqual([{ path: 'huge.md', reason: 'file_too_large' }]);
  });

  it('stops at the file-count cap and names what it refused', async () => {
    const files = Array.from({ length: MAX_BUNDLE_FILES + 2 }, (_, i) => ({
      path: `references/f${i}.md`,
      text: `file ${i}`,
    }));

    const result = await storeSkillBundle(TENANT, SKILL, files);

    expect(result.bundle?.files).toHaveLength(MAX_BUNDLE_FILES);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected.every((r) => r.reason === 'too_many_files')).toBe(true);
  });

  it('stops at the total-size cap', async () => {
    // Each file is under the per-file cap; together they are not.
    const chunk = 'y'.repeat(MAX_BUNDLE_FILE_BYTES);
    const count = Math.ceil(MAX_BUNDLE_TOTAL_BYTES / MAX_BUNDLE_FILE_BYTES) + 1;
    const files = Array.from({ length: count }, (_, i) => ({
      path: `references/f${i}.md`,
      text: `${chunk}${i}`.slice(0, MAX_BUNDLE_FILE_BYTES),
    }));

    const result = await storeSkillBundle(TENANT, SKILL, files);

    const stored = result.bundle?.files ?? [];
    const total = stored.reduce((sum, f) => sum + f.bytes, 0);
    expect(total).toBeLessThanOrEqual(MAX_BUNDLE_TOTAL_BYTES);
    expect(result.rejected.some((r) => r.reason === 'bundle_too_large')).toBe(true);
  });

  it('refuses an unsafe path without touching storage', async () => {
    const result = await storeSkillBundle(TENANT, SKILL, [
      { path: '../escape.md', text: 'nope' },
    ]);

    expect(result.bundle).toBeNull();
    expect(result.rejected).toEqual([{ path: '../escape.md', reason: 'unsafe_path' }]);
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('keeps the rest of the skill when one file cannot be stored', async () => {
    saveMock.mockRejectedValueOnce(new Error('bucket unavailable'));

    const result = await storeSkillBundle(TENANT, SKILL, [
      { path: 'a.md', text: 'first' },
      { path: 'b.md', text: 'second' },
    ]);

    expect(result.bundle?.files.map((f) => f.path)).toEqual(['b.md']);
    expect(result.rejected).toEqual([{ path: 'a.md', reason: 'storage_failed' }]);
  });

  it('returns no bundle at all when nothing could be stored', async () => {
    const result = await storeSkillBundle(TENANT, SKILL, []);
    expect(result.bundle).toBeNull();
  });
});
