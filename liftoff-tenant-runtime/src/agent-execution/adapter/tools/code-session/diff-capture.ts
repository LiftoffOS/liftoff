// What a coding session changed, read off the checkout it worked in.
//
// Plain `git diff` answered a narrower question than the tool's contract. It
// compares the working tree with the INDEX, so a file the agent created (never
// added) was invisible, and so was everything the agent committed: the commit
// moved HEAD and the index with it, leaving a clean tree and an empty diff for
// a session that did real work. Both are ordinary for a coding CLI, which
// writes new files as a matter of course and commits before it pushes.
//
// So the session is measured against where it STARTED: the commit the checkout
// was on before the coding agent ran. The current tree, untracked files
// included and .gitignore respected, is staged into a throwaway index and
// diffed against that commit. The throwaway index lives inside .git and is
// named by GIT_INDEX_FILE for these commands only, so the checkout's own index,
// HEAD and branch are exactly as the session left them.
//
// Everything goes through `workspace.exec`, so the in-process and sandboxed
// workspaces capture the same way.

import type { CodeSessionWorkspace } from './workspace';

const GIT_TIMEOUT_MS = 30_000;
/** `git add -A` hashes every new file, which is the slow step on a large one. */
const GIT_ADD_TIMEOUT_MS = 60_000;
const MAX_DIFF_BYTES = 10 * 1024 * 1024;
const CAPTURE_INDEX_NAME = 'code-session-capture-index';

/** The commit the checkout is on before the coding agent runs.
 *
 *  Falls back to the empty tree for a repository with no commits yet (every
 *  file is then new), computed by git itself so it is right for either object
 *  format. Undefined when neither answers: capture then reports its failure
 *  rather than inventing a base. */
export async function recordSessionBase(
  workspace: CodeSessionWorkspace,
  root: string,
): Promise<string | undefined> {
  const head = await workspace.exec(['git', '-C', root, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {
    cwd: root, timeoutMs: GIT_TIMEOUT_MS,
  });
  const sha = head.stdout.trim();
  if (head.exitCode === 0 && sha) return sha;
  const empty = await workspace.exec(['git', '-C', root, 'hash-object', '-t', 'tree', '/dev/null'], {
    cwd: root, timeoutMs: GIT_TIMEOUT_MS,
  });
  const tree = empty.stdout.trim();
  return empty.exitCode === 0 && tree ? tree : undefined;
}

/** `error` set means nothing was captured. A plain shape rather than a
 *  discriminated union because this project compiles without strictNullChecks,
 *  which does not narrow one. */
export interface CapturedChanges {
  diff: string;
  filesModified: string[];
  error?: string;
}

const failed = (error: string): CapturedChanges => ({ diff: '', filesModified: [], error });

/** Every change since `base`: committed, staged, unstaged and untracked. */
export async function captureSessionChanges(
  workspace: CodeSessionWorkspace,
  root: string,
  base: string | undefined,
): Promise<CapturedChanges> {
  if (!base) return failed('no base revision was recorded before the session');
  const git = (args: string[]) => ['git', '-C', root, ...args];

  const gitDir = await workspace.exec(git(['rev-parse', '--absolute-git-dir']), { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
  if (gitDir.exitCode !== 0 || !gitDir.stdout.trim()) {
    return failed(gitDir.stderr.trim() || `rev-parse exit ${gitDir.exitCode}`);
  }
  const env = { GIT_INDEX_FILE: `${gitDir.stdout.trim()}/${CAPTURE_INDEX_NAME}` };

  // Seed the throwaway index with the base, then stage the whole tree over it.
  // `read-tree` accepts a commit or a tree, so the empty-tree base works too.
  const seeded = await workspace.exec(git(['read-tree', base]), { cwd: root, timeoutMs: GIT_TIMEOUT_MS, env });
  if (seeded.exitCode !== 0) return failed(seeded.stderr.trim() || `read-tree exit ${seeded.exitCode}`);
  const staged = await workspace.exec(git(['add', '-A', '--', '.']), { cwd: root, timeoutMs: GIT_ADD_TIMEOUT_MS, env });
  if (staged.exitCode !== 0) return failed(staged.stderr.trim() || `add exit ${staged.exitCode}`);

  const diff = await workspace.exec(git(['diff', '--cached', '--no-color', base]), {
    cwd: root, timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: MAX_DIFF_BYTES, env,
  });
  if (diff.exitCode !== 0) return failed(diff.stderr.trim() || `diff exit ${diff.exitCode}`);
  const names = await workspace.exec(git(['diff', '--cached', '--name-only', base]), {
    cwd: root, timeoutMs: GIT_TIMEOUT_MS, env,
  });
  if (names.exitCode !== 0) return failed(names.stderr.trim() || `diff --name-only exit ${names.exitCode}`);

  // Best-effort: the checkout is destroyed after capture anyway.
  await workspace.exec(['rm', '-f', env.GIT_INDEX_FILE], { cwd: root, timeoutMs: GIT_TIMEOUT_MS }).catch(() => undefined);

  return {
    diff: diff.stdout,
    filesModified: names.stdout.split('\n').filter((l) => l.length > 0),
  };
}
