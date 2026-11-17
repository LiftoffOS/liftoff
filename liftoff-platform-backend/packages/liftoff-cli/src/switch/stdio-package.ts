// Liftoff Switch — what published package a local stdio command runs.
//
// An imported stdio MCP server is a command line: `npx -y @acme/mcp-server`.
// That command names a package, and the package is the only durable identity
// the server has — the path, the flags and the shell around it are local
// detail.
//
// This module extracts that identity and stops. It does not decide what the
// package MEANS: resolution needs the official MCP registry, and a lookup baked
// into a shipped CLI would answer from whatever the ecosystem looked like on
// the day that version was built and would then be frozen into every installed
// copy. The server resolves the identity live.
//
// Conservative on purpose. Everything downstream compares package identities
// for EQUALITY, so a wrong identity is worse than none: it resolves the user's
// server to somebody else's, and the review screen then offers to connect a
// capability they never had. Anything not recognised returns null and keeps the
// Requires hosting card it already had.

import type { McpPackageIdentity, McpPackageRegistryType } from './contract';

/** Flags that take no value, skipped while looking for the package argument. */
const VALUELESS_RUNNER_FLAGS = new Set([
  '-y',
  '--yes',
  '-q',
  '--quiet',
  '--silent',
  '-s',
  '--no-install',
  '--prefer-offline',
  '--ignore-existing',
]);

/** Flags that consume the NEXT argument, so the value is not mistaken for the
 *  package. */
const VALUE_RUNNER_FLAGS = new Set([
  '-p',
  '--package',
  '-c',
  '--call',
  '--registry',
  '--cache',
  '--userconfig',
  '--from',
  '--with',
  '--python',
  '--index',
  '--index-url',
]);

/** Docker/podman flags that consume the next argument. Only the ones that
 *  actually appear in MCP configurations; an unknown value-taking flag makes
 *  the parse ambiguous, and an ambiguous parse returns null. */
const DOCKER_VALUE_FLAGS = new Set([
  '-e',
  '--env',
  '--env-file',
  '-v',
  '--volume',
  '--mount',
  '--name',
  '--network',
  '-w',
  '--workdir',
  '-u',
  '--user',
  '-p',
  '--publish',
  '--label',
  '-l',
  '--entrypoint',
  '--platform',
  '--add-host',
]);

const DOCKER_VALUELESS_FLAGS = new Set([
  '-i',
  '--interactive',
  '-t',
  '--tty',
  '-it',
  '-ti',
  '--rm',
  '-d',
  '--detach',
  '--init',
  '--read-only',
  '--privileged',
]);

/** Extract the published package a stdio command runs.
 *
 *  Returns null for a command that names no package — someone's in-house
 *  script, a bare binary on their PATH, an interpreter pointed at a local file.
 *  Those genuinely have no identity outside that machine, and the honest
 *  outcome is the hosting card, not a guess. */
export function parseStdioPackage(
  command: string | undefined,
  args: string[] | undefined,
): McpPackageIdentity | null {
  if (!command) return null;

  const runner = basename(command);
  const argv = (args ?? []).map((a) => String(a));

  switch (runner) {
    case 'npx':
    case 'bunx':
      return npmIdentity(firstNonFlag(argv, VALUELESS_RUNNER_FLAGS, VALUE_RUNNER_FLAGS));

    case 'pnpm':
    case 'yarn':
    case 'bun':
      // `pnpm dlx <pkg>`, `yarn dlx <pkg>`, `bun x <pkg>`.
      if (argv.length === 0) return null;
      if (argv[0] !== 'dlx' && argv[0] !== 'x') return null;
      return npmIdentity(firstNonFlag(argv.slice(1), VALUELESS_RUNNER_FLAGS, VALUE_RUNNER_FLAGS));

    case 'uvx':
      return pypiIdentity(firstNonFlag(argv, VALUELESS_RUNNER_FLAGS, VALUE_RUNNER_FLAGS));

    case 'uv':
      // `uv tool run <pkg>`, `uv run <pkg>` — only the tool form names a
      // published package; `uv run` commonly runs a local script.
      if (argv[0] !== 'tool' || argv[1] !== 'run') return null;
      return pypiIdentity(firstNonFlag(argv.slice(2), VALUELESS_RUNNER_FLAGS, VALUE_RUNNER_FLAGS));

    case 'pipx':
      if (argv[0] !== 'run') return null;
      return pypiIdentity(firstNonFlag(argv.slice(1), VALUELESS_RUNNER_FLAGS, VALUE_RUNNER_FLAGS));

    case 'docker':
    case 'podman':
      if (argv[0] !== 'run') return null;
      return ociIdentity(dockerImage(argv.slice(1)));

    default:
      // A direct binary. It names something on that machine's PATH, and which
      // package installed it — or whether a package did at all — is not
      // knowable from here. Emitting a guessed registry would produce an
      // identity that compares equal to somebody else's package.
      return null;
  }
}

