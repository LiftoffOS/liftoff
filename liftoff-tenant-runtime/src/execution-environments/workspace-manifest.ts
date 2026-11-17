// What was in the workspace before it was reclaimed.
//
// A paused run whose sandbox is reaped resumes into a NEW, empty workspace. The
// agent is already told that, on the first tool call after the reset — but the
// notice can only say "any files written before the pause are gone", because
// nothing captured what they were. An agent that wrote twelve files gets a
// category rather than a list, and has to re-derive which of them mattered.
//
// This is the list. Captured at terminal state, read when the reset notice is
// built, and deliberately small: paths, sizes, content hashes, and the handles
// (spill files, shell and node sessions) whose absence the agent will otherwise
// discover one failed call at a time.
//
// Best-effort throughout. A manifest is a courtesy to the next run, and a
// courtesy that can fail the run it is being courteous to is worse than none —
// every failure path here degrades to the generic notice we already ship.

import { logger as log } from '../infrastructure/logging';
import type { SandboxProvider } from './types';

/** Where the workspace lives. Same root the checkpoint store snapshots. */
const WORK_TREE = '/workspace';

/** Spill targets from the tool-result bound. Their absence is what makes a
 *  resumed run re-read a result it already parked. */
const SPILL_DIR = '/tmp/results';

/** Files listed in full before the notice truncates. A manifest is for
 *  reorienting, not for auditing: past this many the list stops being
 *  something a model reads and starts being something it skims. */
export const MANIFEST_NOTICE_LIMIT = 20;

/** Cap on files recorded at all. A build output directory can hold thousands,
 *  and a manifest that large costs more to store than the workspace it
 *  describes. */
const MAX_MANIFEST_FILES = 500;

export interface WorkspaceManifest {
  sandboxId: string;
  sessionId: string;
  capturedAt: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  /** SPILL_DIR contents — parked tool results the next run cannot read back. */
  spillFiles: string[];
  bashSessions: string[];
  nodeSessions: string[];
}

/** In-process store, keyed by session id.
 *
 *  Deliberately not a table. The manifest is read exactly once, by the very next
 *  run on the same session, and only to make one notice specific — so its whole
 *  useful life is minutes. Persisting it would add a migration, a write on every
 *  terminal state, and a retention question, to describe a workspace that no
 *  longer exists. A process restart loses it and the notice degrades to the
 *  generic text, which is what ships today. */
const manifests = new Map<string, WorkspaceManifest>();

/** Bound on remembered manifests. Each is at most MAX_MANIFEST_FILES entries. */
const MAX_REMEMBERED = 500;

export interface CaptureContext {
  provider: SandboxProvider;
  sandboxId: string;
  sessionId: string;
  bashSessions?: string[];
  nodeSessions?: string[];
}

/** Capture what the workspace holds right now.
 *
 *  One `find`, one `sha256sum`, both bounded. Returns null rather than throwing
 *  on any failure: the caller is at terminal state and must not be delayed or
 *  failed by bookkeeping. */
