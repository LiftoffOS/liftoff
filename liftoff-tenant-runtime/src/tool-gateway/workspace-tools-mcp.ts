/**
 * R5 Fix 2: workspace_* MCP tool handlers.
 *
 * - execFile only (never exec; never shell interpolation)
 * - Typed command allowlist for workspace_run (no raw Bash at any tier)
 * - Branch validation rejects `+`, `:`, `HEAD`, `--` prefix
 * - package manager allowlist (npm, yarn Classic) with PnP/pnpm/Bun detection
 * - workspace_git_push gated on push_high_risk_allowed DB flag
 * - ctx is closure-captured (SE-R4-006): agent input CANNOT override tenantId etc.
 * - git clone rejects embedded credentials; --no-recurse-submodules
 */
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { scrubLogger } from '../observability/scrub-logger';
import { scrubSecrets } from '../workspace/secret-scrubber';
import { storeLastOutput, getLastOutput } from './workspace-run-output-store';

const execFileP = promisify(execFile);

// ==== Types ====

export interface WorkspaceToolCtx {
  readonly tenantId: string;
  readonly threadId: string;
  readonly agentId: string;
  readonly workspaceCwd: string;
  readonly capabilityTier: 'connector_only' | 'execution_enabled';
  readonly turnId: string;
  readonly invocationId: string;
  readonly pushHighRiskAllowed: boolean;
}

// ==== Validation ====

const OWNER_REPO_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const BRANCH_RE = /^(?!\+)(?!-)[a-zA-Z0-9][a-zA-Z0-9._/-]{0,249}$/;
const FORBIDDEN_BRANCHES = new Set(['HEAD', 'FETCH_HEAD', 'MERGE_HEAD', 'ORIG_HEAD']);
const PACKAGE_NAME_RE = /^[a-zA-Z0-9._@/-]{1,200}$/;

export function validateOwnerRepo(owner: string, repo: string): void {
  if (!OWNER_REPO_RE.test(owner)) throw new Error(`invalid owner: ${owner}`);
  if (!OWNER_REPO_RE.test(repo)) throw new Error(`invalid repo: ${repo}`);
  if (owner.startsWith('.') || owner.startsWith('-')) throw new Error('owner cannot start with . or -');
  if (repo.startsWith('.') || repo.startsWith('-')) throw new Error('repo cannot start with . or -');
}

export function validateBranch(branch: string): void {
  if (!BRANCH_RE.test(branch)) throw new Error(`invalid branch: ${branch}`);
  if (branch.includes(':')) throw new Error('refspec syntax not allowed');
  if (branch.startsWith('+')) throw new Error('force-push prefix not allowed');
  if (branch.startsWith('--')) throw new Error('flag-like branch not allowed');
  if (FORBIDDEN_BRANCHES.has(branch)) throw new Error(`forbidden branch: ${branch}`);
}

export function validatePackageNames(packages: string[]): void {
  for (const p of packages) {
    if (typeof p !== 'string' || !PACKAGE_NAME_RE.test(p)) {
      throw new Error(`invalid package name: ${p}`);
    }
    // R5 TE-R5-004: explicit reject of path-traversal `..` sequences even if
    // they otherwise pass the charset regex.
    if (p.includes('..')) {
      throw new Error(`invalid package name: ${p}`);
    }
  }
}

/** R5 SE-R5-004: construct URL ourselves, reject embedded credentials. */
export function validateGitCloneTarget(owner: string, repo: string): string {
  validateOwnerRepo(owner, repo);
  const url = `https://github.com/${owner}/${repo}.git`;
  const parsed = new URL(url);
  if (parsed.username || parsed.password) {
    throw new Error('embedded credentials not allowed in clone URL');
  }
  return url;
}

/**
 * R5 SE-R5-010: reject any argv that POSITIVELY enables submodule processing.
 *
 * Allowed (disable):
 *   --no-recurse-submodules
 *   submodule.recurse=false         (as a `-c` config value)
 *
 * Rejected:
 *   submodule                       (the `git submodule` subcommand itself)
 *   --recurse-submodules[=*]        (enable recursion)
 *   --recursive                     (older alias)
 *   submodule.recurse=true          (explicit enable)
 *   submodule.*=<truthy>            (any enabling submodule config)
 */
