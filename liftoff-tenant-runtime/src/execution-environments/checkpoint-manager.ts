// Being able to undo what a run did to a workspace.
//
// Today a run that goes wrong halfway through leaves the workspace in whatever
// state it reached. There is no "before" to go back to: the agent's own commits
// are the only history, and a run that never committed has none. The person
// watching it can stop the run, and then owns a half-edited tree.
//
// So: snapshot the workspace before it is first mutated in a turn, into a git
// store that is NOT the repository the agent is working in.
//
// Four properties, each of which is a decision rather than an implementation
// detail:
//
//   * A SEPARATE git directory. Writing checkpoints into the agent's own `.git`
//     would put our commits in their history, fight their index, and show up in
//     their `git log` and their pull request. The shadow store keeps the
//     agent's repository byte-for-byte its own.
//   * ONCE PER TURN, before the first mutation. Snapshotting every write would
//     make a fifty-edit turn fifty snapshots, and the useful granularity is "the
//     state before this turn started", which is what a person actually wants to
//     go back to.
//   * ORPHAN commits, one ref each, no chain. There is no history to rewrite,
//     which is what makes pruning a matter of deleting a ref rather than a
//     rebase. Restore is a tree read, so it works on any checkpoint regardless
//     of what happened after it.
//   * INVISIBLE to the model. No tool, no catalog entry, nothing in a tool
//     result. A model that can see checkpoints will start reasoning about them,
//     and "roll back and try again" is a loop, not a recovery.
//
// Rollback is an operator verb, not a model one — `listCheckpoints` and
// `restoreCheckpoint` are called from the sandbox-executor's operator surface.

import { log } from '../infrastructure/logging';
import type { SandboxProvider } from './types';

/** Where the shadow store lives. Inside the workspace so it shares the
 *  sandbox's lifecycle, and excluded from its own snapshots below. */
export const CHECKPOINT_GIT_DIR = '/workspace/.checkpoints';
const WORK_TREE = '/workspace';
const REF_PREFIX = 'refs/checkpoints';

/** Checkpoints kept per sandbox. Past this the oldest are dropped, because the
 *  value of a checkpoint falls off sharply with age — nobody rolls back forty
 *  turns. */
export const MAX_CHECKPOINTS = Number(process.env.SANDBOX_MAX_CHECKPOINTS ?? 20);

/** A snapshot is worth taking only if the tree could have changed. Everything
 *  else — reads, searches, browser calls — is skipped, so a read-heavy turn
 *  costs nothing. */
const MUTATING_TOOLS = new Set([
  'shell_exec',
  'file_write',
  'file_edit',
  'file_str_replace_editor',
  'git_clone',
  'code_execute',
  'nodejs_execute',
  'bash_session_exec',
  'shell_session_write',
]);

export function isMutatingTool(toolName: string): boolean {
  return MUTATING_TOOLS.has(toolName);
}

/**
 * Paths never snapshotted.
 *
 * `node_modules` and friends are the difference between a snapshot that costs
 * milliseconds and one that costs a minute, and none of it is work the agent
 * did. `.git` is excluded because the agent's repository is its own history and
 * copying it into ours would double every object.
 */
const EXCLUDES = [
  '.checkpoints/',
  '.git/',
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.mypy_cache/',
  '.pytest_cache/',
  'dist/',
  'build/',
  'target/',
  '.next/',
  '.turbo/',
  '*.log',
].join('\n');

/** Identity on the checkpoint commits. Not a real person, and it should be
 *  obvious in any log that it is not. */
const GIT_IDENTITY = [
  '-c', 'user.name=Liftoff Checkpoints',
  '-c', 'user.email=checkpoints@liftoffos.local',
  '-c', 'commit.gpgsign=false',
];

function gitArgs(...rest: string[]): string[] {
  return ['git', `--git-dir=${CHECKPOINT_GIT_DIR}`, `--work-tree=${WORK_TREE}`, ...rest];
}

/** Turns already snapshotted, keyed by sandbox and invocation.
 *
 *  In memory on purpose: the guarantee is "at most once per turn per process",
 *  and the cost of missing it (one extra snapshot after a restart) is far
 *  cheaper than a table write on every sandbox tool call. */
const snapshottedTurns = new Set<string>();

/** Sandboxes whose store is known to exist, so `init` runs once rather than
 *  before every snapshot. */
const initializedStores = new Set<string>();

export function clearCheckpointState(sandboxId: string): void {
  initializedStores.delete(sandboxId);
  for (const key of snapshottedTurns) {
    if (key.startsWith(`${sandboxId}::`)) snapshottedTurns.delete(key);
  }
}

/** Exported for tests — the caches are module state and a test that leaves them
 *  populated silently disables the next one. */
export function _resetCheckpointStateForTest(): void {
  snapshottedTurns.clear();
  initializedStores.clear();
}

export interface Checkpoint {
  /** Ref name, and what `restoreCheckpoint` takes. */
  id: string;
  commit: string;
  createdAt: string;
  label: string;
}