export async function captureWorkspaceManifest(
  ctx: CaptureContext,
): Promise<WorkspaceManifest | null> {
  try {
    const listed = await ctx.provider.exec(ctx.sandboxId, [
      'sh', '-c',
      // Size and path per line, newest-irrelevant order. `-type f` skips
      // directories and symlinks; a symlink's target is either in the list on
      // its own or outside the workspace, and neither is worth a second stat.
      `find ${WORK_TREE} -maxdepth 8 -type f -not -path '*/.git/*' -not -path '*/node_modules/*' `
      + `-printf '%s\\t%p\\n' 2>/dev/null | head -n ${MAX_MANIFEST_FILES}`,
    ], { timeout: 30_000 });
    if (!listed || listed.exitCode !== 0) return null;

    const files: WorkspaceManifest['files'] = [];
    for (const line of (listed.stdout ?? '').split('\n')) {
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const bytes = Number(line.slice(0, tab));
      const path = line.slice(tab + 1).trim();
      if (!path || !Number.isFinite(bytes)) continue;
      files.push({ path, bytes, sha256: '' });
    }

    // Hashes in one call rather than one per file. An unreadable file simply
    // has no hash — the path and size are the useful part, and a missing hash
    // must not cost the whole manifest.
    if (files.length > 0) {
      const hashed = await ctx.provider.exec(ctx.sandboxId, [
        'sh', '-c',
        `printf '%s\\n' ${files.map((f) => `'${f.path.replace(/'/g, "'\\''")}'`).join(' ')} `
        + '| xargs -d "\\n" -r sha256sum 2>/dev/null',
      ], { timeout: 60_000 }).catch(() => null);
      if (hashed?.exitCode === 0) {
        const byPath = new Map<string, string>();
        for (const line of (hashed.stdout ?? '').split('\n')) {
          const m = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim());
          if (m) byPath.set(m[2].trim(), m[1]);
        }
        for (const f of files) f.sha256 = byPath.get(f.path) ?? '';
      }
    }

    const spilled = await ctx.provider.exec(ctx.sandboxId, [
      'sh', '-c', `ls -1 ${SPILL_DIR} 2>/dev/null | head -n 100`,
    ], { timeout: 15_000 }).catch(() => null);
    const spillFiles = spilled?.exitCode === 0
      ? (spilled.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean)
      : [];

    const manifest: WorkspaceManifest = {
      sandboxId: ctx.sandboxId,
      sessionId: ctx.sessionId,
      capturedAt: new Date().toISOString(),
      files,
      spillFiles,
      bashSessions: ctx.bashSessions ?? [],
      nodeSessions: ctx.nodeSessions ?? [],
    };
    rememberWorkspaceManifest(manifest);
    return manifest;
  } catch (err) {
    log.warn(
      { sandboxId: ctx.sandboxId, err: (err as Error).message },
      'workspace manifest capture failed (non-fatal — the reset notice stays generic)',
    );
    return null;
  }
}

export function rememberWorkspaceManifest(manifest: WorkspaceManifest): void {
  if (manifests.size >= MAX_REMEMBERED) {
    // Oldest insertion first: Map preserves insertion order, so one shift is
    // enough and there is no scan.
    const oldest = manifests.keys().next();
    if (!oldest.done) manifests.delete(oldest.value);
  }
  manifests.set(manifest.sessionId, manifest);
}

export function loadWorkspaceManifest(sessionId: string): WorkspaceManifest | null {
  return manifests.get(sessionId) ?? null;
}

export function _resetWorkspaceManifestsForTest(): void {
  manifests.clear();
}

/** The reset notice, named.
 *
 *  Falls back to `generic` whenever there is nothing specific to say — no
 *  manifest, or a manifest that recorded no files — so a missing capture
 *  degrades to today's behaviour rather than to silence. */
export function buildWorkspaceResetNotice(
  manifest: WorkspaceManifest | null,
  generic: string,
): string {
  if (!manifest || manifest.files.length === 0) return generic;

  const shown = manifest.files.slice(0, MANIFEST_NOTICE_LIMIT);
  const more = manifest.files.length - shown.length;
  const fileList = shown.map((f) => `  - ${f.path} (${f.bytes} bytes)`).join('\n')
    + (more > 0 ? `\n  - …and ${more} more` : '');

  const sessionNote = (manifest.bashSessions.length || manifest.nodeSessions.length)
    ? '\nShell and Node sessions from that run no longer exist; create new ones before using them.'
    : '';

  const spillNote = manifest.spillFiles.length
    ? `\n${manifest.spillFiles.length} parked tool result(s) were reclaimed with it; re-run whatever produced them if you still need the output.`
    : '';

  return 'This run resumed with a NEW, empty workspace — the previous one was reclaimed while '
    + 'the run was paused. These files are gone and must be re-created if you still need '
    + `them:\n${fileList}${sessionNote}${spillNote}`;
}