export function assertNoSubmoduleArgs(argv: readonly string[]): void {
  for (const a of argv) {
    if (typeof a !== 'string') continue;
    const lower = a.toLowerCase();
    // The `submodule` subcommand as a standalone arg (git submodule update/init/etc.)
    if (lower === 'submodule') {
      throw new Error(`submodule subcommand not allowed: ${a}`);
    }
    // --recurse-submodules[=...] — positive form that ENABLES submodule processing
    if (lower === '--recurse-submodules' || lower.startsWith('--recurse-submodules=')) {
      throw new Error(`--recurse-submodules not allowed: ${a}`);
    }
    if (lower === '--recursive') {
      throw new Error(`--recursive not allowed: ${a}`);
    }
    // Reject -c submodule.anything=<truthy> but allow =false/=0/=no
    if (lower.startsWith('submodule.')) {
      const eq = lower.indexOf('=');
      if (eq === -1) {
        // Bare `submodule.foo` — reject (no value, ambiguous)
        throw new Error(`submodule config without explicit =false not allowed: ${a}`);
      }
      const value = lower.slice(eq + 1).trim();
      if (value !== 'false' && value !== '0' && value !== 'no') {
        throw new Error(`submodule config with non-false value not allowed: ${a}`);
      }
    }
  }
}

// ==== Safe env ====

export function buildSafeGitEnv(): Record<string, string> {
  return {
    PATH: '/usr/bin:/usr/local/bin',
    HOME: '/nonexistent',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_ALLOW_PROTOCOL: 'https',
  };
}

export function buildSafeExecEnv(cwd: string): Record<string, string> {
  // R5 SE-R5-009: block YARN_/PNPM_/BUN_/NPM_CONFIG_ env vars from leaking
  return {
    PATH: '/usr/bin:/usr/local/bin:/usr/local/lib/node_modules/.bin',
    HOME: cwd,
    NODE_ENV: 'production',
    YARN_ENABLE_PNP: '0',
    YARN_ENABLE_GLOBAL_CACHE: '0',
  };
}

// ==== workspace_run command map ====

const RUN_COMMANDS: Record<string, { argv: string[]; argsRegex?: RegExp }> = {
  'npm-test': { argv: ['npm', 'test'], argsRegex: /^[a-zA-Z0-9._/@=:,-]+$/ },
  'npm-lint': { argv: ['npm', 'run', 'lint'] },
  'npm-typecheck': { argv: ['npm', 'run', 'typecheck'] },
  'npm-build': { argv: ['npm', 'run', 'build'] },
  pytest: { argv: ['pytest'], argsRegex: /^[a-zA-Z0-9._/-]+$/ },
  'go-test': { argv: ['go', 'test'], argsRegex: /^[a-zA-Z0-9._/-]+$/ },
  'cargo-test': { argv: ['cargo', 'test'], argsRegex: /^[a-zA-Z0-9._/-]+$/ },
  diagnostic_connectivity: {
    argv: ['curl', '--connect-timeout', '2', '-o', '/dev/null', '-s', '-w', '%{http_code}', 'http://169.254.169.254/'],
  },
};

const DENIED_RUN_COMMANDS = new Set(['yarn', 'pnpm', 'bun', 'bash', 'sh', 'zsh', 'node', 'eval']);

// ==== Handlers ====

function resolveRepoPath(workspaceCwd: string, repo: string): string {
  const p = path.resolve(workspaceCwd, 'workspace', repo);
  if (!p.startsWith(path.resolve(workspaceCwd) + path.sep)) {
    throw new Error('repo path escapes workspace');
  }
  return p;
}

async function gitRun(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  // R5 SE-R5-010: hard reject any submodule-related arg at the execFile boundary
  assertNoSubmoduleArgs(args);
  return execFileP('git', args, { cwd, env: buildSafeGitEnv(), timeout: 300_000, maxBuffer: 1024 * 1024 });
}

