// Liftoff Switch — how a directory of files becomes a list of skills.
//
// Shared by every adapter, because the layout it handles is shared: the
// SKILL.md convention (a directory per skill, holding SKILL.md plus support
// directories) is what OpenClaw, Hermes, Claude Code and Codex all write.
//
// Two rules, and both exist because naming a skill after its FILE gets this
// wrong in opposite directions:
//
//   * A skill laid out as `<name>/SKILL.md` is named for its DIRECTORY. Naming
//     it for the file calls every skill in the installation `SKILL`, and a
//     name-keyed dedupe then keeps exactly one of them.
//   * A `.md` inside a support directory is part of its skill, not a skill.
//     Naming it for its parent directory mints a skill called `references`
//     whose body is one page of somebody's API notes.
//
// A flat `<name>.md` directly under a skill root is still a skill named for the
// file: that is the legacy layout, and both products still read it.
//
// Support files are appended to the skill body under the same path-labelled
// boundary the normalizer packs attachments with, so the model can tell where
// one file ends and the next begins, and a support case can find the file.

import path from 'path';
import { isExecutableFile, readTextFile, type ScanBudget } from '../filesystem';
import { redactText } from '../secret-filter';

/** Conventional support directories inside a skill. Anything under one of
 *  these belongs to the skill above it and is never a skill of its own. */
export const SKILL_SUPPORT_DIRS: ReadonlySet<string> = new Set([
  'references',
  'scripts',
  'examples',
  'assets',
]);

export const SKILL_INDEX_FILENAME = 'SKILL.md';

/** One skill, and the files that make it up. */
export interface SkillGroup {
  /** Derived name: the directory for a `SKILL.md` layout, the file stem for a
   *  flat one. */
  name: string;
  /** The file the skill body comes from. */
  primaryPath: string;
  /** Support files belonging to this skill, sorted for run-to-run stability. */
  supportPaths: string[];
}

/** Group walked files into skills.
 *
 *  `legacyName` decides what to call a file that is neither a `SKILL.md` nor a
 *  support file — the flat layout each adapter already had its own rule for.
 *  Passing it in keeps this function from silently changing a naming decision
 *  that predates it.
 *
 *  Order follows `files`, so a re-run of the same installation produces the
 *  same bundle. */
export function groupSkillFiles(
  skillRoot: string,
  files: string[],
  legacyName: (filePath: string) => string,
): SkillGroup[] {
  // Directories that hold a SKILL.md. A support file is only a support file
  // when there is a skill above it to belong to: Hermes deliberately keeps a
  // bare `skills/scripts/foo` discoverable as a skill of its own, and reading
  // that as somebody's support directory would drop it.
  const skillDirs = new Set<string>();
  for (const file of files) {
    if (path.basename(file) === SKILL_INDEX_FILENAME) skillDirs.add(path.dirname(file));
  }

  const groups = new Map<string, SkillGroup>();
  const support = new Map<string, string[]>();

  for (const file of files) {
    const owningDir = findOwningSkillDir(skillRoot, file, skillDirs);
    if (owningDir !== null) {
      const list = support.get(owningDir);
      if (list) list.push(file);
      else support.set(owningDir, [file]);
      continue;
    }

    const isIndex = path.basename(file) === SKILL_INDEX_FILENAME;

    // Only a markdown file can BE a skill. Anything else sitting inside a skill
    // directory is one of that skill's files — a script, a template, a licence
    // — and promoting it would mint a skill whose body is a shell script.
    if (!isIndex && !file.toLowerCase().endsWith('.md')) {
      const owner = path.dirname(file);
      if (skillDirs.has(owner)) {
        const list = support.get(owner);
        if (list) list.push(file);
        else support.set(owner, [file]);
      }
      continue;
    }

    const name = isIndex ? path.basename(path.dirname(file)) : legacyName(file);
    const key = isIndex ? path.dirname(file) : file;
    if (groups.has(key)) continue;
    groups.set(key, { name, primaryPath: file, supportPaths: [] });
  }

  for (const [dir, paths] of support) {
    const group = groups.get(dir);
    // A support directory whose SKILL.md was skipped (oversized, unreadable,
    // outside the root) leaves its files with nothing to attach to. They are
    // dropped rather than promoted: half a skill presented as a whole one is
    // the failure this function exists to prevent.
    if (!group) continue;
    group.supportPaths = [...paths].sort();
  }

  return [...groups.values()];
}

/** The skill directory a support file belongs to, or null when the file is not
 *  inside a support directory of a skill.
 *
 *  Walks upward from the file and stops at the skill root, so a support-dir
 *  name appearing somewhere above the root cannot capture a file. */
function findOwningSkillDir(
  skillRoot: string,
  file: string,
  skillDirs: ReadonlySet<string>,
): string | null {
  const root = path.resolve(skillRoot);
  let dir = path.dirname(file);

  while (dir !== root && dir !== path.dirname(dir)) {
    const parent = path.dirname(dir);
    if (SKILL_SUPPORT_DIRS.has(path.basename(dir)) && skillDirs.has(parent)) return parent;
    dir = parent;
  }

  return null;
}

