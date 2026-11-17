// Files that belong to a skill.
//
// A skill used to be one block of text, which is only half of what the SKILL.md
// convention actually is: a directory holding SKILL.md plus `scripts/`,
// `references/` and `examples/`. Importing only the text left every script the
// author wrote on the machine we imported from, and the skill then described
// tools that were not there.
//
// The database holds POINTERS, never content. Content goes to the generated
// files bucket, keyed by its own sha256 under
// `skill-bundles/{tenantId}/{skillId}/{sha256}`, so the same file written by a
// rewrite, a redistill or a second agent uploads once and every later reference
// finds it already there.
//
// TEXT ONLY, in this version. The secret filter reads text; it cannot scan a
// binary, and an unscannable file that travels from a customer's laptop into
// shared storage is an exfiltration path we would not be able to see. A binary
// is reported per file, with its name, rather than dropped in silence.

import crypto from 'crypto';
import { generatedFilesBucket } from '../generated-files/gcs-client';
import { log } from '../infrastructure/logging';
import type { SkillBundle, SkillBundleFile } from './types';

// ── caps ───────────────────────────────────────────────────────────────
//
// Calibrated against 160 real skills — the Anthropic skills
// corpus, the Codex vendored skills, OpenClaw's 50 bundled skills and Hermes's
// skill tree. Coverage of that corpus at these three together: 97.5%.
//
// The distribution is the reason they are not higher. Median skill: 1 file,
// 11 KB. p95: 21 files, 166 KB. What sits past these caps is not a big skill,
// it is a vendored repository somebody dropped inside a skill directory — one
// had 534 files and 12.8 MB. Raising the caps to admit that would not import a
// better skill, it would import a checkout.

/** Files per skill. 50 covers 98.1% of the corpus; 100 buys 0.7pp more. */
export const MAX_BUNDLE_FILES = 50;

/** One file. 256 KB covers 98.8%; the p95 largest single file is 42 KB. */
export const MAX_BUNDLE_FILE_BYTES = 256 * 1024;

/** All files in one skill. 2 MB covers 99.4%. */
export const MAX_BUNDLE_TOTAL_BYTES = 2 * 1024 * 1024;

/** Path segments that may never appear. Mirrors the stance of the runtime's
 *  path validator: a bundle path is joined onto a sandbox directory, so a `..`
 *  or an absolute path is an escape, not a filename. */
export function isSafeBundlePath(p: string): boolean {
  if (p.length === 0 || p.length > 512) return false;
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  if (p.includes('\\')) return false;
  if (p.includes('\0')) return false;
  const segments = p.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return false;
  return true;
}

export interface BundleFileInput {
  path: string;
  text: string;
  executable?: boolean;
}

export interface BundleStoreResult {
  bundle: SkillBundle | null;
  /** Files refused, with the reason, so the caller can report each by name
   *  rather than announcing a count. */
  rejected: Array<{ path: string; reason: string }>;
}

export function sha256Of(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Where one file's content lives. Content-addressed: the digest IS the name,
 *  so an identical file written twice occupies one object. */
export function bundleObjectPath(tenantId: string, skillId: string, sha256: string): string {
  return `skill-bundles/${tenantId}/${skillId}/${sha256}`;
}

/** Upload a skill's files and return the pointers to record on the skill.
 *
 *  Files are validated first and uploaded second, so a bundle that breaks a cap
 *  never leaves a half-written object behind. Content already present is not
 *  re-uploaded: the digest is the object name, so existence IS equality. */
export async function storeSkillBundle(
  tenantId: string,
  skillId: string,
  files: BundleFileInput[],
): Promise<BundleStoreResult> {
  const rejected: Array<{ path: string; reason: string }> = [];
  const accepted: BundleFileInput[] = [];

  let runningTotal = 0;
  for (const file of files) {
    if (!isSafeBundlePath(file.path)) {
      rejected.push({ path: file.path, reason: 'unsafe_path' });
      continue;
    }
    const bytes = Buffer.byteLength(file.text, 'utf8');
    if (bytes > MAX_BUNDLE_FILE_BYTES) {
      rejected.push({ path: file.path, reason: 'file_too_large' });
      continue;
    }
    if (accepted.length >= MAX_BUNDLE_FILES) {
      rejected.push({ path: file.path, reason: 'too_many_files' });
      continue;
    }
    if (runningTotal + bytes > MAX_BUNDLE_TOTAL_BYTES) {
      rejected.push({ path: file.path, reason: 'bundle_too_large' });
      continue;
    }
    runningTotal += bytes;
    accepted.push(file);
  }

  if (accepted.length === 0) return { bundle: null, rejected };

  const bucket = generatedFilesBucket();
  const stored: SkillBundleFile[] = [];

  for (const file of accepted) {
    const sha256 = sha256Of(file.text);
    const objectPath = bundleObjectPath(tenantId, skillId, sha256);
    const object = bucket.file(objectPath);

    try {
      const [exists] = await object.exists();
      if (!exists) {
        await object.save(Buffer.from(file.text, 'utf8'), {
          contentType: 'text/plain; charset=utf-8',
          resumable: false,
        });
      }
    } catch (err) {
      // One file that cannot be stored must not take the skill with it. It is
      // reported, and the skill imports without it — which the context block
      // then says out loud rather than referencing a file that is not there.
      log.error(
        { tenantId, skillId, path: file.path, error: (err as Error).message },
        'skill-bundle: could not store a file; skill imports without it',
      );
      rejected.push({ path: file.path, reason: 'storage_failed' });
      continue;
    }

    stored.push({
      path: file.path,
      bytes: Buffer.byteLength(file.text, 'utf8'),
      sha256,
      storageRef: objectPath,
      ...(file.executable ? { executable: true } : {}),
    });
  }

  return { bundle: stored.length > 0 ? { files: stored } : null, rejected };
}

/** Read one bundle file back, verifying it is the content the pointer claims.
 *
 *  The digest is checked on every read. A pointer is only a promise about
 *  content, and handing a script a file that is not the one its skill was
 *  written against is worse than telling it the file is missing. */
export async function readSkillBundleFile(
  storageRef: string,
  expectedSha256: string,
): Promise<string | null> {
  try {
    const [buffer] = await generatedFilesBucket().file(storageRef).download();
    const text = buffer.toString('utf8');
    const actual = sha256Of(text);
    if (actual !== expectedSha256) {
      log.error(
        { storageRef, expectedSha256, actual },
        'skill-bundle: stored file does not match its recorded digest; refusing it',
      );
      return null;
    }
    return text;
  } catch (err) {
    log.warn(
      { storageRef, error: (err as Error).message },
      'skill-bundle: could not read a bundle file',
    );
    return null;
  }
}