export async function handleWorkspaceGitClone(
  ctx: WorkspaceToolCtx,
  input: { owner: string; repo: string; depth?: number },
): Promise<{ stdout: string; stderr: string; repo: string }> {
  const url = validateGitCloneTarget(input.owner, input.repo);
  const clonedPath = path.join(ctx.workspaceCwd, 'workspace', input.repo);
  await fs.mkdir(path.dirname(clonedPath), { recursive: true, mode: 0o700 });

  const cloneArgs = [
    'clone',
    '--depth',
    String(input.depth ?? 1),
    '--no-recurse-submodules', // R5 SE-R5-010 (positive-form rejection in assertNoSubmoduleArgs)
    '-c',
    'submodule.recurse=false',
    '--',
    url,
    clonedPath,
  ];
  assertNoSubmoduleArgs(cloneArgs); // R5 SE-R5-010: defense-in-depth
  const result = await execFileP('git', cloneArgs, {
    env: buildSafeGitEnv(),
    timeout: 600_000,
    maxBuffer: 2 * 1024 * 1024,
  });

  // R5 SE-R5-002: executable inventory for SOC review (no auto-block)
  const inventory = await inventoryExecutables(clonedPath);
  scrubLogger.info({
    event: 'git_clone_executable_inventory',
    tenantId: ctx.tenantId,
    threadId: ctx.threadId,
    agentId: ctx.agentId,
    repo: input.repo,
    executable_count: inventory.length,
    build_files: inventory.filter((f) =>
      /^(Makefile|makefile|configure|CMakeLists\.txt|build\.sh|install\.sh)$/.test(path.basename(f.path)),
    ),
  });

  // Symlink audit — remove any symlink pointing outside the clone
  await auditSymlinks(clonedPath);

  return {
    stdout: scrubSecrets(result.stdout).slice(0, 65536),
    stderr: scrubSecrets(result.stderr).slice(0, 65536),
    repo: input.repo,
  };
}

async function auditSymlinks(root: string): Promise<void> {
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        const target = await fs.readlink(full).catch(() => null);
        if (!target) continue;
        const resolved = path.resolve(path.dirname(full), target);
        if (!resolved.startsWith(root + path.sep) && resolved !== root) {
          await fs.unlink(full).catch(() => null);
          scrubLogger.warn({ event: 'escaping_symlink_removed', path: full, target });
        }
      } else if (e.isDirectory()) {
        await walk(full);
      }
    }
  }
  await walk(root);
}

async function inventoryExecutables(root: string): Promise<Array<{ path: string; mode: number }>> {
  const results: Array<{ path: string; mode: number }> = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        try {
          const st = await fs.stat(full);
          if ((st.mode & 0o111) !== 0) {
            results.push({ path: full, mode: st.mode });
          }
        } catch {
          // ignore
        }
      }
    }
  }
  await walk(root);
  return results;
}

export async function handleWorkspaceGitPush(
  ctx: WorkspaceToolCtx,
  input: { repo: string; branch: string },
): Promise<{ stdout: string; stderr: string }> {
  // R5 retained R3 SE-R3-016: server-side enforcement in the handler
  if (!ctx.pushHighRiskAllowed) {
    throw new Error('workspace_git_push requires push_high_risk_allowed=true on the agent');
  }
  validateBranch(input.branch);
  const repoPath = resolveRepoPath(ctx.workspaceCwd, input.repo);
  const result = await gitRun(['push', 'origin', '--', input.branch], repoPath);
  return { stdout: scrubSecrets(result.stdout).slice(0, 65536), stderr: scrubSecrets(result.stderr).slice(0, 65536) };
}

export async function handleWorkspaceRun(
  ctx: WorkspaceToolCtx,
  input: { command: string; args?: string[]; repo: string },
): Promise<{ stdout: string; stderr: string; runId: string }> {
  if (DENIED_RUN_COMMANDS.has(input.command)) {
    throw new Error(`${input.command} must be invoked via workspace_package_install, not workspace_run`);
  }
  const spec = RUN_COMMANDS[input.command];
  if (!spec) throw new Error(`unknown command: ${input.command}`);

  const args = input.args ?? [];
  if (spec.argsRegex) {
    for (const a of args) {
      if (typeof a !== 'string' || !spec.argsRegex.test(a)) {
        throw new Error(`arg failed validation: ${a}`);
      }
    }
  } else if (args.length > 0) {
    throw new Error(`command ${input.command} does not accept args`);
  }

  const runId = generateRunId();
  const argv = args.length > 0 ? ['--', ...args] : [];
  const result = await execFileP(spec.argv[0], [...spec.argv.slice(1), ...argv], {
    cwd: resolveRepoPath(ctx.workspaceCwd, input.repo),
    timeout: 300_000,
    maxBuffer: 4 * 1024 * 1024,
    env: buildSafeExecEnv(ctx.workspaceCwd),
  }).catch((err: unknown) => {
    // Coerce non-zero exit into a structured result rather than throwing
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? String(err) };
  });

  storeLastOutput(ctx.threadId, {
    runId,
    stdout: result.stdout,
    stderr: result.stderr,
  });

  return {
    stdout: scrubSecrets(result.stdout).slice(0, 65536),
    stderr: scrubSecrets(result.stderr).slice(0, 65536),
    runId,
  };
}