/** Extensions carried as skill files. Everything else is treated as binary.
 *
 *  An allow-list rather than a deny-list: the secret filter reads TEXT, and a
 *  file it cannot scan must not travel from a customer's machine into shared
 *  storage. Guessing "probably text" on an unknown extension is exactly the
 *  guess that would carry the one file nobody could scan. */
const TEXT_FILE_EXTENSIONS = new Set([
  '.md', '.txt', '.rst', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.env',
  '.py', '.sh', '.bash', '.zsh', '.fish', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.php', '.pl', '.lua', '.r',
  '.sql', '.csv', '.tsv', '.html', '.htm', '.css', '.scss', '.xml', '.svg',
  '.gitignore', '.editorconfig', '.lobster',
]);

export function isTextSkillFile(filePath: string): boolean {
  const base = path.basename(filePath);
  const ext = path.extname(base).toLowerCase();
  if (ext === '') {
    // Extensionless files are conventional metadata (LICENSE, README) or a
    // compiled binary. Only the known names are carried.
    return ['LICENSE', 'LICENCE', 'README', 'NOTICE', 'AUTHORS'].includes(base.toUpperCase());
  }
  return TEXT_FILE_EXTENSIONS.has(ext);
}

export interface SkillFile {
  /** Path relative to the skill's own root, as the author wrote it. */
  path: string;
  text: string;
  executable?: boolean;
}

export interface SkillFileSet {
  files: SkillFile[];
  /** Relative paths refused for being unscannable, reported per file. */
  binaries: string[];
}

/** The skill's own files, as the bundle carries them.
 *
 *  The primary body is NOT included — it is the skill's instruction text and
 *  already travels as `content`. What lands here is `scripts/`, `references/`
 *  and the rest: the things the instruction text tells the agent to use. */
export function readSkillFileSet(
  skillRoot: string,
  group: SkillGroup,
  budget: ScanBudget,
): SkillFileSet {
  // Paths are relative to the directory the skill's own body sits in, which is
  // how its author wrote them: a SKILL.md referring to `scripts/run.py` means
  // the one beside it.
  const skillDir = path.dirname(group.primaryPath);

  const files: SkillFile[] = [];
  const binaries: string[] = [];

  for (const supportPath of group.supportPaths) {
    const relative = path.relative(skillDir, supportPath);
    if (!isTextSkillFile(supportPath)) {
      binaries.push(relative);
      continue;
    }
    const raw = readTextFile(skillRoot, supportPath, budget);
    if (raw === null) continue;
    files.push({
      path: relative,
      text: redactText(raw).text,
      // Carried from the source file's own mode. A script materialized without
      // it fails on first use with a permission error, inside somebody's task.
      ...(isExecutableFile(supportPath) ? { executable: true } : {}),
    });
  }

  return { files, binaries };
}

/** Environment variable names a skill declares it needs.
 *
 *  Read STRUCTURALLY from the SKILL.md frontmatter, not guessed at from prose:
 *  OpenClaw writes `"requires": { "env": [...] }` and `"primaryEnv"` inside its
 *  `metadata.openclaw` block, so the names are stated rather than inferred.
 *
 *  Names only. The VALUE stays on the user's machine — it is re-entered into
 *  the workspace locker on our side, the same rule the MCP header names follow:
 *  carry the requirement, never the credential. */
export function declaredSecretNames(text: string): string[] {
  const out = new Set<string>();

  // `"env": ["A", "B"]` anywhere in the frontmatter block.
  for (const match of text.matchAll(/"env"\s*:\s*\[([^\]]*)\]/g)) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().replace(/^["']|["']$/g, '');
      if (isEnvVarName(name)) out.add(name);
    }
  }

  // `"primaryEnv": "NAME"`.
  for (const match of text.matchAll(/"primaryEnv"\s*:\s*"([^"]+)"/g)) {
    if (isEnvVarName(match[1])) out.add(match[1]);
  }

  return [...out].sort();
}

/** Binaries a skill declares it needs on the machine running it.
 *
 *  Carried as a NOTE rather than a requirement: these are things like `op` or
 *  an AppleScript bridge, which exist on the author's laptop and not in a cloud
 *  sandbox. A skill that silently imports without them is a capability the
 *  workspace believes it has and does not. */
export function declaredBinaries(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/"bins"\s*:\s*\[([^\]]*)\]/g)) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().replace(/^["']|["']$/g, '');
      if (name.length > 0 && name.length < 128) out.add(name);
    }
  }
  return [...out].sort();
}

function isEnvVarName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name);
}

/** Read a skill's BODY: the primary file, redacted.
 *
 *  Support files are deliberately NOT concatenated here. They travel as the
 *  skill's files (`readSkillFileSet`), which is where a script belongs — it is
 *  something the agent runs, not something it reads in its prompt. Inlining
 *  them as well would send every byte twice: once in the instruction text a
 *  distill pays for, and once as the file itself.
 *
 *  Returns null when the primary file cannot be read, because a skill with no
 *  body is not a skill. */
export function readSkillGroupText(
  skillRoot: string,
  group: SkillGroup,
  budget: ScanBudget,
): string | null {
  const primary = readTextFile(skillRoot, group.primaryPath, budget);
  if (primary === null) return null;
  return redactText(primary).text;
}
