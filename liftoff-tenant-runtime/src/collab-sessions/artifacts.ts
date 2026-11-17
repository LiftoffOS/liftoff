// Hardened capture of a session's deliverable files.
//
// File I/O is asynchronous (never blocks the event loop on the run-completion
// path), but the capture is still awaited before execution continues, so the
// contents are an immutable snapshot: `captureAt` is stamped at the synchronous
// start of the emitter capture, and only files with mtime in [startedAt,
// captureAt] are admitted — a later turn writing the same directory is excluded
// by mtime regardless of when these reads run.
//
// Path safety against symlink/TOCTOU:
//   - the session root is canonicalised and must sit under a trusted root;
//   - every ancestor component below the root is lstat-verified non-symlink;
//   - files are opened O_NOFOLLOW, then fstat-rechecked on the open handle
//     (regular file, size cap, mtime window).
// Only text (extension allowlist) is admitted, redacted before it leaves.

import { promises as fsp, constants as fsc } from 'fs';
import type { Dirent } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { redactSensitiveContent } from '../memory/content-sanitizer';
import { logger } from '../infrastructure/logging';

const MAX_FILES = 20;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.csv', '.json', '.html', '.ts', '.py']);
// Binary deliverable formats. Captured RAW (stored as bytes, base64-materialized
// into the grader sandbox). Binary content cannot be text-redacted, so it is
// stored UN-redacted — acceptable because the eval substrate is internal /
// operator-only and deliberately collects deliverable content for grading. Gated
// like all capture behind COLLAB_ARTIFACT_SNAPSHOT_ENABLED.
const BINARY_EXTENSIONS = new Set(['.xlsx', '.xls', '.pdf', '.zip', '.docx', '.pptx', '.png', '.jpg', '.jpeg']);
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  '.md': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv',
  '.json': 'application/json', '.html': 'text/html', '.ts': 'text/plain', '.py': 'text/plain',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel', '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
};
const SKIP_DIRS = new Set(['node_modules', '.git']);

export interface CapturedArtifact {
  relpath: string;
  bytes: number;
  contentType: string;
  /** Text content (redacted) OR raw bytes (binary, un-redactable). */
  content: string | Buffer;
  /** False for binary deliverables (raw); true for text (redacted). */
  redacted: boolean;
}

async function trustedRoots(): Promise<string[]> {
  const tmp = await fsp.realpath(os.tmpdir());
  return [tmp + path.sep + 'tr-claude-sessions', tmp + path.sep + 'tr-run-sessions'];
}

async function isUnderTrustedRoot(canonical: string): Promise<boolean> {
  const roots = await trustedRoots();
  return roots.some((root) => canonical === root || canonical.startsWith(root + path.sep));
}

/** lstat every path segment from the root down to `target`; reject if any is a
 *  symlink. Guards against a swapped-in symlink ancestor between validation and
 *  open. */
async function ancestorsAreRealDirs(root: string, target: string): Promise<boolean> {
  const rel = path.relative(root, target);
  if (rel.startsWith('..')) return false;
  let cur = root;
  for (const seg of rel.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, seg);
    try {
      const st = await fsp.lstat(cur);
      if (st.isSymbolicLink()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Read one file safely with O_NOFOLLOW + post-open fstat re-check. */
async function readAdmittedFile(
  absPath: string,
  startedAt: number,
  captureAt: number,
  binary: boolean,
): Promise<{ bytes: number; content: string | Buffer } | null> {
  let handle: import('fs/promises').FileHandle;
  try {
    handle = await fsp.open(absPath, fsc.O_RDONLY | fsc.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return null;
    if (st.size > MAX_FILE_BYTES) return null;
    const mtime = st.mtimeMs;
    if (mtime < startedAt || mtime > captureAt) return null;
    const buf = Buffer.allocUnsafe(st.size);
    let read = 0;
    while (read < st.size) {
      const { bytesRead } = await handle.read(buf, read, st.size - read, read);
      if (bytesRead <= 0) break;
      read += bytesRead;
    }
    return {
      bytes: read,
      content: binary
        ? Buffer.from(buf.subarray(0, read))
        : redactSensitiveContent(buf.subarray(0, read).toString('utf8')),
    };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Capture admitted deliverable files under `sessionStateDir`. Best-effort: an
 *  unreadable / non-trusted / absent dir yields []. */
export async function captureArtifacts(
  sessionStateDir: string | undefined,
  startedAt: number,
  captureAt: number,
): Promise<CapturedArtifact[]> {
  if (!sessionStateDir) return [];
  let root: string;
  try {
    root = await fsp.realpath(sessionStateDir);
  } catch {
    return [];
  }
  if (!(await isUnderTrustedRoot(root))) {
    logger.debug({ sessionStateDir }, 'collab artifact capture: dir not under a trusted root; skipping');
    return [];
  }

  const out: CapturedArtifact[] = [];
  let totalBytes = 0;
  const stack: string[] = [root];
  while (stack.length > 0 && out.length < MAX_FILES && totalBytes < MAX_TOTAL_BYTES) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (out.length >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) break;
      if (ent.name.startsWith('.')) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) stack.push(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      const isBinary = BINARY_EXTENSIONS.has(ext);
      if (!TEXT_EXTENSIONS.has(ext) && !isBinary) continue;
      if (!(await ancestorsAreRealDirs(root, abs))) continue;
      const read = await readAdmittedFile(abs, startedAt, captureAt, isBinary);
      if (!read) continue;
      if (totalBytes + read.bytes > MAX_TOTAL_BYTES) continue;
      totalBytes += read.bytes;
      out.push({
        relpath: path.relative(root, abs),
        bytes: read.bytes,
        contentType: CONTENT_TYPE_BY_EXT[ext] ?? (isBinary ? 'application/octet-stream' : 'text/plain'),
        content: read.content,
        redacted: !isBinary,
      });
    }
  }
  return out;
}
