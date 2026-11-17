// Putting a skill's files where the agent can use them.
//
// A skill's `bundle` is a list of POINTERS. The content lives in the control
// plane's bucket, addressed by its own sha256. Before a run can use a skill
// that ships scripts, those files have to exist somewhere the sandbox can read
// them — that is all this module does.
//
// Three properties, and each exists because its absence is a specific failure:
//
//   * Digest-checked. A pointer is a promise about content. Handing a script a
//     file that is not the one its skill was written against is worse than
//     telling it the file is missing, so a mismatch refuses the file.
//   * Path-validated. A bundle path is joined onto a sandbox directory. `..`
//     or an absolute path is an escape, not a filename, and the check happens
//     here rather than trusting whatever wrote the pointer.
//   * Honest on failure. A file that cannot be fetched is NOT materialized and
//     NOT silently skipped: the caller is told which files landed, so the
//     context block can describe the skill it actually has rather than the one
//     the pointer described. A skill referencing files that are not there is
//     the no-stub-success rule applied to the filesystem.
//
// Content is cached by digest, which is safe precisely because the name IS the
// content: two skills sharing a file share the cache entry, and a file can
// never change under its own key.

import { logger } from '../infrastructure/logging';
import type { SkillBundle, SkillBundleFile } from '../instruction-compiler/internal-agent-instruction-service';

/** Where a skill's files land inside the sandbox workspace. `/workspace` is the
 *  work tree the sandbox already uses; `.skills` keeps them out of the way of
 *  whatever the agent is actually working on. */
export const SKILLS_MOUNT_ROOT = '/workspace/.skills';

/** Fetched content, keyed by digest. Bounded so a long-lived instance cannot
 *  accumulate every file every tenant has ever shipped. */
const MAX_CACHE_ENTRIES = 256;
const contentCache = new Map<string, string>();

/** Test-only: a test must not inherit another test's cached content. */
export function _clearBundleContentCache(): void {
  contentCache.clear();
}

/** How bundle content is fetched. Injected so this module does not depend on
 *  the transport, and so a test can exercise the digest check without a bucket. */
export type BundleContentFetcher = (
  storageRef: string,
  sha256: string,
) => Promise<string | null>;

export interface MaterializedFile {
  /** Absolute path inside the sandbox. */
  absolutePath: string;
  /** Path relative to the skill's own root, as the skill author wrote it. */
  path: string;
  bytes: number;
  executable: boolean;
}

export interface MaterializationResult {
  /** Files that are actually on disk in the sandbox. */
  files: MaterializedFile[];
  /** Files that could not be materialized, with the reason. Reported so the
   *  prompt can say so rather than describing tools that are not there. */
  failed: Array<{ path: string; reason: 'unsafe_path' | 'unavailable' | 'digest_mismatch' }>;
}

/** Reject a path that would escape the skill's own directory. */
export function isSafeBundlePath(p: string): boolean {
  if (!p || p.length > 512) return false;
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  if (p.includes('\\') || p.includes('\0')) return false;
  return !p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

/** A skill's directory inside the sandbox. Named by skill id rather than skill
 *  name: a name is user-authored and can contain anything, an id cannot. */
export function skillMountDir(skillId: string): string {
  return `${SKILLS_MOUNT_ROOT}/${skillId}`;
}

/** Fetch and write one skill's files into the sandbox.
 *
 *  `writeFile` is the sandbox's own write primitive, injected: this module
 *  decides WHAT lands and WHERE, never how a sandbox is talked to. */
export async function materializeSkillBundle(
  skillId: string,
  bundle: SkillBundle | null | undefined,
  deps: {
    fetchContent: BundleContentFetcher;
    writeFile: (absolutePath: string, content: string, executable: boolean) => Promise<void>;
  },
): Promise<MaterializationResult> {
  const result: MaterializationResult = { files: [], failed: [] };
  if (!bundle?.files?.length) return result;

  const dir = skillMountDir(skillId);

  for (const file of bundle.files) {
    if (!isSafeBundlePath(file.path)) {
      result.failed.push({ path: file.path, reason: 'unsafe_path' });
      logger.warn({ skillId, path: file.path }, 'skill bundle: refused an unsafe path');
      continue;
    }

    const content = await readContent(file, deps.fetchContent);
    if (content === null) {
      result.failed.push({ path: file.path, reason: 'unavailable' });
      continue;
    }

    const absolutePath = `${dir}/${file.path}`;
    try {
      await deps.writeFile(absolutePath, content, file.executable === true);
    } catch (err) {
      logger.warn(
        { skillId, path: file.path, err: (err as Error).message },
        'skill bundle: could not write a file into the sandbox',
      );
      result.failed.push({ path: file.path, reason: 'unavailable' });
      continue;
    }

    result.files.push({
      absolutePath,
      path: file.path,
      bytes: file.bytes,
      executable: file.executable === true,
    });
  }

  return result;
}

async function readContent(
  file: SkillBundleFile,
  fetchContent: BundleContentFetcher,
): Promise<string | null> {
  const cached = contentCache.get(file.sha256);
  if (cached !== undefined) return cached;

  const content = await fetchContent(file.storageRef, file.sha256);
  if (content === null) return null;

  if (contentCache.size >= MAX_CACHE_ENTRIES) {
    // Oldest first. Map preserves insertion order, and every entry is equally
    // valid, so the cheapest eviction is the right one.
    const oldest = contentCache.keys().next().value;
    if (oldest !== undefined) contentCache.delete(oldest);
  }
  contentCache.set(file.sha256, content);
  return content;
}

/** The lines that tell the model which files a skill ships and where they will
 *  be, built from the skill's POINTERS.
 *
 *  Built at prompt time, when no sandbox exists yet: sandboxes are provisioned
 *  on demand, and the files are written into one the first time the run uses
 *  it. So this describes what the skill HAS, at the path it will have it —
 *  never a claim that a file is already on disk. */
export function describeSkillFiles(skillId: string, bundle: SkillBundle | null | undefined): string {
  const files = (bundle?.files ?? []).filter((f) => isSafeBundlePath(f.path));
  if (files.length === 0) return '';

  const dir = skillMountDir(skillId);
  const lines = files
    .map((f) => `- ${f.path} → ${dir}/${f.path}${f.executable ? ' (executable)' : ''}`)
    .join('\n');
  return `Files this skill ships, available in the workspace once you use it:\n${lines}`;
}

/** The lines that tell the model which files a skill has and where they are.
 *
 *  Only files that ACTUALLY landed are listed. When some failed, that is said
 *  plainly: a model told a script exists will call it, and a missing-file error
 *  from inside a run is a worse outcome than knowing up front. */
export function describeMaterializedFiles(result: MaterializationResult): string {
  if (result.files.length === 0 && result.failed.length === 0) return '';

  const parts: string[] = [];
  if (result.files.length > 0) {
    const lines = result.files
      .map((f) => `- ${f.path} → ${f.absolutePath}${f.executable ? ' (executable)' : ''}`)
      .join('\n');
    parts.push(`Files available to this skill:\n${lines}`);
  }
  if (result.failed.length > 0) {
    parts.push(
      `These files could not be made available for this run, so do not rely on them: ${result.failed
        .map((f) => f.path)
        .join(', ')}.`,
    );
  }
  return parts.join('\n');
}
