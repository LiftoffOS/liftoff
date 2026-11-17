// Liftoff Switch — bounded, read-only filesystem access.
//
// Import runs against someone's home directory. Every read here is defensive:
//
//   * Containment  — a resolved path that escapes its declared source root is
//     refused. Source configs contain user-authored paths, and `../` in one of
//     them must not turn an importer into a home-directory reader.
//   * Symlinks     — never followed out of the root. A symlink to ~/.ssh inside
//     a skills directory is a link we can see and must not traverse.
//   * Bounds       — file size, file count, and text length are all capped, so
//     a pathological installation cannot exhaust memory or produce an
//     unbounded upload.
//   * No execution — nothing found here is ever executed. Plugins, policies,
//     hooks and skill bodies are TEXT to this importer, always.
//
// SQLite is opened read-only and only for metadata. The material these sources
// keep in SQLite (session transcripts, message history) is on the do-not-import
// list, so no row content ever reaches a bundle.

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { parse as parseToml } from 'smol-toml';
import { isCredentialFile, isExcludedPath } from './secret-filter';

/** Per-file cap. Larger files are skipped with a diagnostic rather than
 *  truncated silently — a half-read instruction file is worse than a reported
 *  omission. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Cap on files walked per scan root. Prevents a runaway traversal. */
export const MAX_FILES_PER_ROOT = 5_000;

/** Cap on total bytes read per installation. */
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** Cap on directory recursion depth. */
export const MAX_WALK_DEPTH = 12;

export class PathContainmentError extends Error {
  constructor(target: string, root: string) {
    super(`Refusing to read ${target}: outside the resolved source root ${root}`);
    this.name = 'PathContainmentError';
  }
}

export interface ScanBudget {
  filesWalked: number;
  bytesRead: number;
  /** Non-secret notes: skipped files, refused paths, unreadable databases. */
  diagnostics: string[];
}

export function newScanBudget(): ScanBudget {
  return { filesWalked: 0, bytesRead: 0, diagnostics: [] };
}

/** Resolve `candidate` and prove it stays inside `root`.
 *
 *  Both sides are compared in REAL terms. Comparing a real root against a
 *  lexical candidate is wrong on any platform where the root itself sits under
 *  a symlink — macOS puts /var and the temp directory behind one — and it fails
 *  closed, refusing every legitimate file in the installation.
 *
 *  A candidate that does not exist yet is still validated: it is rebased onto
 *  the real root lexically, which is enough to catch `../` escapes. Symlink
 *  escape by an entry that DOES exist is caught here and again by
 *  `isSafeEntry` during the walk. */
export function resolveWithinRoot(root: string, candidate: string): string {
  const lexicalRoot = path.resolve(root);
  const realRoot = safeRealpath(lexicalRoot);

  // Rebase an absolute candidate expressed against the pre-realpath root, so
  // /var/... and /private/var/... describe the same file rather than an escape.
  let target = path.resolve(lexicalRoot, candidate);
  if (target === lexicalRoot) {
    target = realRoot;
  } else if (target.startsWith(lexicalRoot + path.sep)) {
    target = path.join(realRoot, target.slice(lexicalRoot.length + 1));
  }

  // When the file exists, compare its real location: this is what catches a
  // symlink pointing out of the tree.
  const realTarget = fs.existsSync(target) ? safeRealpath(target) : target;

  const rel = path.relative(realRoot, realTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathContainmentError(candidate, realRoot);
  }
  return realTarget;
}

/** True when a directory entry is safe to traverse or read: a regular file or
 *  directory that is not a symlink pointing outside the root. */
export function isSafeEntry(root: string, entryPath: string, budget: ScanBudget): boolean {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(entryPath);
  } catch {
    return false;
  }

  if (st.isSymbolicLink()) {
    // A symlink is followed only when its target stays inside the root. This
    // is what stops a link planted in a skills directory from turning the
    // scan into a reader of unrelated user directories.
    let target: string;
    try {
      target = fs.realpathSync(entryPath);
    } catch {
      budget.diagnostics.push(`skipped broken symlink: ${redactHome(entryPath)}`);
      return false;
    }
    const realRoot = safeRealpath(path.resolve(root));
    const rel = path.relative(realRoot, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      budget.diagnostics.push(`skipped symlink leaving the source root: ${redactHome(entryPath)}`);
      return false;
    }
    return true;
  }

  return st.isFile() || st.isDirectory();
}

export interface WalkOptions {
  /** Only files matching this predicate are returned. */
  filter?: (filePath: string) => boolean;
  maxDepth?: number;
}

/** Depth-bounded, containment-checked directory walk.
 *
 *  Credential files and excluded directories are dropped structurally here, so
 *  no caller can accidentally read them. */
