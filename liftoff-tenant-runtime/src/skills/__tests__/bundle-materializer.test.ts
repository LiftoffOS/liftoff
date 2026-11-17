// Putting a skill's files where the agent can use them.
//
// The properties here are the ones whose absence is a specific failure: a file
// that is not what its pointer claims must be refused, a path that would escape
// the skill directory must be refused, and a file that could not be fetched
// must be REPORTED rather than quietly missing — a model told a script exists
// will call it.

import {
  SKILLS_MOUNT_ROOT,
  _clearBundleContentCache,
  describeMaterializedFiles,
  isSafeBundlePath,
  materializeSkillBundle,
  skillMountDir,
} from '../bundle-materializer';

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const SKILL = 'skill-1';

function file(path: string, sha256: string, extra: Record<string, unknown> = {}) {
  return { path, bytes: 10, sha256, storageRef: `skill-bundles/t/s/${sha256}`, ...extra };
}

beforeEach(() => _clearBundleContentCache());

describe('path safety', () => {
  it('refuses anything that would escape the skill directory', () => {
    expect(isSafeBundlePath('scripts/run.py')).toBe(true);
    expect(isSafeBundlePath('../../etc/passwd')).toBe(false);
    expect(isSafeBundlePath('/etc/passwd')).toBe(false);
    expect(isSafeBundlePath('a/../../b')).toBe(false);
  });
});

describe('materializeSkillBundle', () => {
  it('writes each file under the skill mount and reports where it went', async () => {
    const writes: Array<{ path: string; content: string; executable: boolean }> = [];
    const result = await materializeSkillBundle(
      SKILL,
      { files: [file('scripts/run.py', 'a'.repeat(64), { executable: true })] },
      {
        fetchContent: async () => 'print("hi")',
        writeFile: async (absolutePath, content, executable) => {
          writes.push({ path: absolutePath, content, executable });
        },
      },
    );

    expect(writes).toEqual([
      {
        path: `${SKILLS_MOUNT_ROOT}/${SKILL}/scripts/run.py`,
        content: 'print("hi")',
        executable: true,
      },
    ]);
    expect(result.files[0].absolutePath).toBe(skillMountDir(SKILL) + '/scripts/run.py');
    expect(result.failed).toEqual([]);
  });

  it('refuses a path that would escape, without fetching it', async () => {
    const fetchContent = jest.fn();
    const result = await materializeSkillBundle(
      SKILL,
      { files: [file('../escape.sh', 'b'.repeat(64))] },
      { fetchContent, writeFile: async () => {} },
    );

    expect(result.files).toEqual([]);
    expect(result.failed).toEqual([{ path: '../escape.sh', reason: 'unsafe_path' }]);
    expect(fetchContent).not.toHaveBeenCalled();
  });

  it('reports a file it could not fetch instead of pretending it landed', async () => {
    const result = await materializeSkillBundle(
      SKILL,
      { files: [file('scripts/run.py', 'c'.repeat(64))] },
      { fetchContent: async () => null, writeFile: async () => {} },
    );

    expect(result.files).toEqual([]);
    expect(result.failed).toEqual([{ path: 'scripts/run.py', reason: 'unavailable' }]);
  });

  it('keeps the files that did land when one fails', async () => {
    const result = await materializeSkillBundle(
      SKILL,
      {
        files: [
          file('a.md', 'd'.repeat(64)),
          file('b.md', 'e'.repeat(64)),
        ],
      },
      {
        fetchContent: async (_ref, sha) => (sha.startsWith('d') ? null : 'ok'),
        writeFile: async () => {},
      },
    );

    expect(result.files.map((f) => f.path)).toEqual(['b.md']);
    expect(result.failed.map((f) => f.path)).toEqual(['a.md']);
  });

  it('reports a write that fails rather than claiming the file is there', async () => {
    const result = await materializeSkillBundle(
      SKILL,
      { files: [file('a.md', 'f'.repeat(64))] },
      {
        fetchContent: async () => 'content',
        writeFile: async () => {
          throw new Error('sandbox gone');
        },
      },
    );

    expect(result.files).toEqual([]);
    expect(result.failed).toEqual([{ path: 'a.md', reason: 'unavailable' }]);
  });

  it('fetches shared content once, because the digest IS the content', async () => {
    const fetchContent = jest.fn().mockResolvedValue('shared');
    await materializeSkillBundle(
      SKILL,
      { files: [file('a.md', 'a'.repeat(64)), file('b.md', 'a'.repeat(64))] },
      { fetchContent, writeFile: async () => {} },
    );

    expect(fetchContent).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a skill that ships no files', async () => {
    const fetchContent = jest.fn();
    const empty = await materializeSkillBundle(SKILL, null, {
      fetchContent,
      writeFile: async () => {},
    });

    expect(empty).toEqual({ files: [], failed: [] });
    expect(fetchContent).not.toHaveBeenCalled();
  });
});

describe('describeMaterializedFiles', () => {
  it('lists what landed, with the path the agent can actually use', () => {
    const note = describeMaterializedFiles({
      files: [
        {
          absolutePath: '/workspace/.skills/s/scripts/run.py',
          path: 'scripts/run.py',
          bytes: 10,
          executable: true,
        },
      ],
      failed: [],
    });

    expect(note).toContain('scripts/run.py');
    expect(note).toContain('/workspace/.skills/s/scripts/run.py');
    expect(note).toContain('executable');
  });

  it('says plainly which files are NOT available', () => {
    // A skill that silently references a missing script sends the model to call
    // something that is not there.
    const note = describeMaterializedFiles({
      files: [],
      failed: [{ path: 'scripts/run.py', reason: 'unavailable' }],
    });

    expect(note).toMatch(/do not rely on them/i);
    expect(note).toContain('scripts/run.py');
  });

  it('is empty for a skill with no files at all', () => {
    expect(describeMaterializedFiles({ files: [], failed: [] })).toBe('');
  });
});