async function run(
  provider: SandboxProvider,
  sandboxId: string,
  args: string[],
  timeout = 60_000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const r = await provider.exec(sandboxId, args, { timeout });
  return { ok: r.exitCode === 0, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

/**
 * Create the shadow store if it is not there.
 *
 * `--bare` then `core.bare=false`: a bare repository has no work tree of its
 * own, which is exactly right for a store that is always pointed at one
 * explicitly, but git refuses work-tree operations while `core.bare` is true.
 * The pair gets a repository with no working copy AND no objection to the
 * `--work-tree` we always pass.
 */
async function ensureStore(provider: SandboxProvider, sandboxId: string): Promise<boolean> {
  if (initializedStores.has(sandboxId)) return true;

  const exists = await run(provider, sandboxId, ['test', '-d', `${CHECKPOINT_GIT_DIR}/objects`], 10_000);
  if (!exists.ok) {
    const init = await run(provider, sandboxId, ['git', 'init', '--bare', '--quiet', CHECKPOINT_GIT_DIR], 30_000);
    if (!init.ok) {
      log.warn({ sandboxId, stderr: init.stderr }, 'checkpoint: could not create the shadow store');
      return false;
    }
    await run(provider, sandboxId, ['git', `--git-dir=${CHECKPOINT_GIT_DIR}`, 'config', 'core.bare', 'false']);
    await provider.writeFile(sandboxId, `${CHECKPOINT_GIT_DIR}/info/exclude`, `${EXCLUDES}\n`);
  }

  initializedStores.add(sandboxId);
  return true;
}

/**
 * Snapshot the workspace, at most once per turn.
 *
 * Returns the checkpoint when one was taken, null when it was skipped — already
 * done this turn, nothing changed since the last one, or the store could not be
 * written. Never throws: a checkpoint is insurance, and insurance that can fail
 * the thing it insures is worse than none.
 */
export async function snapshotOnce(args: {
  provider: SandboxProvider;
  sandboxId: string;
  invocationId: string;
  label?: string;
}): Promise<Checkpoint | null> {
  const { provider, sandboxId, invocationId } = args;
  const turnKey = `${sandboxId}::${invocationId}`;
  if (snapshottedTurns.has(turnKey)) return null;
  // Claimed BEFORE the work, not after: two mutating calls can be in flight at
  // once, and claiming afterwards would let both snapshot the same turn.
  snapshottedTurns.add(turnKey);

  try {
    if (!await ensureStore(provider, sandboxId)) return null;

    const added = await run(provider, sandboxId, gitArgs('add', '--all', '--', WORK_TREE), 120_000);
    if (!added.ok) {
      log.warn({ sandboxId, stderr: added.stderr }, 'checkpoint: could not stage the workspace');
      return null;
    }

    const tree = await run(provider, sandboxId, gitArgs('write-tree'));
    if (!tree.ok || !tree.stdout) return null;

    // An unchanged tree is the same object id, so a turn that mutated nothing
    // in the end costs one ref lookup instead of a duplicate checkpoint.
    const previous = await listCheckpoints(provider, sandboxId);
    if (previous[0]) {
      const prevTree = await run(provider, sandboxId, gitArgs('rev-parse', `${previous[0].commit}^{tree}`));
      if (prevTree.ok && prevTree.stdout === tree.stdout) return null;
    }

    const label = (args.label ?? 'before this turn').replace(/[\r\n]+/g, ' ').slice(0, 200);
    const commit = await run(provider, sandboxId, [
      'git', `--git-dir=${CHECKPOINT_GIT_DIR}`, ...GIT_IDENTITY,
      // No `-p`: every checkpoint is an orphan. There is no history to rewrite,
      // so pruning is deleting a ref rather than a rebase, and restoring one
      // does not depend on the ones after it still existing.
      'commit-tree', tree.stdout, '-m', label,
    ]);
    if (!commit.ok || !commit.stdout) return null;

    const id = `${REF_PREFIX}/${Date.now()}-${invocationId.slice(0, 8)}`;
    const ref = await run(provider, sandboxId, [
      'git', `--git-dir=${CHECKPOINT_GIT_DIR}`, 'update-ref', id, commit.stdout,
    ]);
    if (!ref.ok) return null;

    await prune(provider, sandboxId);

    log.info({ sandboxId, invocationId, checkpoint: id }, 'checkpoint: workspace snapshotted');
    return { id, commit: commit.stdout, createdAt: new Date().toISOString(), label };
  } catch (err) {
    log.warn({ sandboxId, err: (err as Error).message }, 'checkpoint: snapshot failed');
    return null;
  }
}

/** A content fingerprint of the whole workspace: the git tree object id of
 *  everything under WORK_TREE.
 *
 *  Reuses the checkpoint store's own plumbing, so it costs one `add` plus one
 *  `write-tree` and needs no second mechanism to keep correct. Two workspaces
 *  with identical content produce the same id and two that differ anywhere
 *  produce different ones — which is the only question the verify gate is
 *  asking: did this run change anything at all?
 *
 *  Returns undefined rather than throwing when the workspace cannot be read.
 *  An unknown fingerprint must degrade to "we could not tell", never to
 *  "nothing changed" — the second would suppress a nudge the run had earned. */
export async function workspaceTreeHash(
  provider: SandboxProvider,
  sandboxId: string,
): Promise<string | undefined> {
  try {
    if (!await ensureStore(provider, sandboxId)) return undefined;
    const added = await run(provider, sandboxId, gitArgs('add', '--all', '--', WORK_TREE), 120_000);
    if (!added.ok) return undefined;
    const tree = await run(provider, sandboxId, gitArgs('write-tree'));
    return tree.ok && tree.stdout ? tree.stdout : undefined;
  } catch {
    return undefined;
  }
}

/** Newest first. */
export async function listCheckpoints(
  provider: SandboxProvider,
  sandboxId: string,
): Promise<Checkpoint[]> {
  try {
    const r = await run(provider, sandboxId, [
      'git', `--git-dir=${CHECKPOINT_GIT_DIR}`, 'for-each-ref',
      '--sort=-creatordate',
      '--format=%(refname)\t%(objectname)\t%(creatordate:iso-strict)\t%(contents:subject)',
      REF_PREFIX,
    ]);
    if (!r.ok || !r.stdout) return [];
    return r.stdout.split('\n').filter(Boolean).map((line) => {
      const [id, commit, createdAt, ...rest] = line.split('\t');
      return { id, commit, createdAt, label: rest.join('\t') };
    });
  } catch {
    return [];
  }
}

/**
 * Put the workspace back to a checkpoint.
 *
 * The current state is checkpointed FIRST. A restore that cannot itself be
 * undone is a second way to lose the work, and the person reaching for this is
 * already having a bad time.
 *
 * `read-tree -u --reset` rather than `checkout`: it replaces the index and the
 * working tree with the recorded tree in one operation, which removes files
 * created after the checkpoint as well as restoring the ones changed. A
 * `checkout -- .` would restore the edits and leave the new files behind, which
 * is not what "go back" means.
 */
export async function restoreCheckpoint(args: {
  provider: SandboxProvider;
  sandboxId: string;
  checkpointId: string;
  invocationId?: string;
}): Promise<{ restored: boolean; safetyCheckpoint: string | null; error?: string }> {
  const { provider, sandboxId, checkpointId } = args;

  if (!checkpointId.startsWith(`${REF_PREFIX}/`)) {
    return { restored: false, safetyCheckpoint: null, error: 'not a checkpoint id' };
  }

  try {
    if (!await ensureStore(provider, sandboxId)) {
      return { restored: false, safetyCheckpoint: null, error: 'no checkpoint store' };
    }

    const known = await listCheckpoints(provider, sandboxId);
    if (!known.some((c) => c.id === checkpointId)) {
      return { restored: false, safetyCheckpoint: null, error: 'unknown checkpoint' };
    }

    // Force a snapshot of where we are now, even if this turn already had one —
    // this is exactly the moment the once-per-turn rule must not apply.
    const safetyKey = `${sandboxId}::restore-${Date.now()}`;
    const safety = await snapshotOnce({
      provider,
      sandboxId,
      invocationId: safetyKey,
      label: `before restoring ${checkpointId}`,
    });

    const reset = await run(provider, sandboxId, gitArgs('read-tree', '-u', '--reset', checkpointId), 120_000);
    if (!reset.ok) {
      return { restored: false, safetyCheckpoint: safety?.id ?? null, error: reset.stderr || 'restore failed' };
    }

    log.info(
      { sandboxId, checkpointId, safetyCheckpoint: safety?.id ?? null },
      'checkpoint: workspace restored',
    );
    return { restored: true, safetyCheckpoint: safety?.id ?? null };
  } catch (err) {
    return { restored: false, safetyCheckpoint: null, error: (err as Error).message };
  }
}

/**
 * Drop the oldest checkpoints past the cap and let git collect what they held.
 *
 * The `gc` matters: deleting a ref only makes its objects unreachable, and an
 * unreachable snapshot of a large workspace still occupies the disk the agent
 * is trying to build on.
 */
export async function prune(provider: SandboxProvider, sandboxId: string): Promise<number> {
  try {
    const all = await listCheckpoints(provider, sandboxId);
    if (all.length <= MAX_CHECKPOINTS) return 0;

    const drop = all.slice(MAX_CHECKPOINTS);
    for (const c of drop) {
      await run(provider, sandboxId, ['git', `--git-dir=${CHECKPOINT_GIT_DIR}`, 'update-ref', '-d', c.id]);
    }
    await run(provider, sandboxId, [
      'git', `--git-dir=${CHECKPOINT_GIT_DIR}`, 'gc', '--prune=now', '--quiet',
    ], 120_000);

    // Said out loud rather than silently: a person who restores the oldest
    // checkpoint they can see should be able to find out why older ones are
    // not there.
    log.info(
      { sandboxId, dropped: drop.length, kept: MAX_CHECKPOINTS },
      'checkpoint: pruned the oldest checkpoints past the cap',
    );
    return drop.length;
  } catch (err) {
    log.warn({ sandboxId, err: (err as Error).message }, 'checkpoint: prune failed');
    return 0;
  }
}