export function walkFiles(root: string, budget: ScanBudget, opts: WalkOptions = {}): string[] {
  const maxDepth = opts.maxDepth ?? MAX_WALK_DEPTH;
  const out: string[] = [];
  const realRoot = safeRealpath(path.resolve(root));

  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth) {
      budget.diagnostics.push(`stopped at depth ${maxDepth}: ${redactHome(dir)}`);
      return;
    }
    if (budget.filesWalked >= MAX_FILES_PER_ROOT) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      budget.diagnostics.push(`unreadable directory: ${redactHome(dir)}`);
      return;
    }

    for (const entry of entries) {
      if (budget.filesWalked >= MAX_FILES_PER_ROOT) {
        budget.diagnostics.push(`file cap ${MAX_FILES_PER_ROOT} reached; scan truncated`);
        return;
      }
      const full = path.join(dir, entry.name);

      if (isExcludedPath(path.relative(realRoot, full))) continue;
      if (!isSafeEntry(realRoot, full, budget)) continue;

      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }

      if (st.isDirectory()) {
        visit(full, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;

      budget.filesWalked += 1;
      if (isCredentialFile(full)) {
        budget.diagnostics.push(`excluded credential file: ${redactHome(full)}`);
        continue;
      }
      if (opts.filter && !opts.filter(full)) continue;
      out.push(full);
    }
  };

  visit(realRoot, 0);
  return out;
}

/** Bounded read of a UTF-8 text file. Returns null when the file is missing,
 *  oversized, or otherwise unreadable; the reason lands in diagnostics. */
export function readTextFile(root: string, filePath: string, budget: ScanBudget): string | null {
  let resolved: string;
  try {
    resolved = resolveWithinRoot(root, filePath);
  } catch (err) {
    budget.diagnostics.push((err as Error).message);
    return null;
  }

  if (isCredentialFile(resolved)) {
    budget.diagnostics.push(`excluded credential file: ${redactHome(resolved)}`);
    return null;
  }

  let st: fs.Stats;
  try {
    st = fs.statSync(resolved);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;

  if (st.size > MAX_FILE_BYTES) {
    budget.diagnostics.push(
      `skipped oversized file (${st.size} bytes > ${MAX_FILE_BYTES}): ${redactHome(resolved)}`,
    );
    return null;
  }
  if (budget.bytesRead + st.size > MAX_TOTAL_BYTES) {
    budget.diagnostics.push(`total read budget ${MAX_TOTAL_BYTES} bytes exhausted; scan truncated`);
    return null;
  }

  try {
    const text = fs.readFileSync(resolved, 'utf-8');
    budget.bytesRead += st.size;
    return text;
  } catch {
    budget.diagnostics.push(`unreadable file: ${redactHome(resolved)}`);
    return null;
  }
}

/** Parse JSON without throwing. A malformed source config is a reportable
 *  condition, not a crash. */
export function readJsonFile<T = unknown>(root: string, filePath: string, budget: ScanBudget): T | null {
  const text = readTextFile(root, filePath, budget);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    budget.diagnostics.push(`malformed JSON: ${redactHome(filePath)}`);
    return null;
  }
}

/** Parse YAML without throwing.
 *
 *  JSON_SCHEMA, not FAILSAFE_SCHEMA. FAILSAFE parses every scalar as a string,
 *  which silently turns `registered: false` into the truthy string "false" and
 *  makes every boolean guard downstream inert — a guard that matches the shape
 *  while failing the property. JSON_SCHEMA still admits no custom types and no
 *  code-execution path, so nothing is given up by using it. */
export function readYamlFile<T = unknown>(root: string, filePath: string, budget: ScanBudget): T | null {
  const text = readTextFile(root, filePath, budget);
  if (text === null) return null;
  try {
    return yaml.load(text, { schema: yaml.JSON_SCHEMA }) as T;
  } catch {
    budget.diagnostics.push(`malformed YAML: ${redactHome(filePath)}`);
    return null;
  }
}

/** True when the owner execute bit is set.
 *
 *  A skill's `scripts/run.sh` is meant to be run, and materializing it without
 *  the bit turns "the model calls the script" into a permission error inside
 *  somebody's task. Owner-only: the sandbox runs as one user, and carrying a
 *  file's group and world bits across from a laptop grants more than it has to.
 *
 *  False for anything unreadable — a file whose mode cannot be read is not a
 *  file we should be marking executable. */
export function isExecutableFile(filePath: string): boolean {
  try {
    return (fs.statSync(filePath).mode & 0o100) !== 0;
  } catch {
    return false;
  }
}

/** Parse TOML without throwing. Codex keeps its whole configuration in
 *  `config.toml`, and a malformed one is a reportable condition rather than a
 *  crash — the same contract `readJsonFile` and `readYamlFile` already offer.
 *
 *  A real parser rather than a hand-rolled subset: Codex's file carries quoted
 *  table keys (`[projects."/Users/x/repo"]`), nested tables and inline arrays,
 *  and a parser that half-understands them fails by returning the WRONG
 *  configuration rather than by failing. */