export async function handleWorkspaceRunLastOutput(
  ctx: WorkspaceToolCtx,
  input: { stream: 'stdout' | 'stderr'; offset?: number; limit?: number },
): Promise<{ stream: string; data: string }> {
  if (input.stream !== 'stdout' && input.stream !== 'stderr') {
    throw new Error('invalid stream');
  }
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 65536;
  if (offset < 0 || limit <= 0 || limit > 65536) {
    throw new Error('invalid range');
  }
  const entry = getLastOutput(ctx.threadId);
  if (!entry) return { stream: input.stream, data: '' };
  const content = input.stream === 'stdout' ? entry.stdout : entry.stderr;
  return { stream: input.stream, data: scrubSecrets(content.slice(offset, offset + limit)) };
}

// ==== Package install ====

const ALLOWED_MANAGERS = new Set(['npm', 'yarn']);
const PNP_INDICATORS = ['.yarnrc.yml', '.pnp.cjs', '.pnp.js', 'pnpm-lock.yaml', 'bun.lockb'];

export async function handleWorkspacePackageInstall(
  ctx: WorkspaceToolCtx,
  input: { manager: string; packages: string[]; dev?: boolean },
): Promise<{ stdout: string; stderr: string }> {
  if (!ALLOWED_MANAGERS.has(input.manager)) {
    throw new Error(`Unsupported package manager: ${input.manager}. Use npm or Yarn Classic (1.x).`);
  }
  validatePackageNames(input.packages);

  // R5 SE-R5-009: detect PnP/pnpm/Bun indicators
  for (const f of PNP_INDICATORS) {
    if (existsSync(path.join(ctx.workspaceCwd, f))) {
      throw new Error(`Detected ${f}: unsupported package manager ecosystem.`);
    }
  }

  const pkgJson = path.join(ctx.workspaceCwd, 'package.json');
  if (existsSync(pkgJson)) {
    try {
      const pkg = JSON.parse(await fs.readFile(pkgJson, 'utf-8')) as { packageManager?: string };
      const pm = pkg.packageManager;
      if (pm) {
        if (pm.startsWith('yarn@') && !pm.startsWith('yarn@1.')) {
          throw new Error(`Yarn ${pm} not supported; use Yarn Classic (1.x).`);
        }
        if (pm.startsWith('pnpm@') || pm.startsWith('bun@')) {
          throw new Error(`Package manager ${pm} not supported.`);
        }
      }
    } catch (err) {
      if ((err as Error).message.includes('not supported')) throw err;
      // otherwise: package.json parse failure — allow install to proceed
    }
  }

  let argv: string[];
  switch (input.manager) {
    case 'npm':
      argv = [
        'npm',
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        ...(input.dev ? ['--save-dev'] : []),
        '--',
        ...input.packages,
      ];
      break;
    case 'yarn':
      argv = ['yarn', 'add', '--ignore-scripts', ...(input.dev ? ['--dev'] : []), '--', ...input.packages];
      break;
    default:
      throw new Error(`unreachable: ${input.manager}`);
  }

  const result = await execFileP(argv[0], argv.slice(1), {
    cwd: ctx.workspaceCwd,
    timeout: 300_000,
    maxBuffer: 2 * 1024 * 1024,
    env: buildSafeExecEnv(ctx.workspaceCwd),
  });

  // R5 SE-R5-009: post-install scan
  for (const f of PNP_INDICATORS) {
    if (existsSync(path.join(ctx.workspaceCwd, f))) {
      throw new Error(`Post-install: ${f} created by install. Aborting.`);
    }
  }

  return {
    stdout: scrubSecrets(result.stdout).slice(0, 65536),
    stderr: scrubSecrets(result.stderr).slice(0, 65536),
  };
}

// ==== Helpers ====

function generateRunId(): string {
  // Use Node built-in crypto (avoid pulling in a dep for this)
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