/** The first argument that is not a flag or a flag's value. */
function firstNonFlag(
  argv: string[],
  valueless: ReadonlySet<string>,
  takesValue: ReadonlySet<string>,
): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      return argv[i + 1] ?? null;
    }
    if (!arg.startsWith('-')) return arg;
    if (arg.includes('=')) continue;
    if (valueless.has(arg)) continue;
    if (takesValue.has(arg)) {
      i += 1;
      continue;
    }
    // An unrecognised flag may or may not consume the next argument, so the
    // position of the package is no longer known.
    return null;
  }
  return null;
}

/** The image argument of a `docker run`. */
function dockerImage(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') return argv[i + 1] ?? null;
    if (!arg.startsWith('-')) return arg;
    if (arg.includes('=')) continue;
    if (DOCKER_VALUELESS_FLAGS.has(arg)) continue;
    if (DOCKER_VALUE_FLAGS.has(arg)) {
      i += 1;
      continue;
    }
    return null;
  }
  return null;
}

function npmIdentity(spec: string | null): McpPackageIdentity | null {
  if (!spec) return null;
  // A local path or a URL is not a published package.
  if (spec.startsWith('.') || spec.startsWith('/') || spec.includes('://')) return null;
  const name = stripNpmVersion(spec);
  return validName(name) ? { registryType: 'npm', name } : null;
}

function pypiIdentity(spec: string | null): McpPackageIdentity | null {
  if (!spec) return null;
  if (spec.startsWith('.') || spec.startsWith('/') || spec.includes('://')) return null;
  // PEP 508 version specifiers: `pkg==1.2.3`, `pkg>=1.0`, `pkg[extra]`.
  const name = spec.split(/[[<>=!~;]/)[0].trim();
  return validName(name) ? { registryType: 'pypi', name } : null;
}

function ociIdentity(image: string | null): McpPackageIdentity | null {
  if (!image) return null;
  if (image.startsWith('.') || image.startsWith('/')) return null;
  // The tag is kept as written. Comparison on the server side normalizes it
  // away, because a tag is a version and the identity is the image.
  return validName(image) ? { registryType: 'oci', name: image } : null;
}

/** Drop an npm version suffix without mistaking a scope for one:
 *  `@scope/pkg@1.2.3` → `@scope/pkg`, `pkg@1.2.3` → `pkg`. */
function stripNpmVersion(spec: string): string {
  const at = spec.lastIndexOf('@');
  if (at <= 0) return spec;
  return spec.slice(0, at);
}

function validName(name: string): boolean {
  if (name.length === 0 || name.length > 512) return false;
  // Shell metacharacters mean this was never a bare package argument.
  return !/[\s"'`$;&|<>()]/.test(name);
}

function basename(command: string): string {
  const cleaned = command.trim().replace(/\\/g, '/');
  const last = cleaned.split('/').pop() ?? cleaned;
  // `node.exe`, `npx.cmd`.
  return last.replace(/\.(exe|cmd|bat)$/i, '');
}

/** Exposed so the registry type union stays one definition. */
export type { McpPackageRegistryType };