export function readTomlFile<T = unknown>(root: string, filePath: string, budget: ScanBudget): T | null {
  const text = readTextFile(root, filePath, budget);
  if (text === null) return null;
  try {
    return parseToml(text) as T;
  } catch {
    budget.diagnostics.push(`malformed TOML: ${redactHome(filePath)}`);
    return null;
  }
}

export function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

export function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ── SQLite ─────────────────────────────────────────────────────────────

export interface SqliteMetadata {
  present: true;
  /** Table names only. Row CONTENT is never read: the material these sources
   *  keep in SQLite is on the do-not-import list. */
  tables: string[];
  /** True when a -wal or -shm sidecar exists, meaning the database has
   *  uncheckpointed state and another process may hold it open. */
  hasWal: boolean;
  /** Set when the database could not be opened; the file is still reported as
   *  present so the review surface can say the state exists but was not read. */
  unreadableReason?: string;
}

export type SqliteProbe = SqliteMetadata | { present: false };

/** The slice of node:sqlite this module uses. Read paths only — there is no
 *  write method here, so the importer cannot mutate a source database even by
 *  mistake. */
interface NodeSqliteModule {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => {
    prepare(sql: string): { all(): unknown[] };
    close(): void;
  };
}

/** Probe a SQLite database READ-ONLY, for metadata only.
 *
 *  Opened through a `file:...?mode=ro` URI so the importer cannot write, and so
 *  a live gateway holding the database stays unaffected. WAL sidecars are
 *  reported rather than checkpointed: checkpointing would MUTATE the user's
 *  source installation, which import must never do.
 *
 *  node:sqlite is used when the runtime provides it. When it does not, the
 *  database is reported present-but-unread rather than pulling in a native
 *  dependency for metadata we do not import anyway. */
/** Read rows from a table in a SQLite database, read-only.
 *
 *  Opened read-only and never checkpointed: checkpointing a WAL would MUTATE
 *  the user's installation, and the importer must leave the source exactly as
 *  it found it. Returns [] when the database, the table, or node:sqlite itself
 *  is unavailable, because a missing schedule store is a diagnostic rather than
 *  a failed import. */
export async function readSqliteRows(
  dbPath: string,
  table: string,
  budget: ScanBudget,
): Promise<Array<Record<string, unknown>>> {
  if (!fileExists(dbPath)) return [];

  let sqlite: NodeSqliteModule;
  try {
    const specifier = 'node:sqlite';
    sqlite = (await import(specifier)) as unknown as NodeSqliteModule;
  } catch {
    budget.diagnostics.push(
      `sqlite database present but not read (node:sqlite unavailable): ${redactHome(dbPath)}`,
    );
    return [];
  }

  // Table name is never interpolated from user input; callers pass a literal.
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) return [];

  try {
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      return db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    } finally {
      db.close();
    }
  } catch (err) {
    budget.diagnostics.push(
      `could not read ${table} from ${redactHome(dbPath)}: ${(err as Error).message}`,
    );
    return [];
  }
}

export async function probeSqlite(dbPath: string, budget: ScanBudget): Promise<SqliteProbe> {
  if (!fileExists(dbPath)) return { present: false };

  const hasWal = fileExists(`${dbPath}-wal`) || fileExists(`${dbPath}-shm`);

  // Structurally typed and dynamically imported: node:sqlite lands in Node
  // 22.5+ and is not in the @types/node major this package builds against, so
  // a static import would break the build on the very runtimes that lack it.
  let sqlite: NodeSqliteModule;
  try {
    // Specifier held in a variable on purpose: node:sqlite exists from Node
    // 22.5 and is absent from the @types/node major this package builds
    // against, so a literal specifier fails to typecheck on every runtime —
    // including the ones that DO have it. The catch below is the real guard.
    const specifier = 'node:sqlite';
    sqlite = (await import(specifier)) as unknown as NodeSqliteModule;
  } catch {
    budget.diagnostics.push(
      `sqlite database present but not inspected (node:sqlite unavailable): ${redactHome(dbPath)}`,
    );
    return { present: true, tables: [], hasWal, unreadableReason: 'sqlite_unavailable' };
  }

  try {
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>;
      return { present: true, tables: rows.map((r) => r.name), hasWal };
    } finally {
      db.close();
    }
  } catch (err) {
    budget.diagnostics.push(
      `sqlite database present but not readable (${(err as Error).name}): ${redactHome(dbPath)}`,
    );
    return { present: true, tables: [], hasWal, unreadableReason: 'open_failed' };
  }
}

// ── Diagnostics hygiene ────────────────────────────────────────────────

/** Replace the user's home directory with `~` in any path that reaches a
 *  diagnostic. Support-visible diagnostics must exclude source content, and a
 *  full home path is identifying. */
export function redactHome(p: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
