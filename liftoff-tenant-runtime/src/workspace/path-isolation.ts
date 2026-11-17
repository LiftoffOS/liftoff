/**
 * R5 Fix 1: Workspace path isolation PreToolUse hook.
 *
 * Validates that native SDK tool arguments (Read/Write/Edit/Glob/Grep) cannot
 * escape the per-thread workspace directory. Addresses:
 *   - R3 SE-R3-004: path traversal via relative paths
 *   - R3 SE-R3-013: symlink escape
 *   - R4 BE-R4-007: ENOENT over-blocking legitimate new writes
 *   - R5 SE-R5-009: intermediate-component symlink TOCTOU
 *   - R5 SE-R5-003: write-path TOCTOU via openat()
 */
import { closeSync, constants as fsConstants, existsSync, lstatSync, openSync, readlinkSync, realpathSync } from 'fs';
import * as fs from 'fs';
import path from 'path';
import {
  isOpenatAvailable,
  openatNoFollow,
  O_CREAT,
  O_NOFOLLOW,
  O_WRONLY,
} from './native/openat-addon';

export class HookBlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HookBlockError';
  }
}

const MAX_PATH_LEN = 4096;

type HookCall = {
  tool_name: string;
  tool_input?: Record<string, unknown>;
};

type HookDecision =
  | { permissionDecision: 'allow' }
  | { permissionDecision: 'deny'; permissionDecisionReason: string };

/**
 * Build a PreToolUse hook scoped to a specific workspace directory.
 * The returned object conforms to the Claude Agent SDK's hook interface.
 */
export function buildPathIsolationHook(workspaceCwd: string, logger?: {
  warn: (fields: Record<string, unknown>) => void;
}) {
  const allowedRoot = path.resolve(workspaceCwd);

  function assertInsideWorkspace(resolved: string): void {
    if (resolved !== allowedRoot && !resolved.startsWith(allowedRoot + path.sep)) {
      throw new HookBlockError(`Path escapes workspace: ${resolved}`);
    }
  }

  /**
   * R5 SE-R5-009: walk parent chain component-by-component, rejecting any
   * intermediate symlink that escapes the workspace. Returns the first
   * missing component (ENOENT) so the caller can tolerate create-new-file.
   */
  function walkParentChainNoSymlinkEscape(absolutePath: string): string {
    const components = absolutePath.split(path.sep).filter(Boolean);
    let current: string = path.sep;
    for (const c of components) {
      const next: string = path.join(current, c);
      let st;
      try {
        st = lstatSync(next);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return next;
        }
        throw new HookBlockError(`Cannot lstat ${next}: ${(err as Error).message}`);
      }
      if (st.isSymbolicLink()) {
        const target = readlinkSync(next);
        const resolved: string = path.resolve(path.dirname(next), target);
        if (resolved !== allowedRoot && !resolved.startsWith(allowedRoot + path.sep)) {
          throw new HookBlockError(`Intermediate symlink escapes workspace: ${next} -> ${resolved}`);
        }
        current = resolved;
      } else if (st.isDirectory() || st.isFile()) {
        current = next;
      } else {
        throw new HookBlockError(`Non-regular component: ${next}`);
      }
    }
    return current;
  }

  function validateCommonPathShape(toolPath: unknown, label: string): string {
    if (toolPath === null || toolPath === undefined) {
      throw new HookBlockError(`${label}: missing path`);
    }
    if (typeof toolPath !== 'string') {
      throw new HookBlockError(`${label}: path must be a string`);
    }
    if (toolPath.length > MAX_PATH_LEN) {
      throw new HookBlockError(`${label}: path exceeds ${MAX_PATH_LEN} chars`);
    }
    if (toolPath.includes('\0')) {
      throw new HookBlockError(`${label}: null byte in path`);
    }
    return toolPath;
  }

  /**
   * Read path: walk parent chain; allow ENOENT on the final component if its
   * parent is inside workspace (R4 BE-R4-007 — SDK returns natural "not found").
   * Use O_NOFOLLOW on the final open to reject symlinks.
   */
  function validateReadPath(rawPath: unknown): void {
    const toolPath = validateCommonPathShape(rawPath, 'Read');
    const absolute = path.resolve(allowedRoot, toolPath);

    // Walk chain; throws if any intermediate symlink escapes
    walkParentChainNoSymlinkEscape(absolute);

    try {
      const fd = openSync(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      closeSync(fd);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // Parent was validated as in-workspace; allow SDK to report "not found"
        return;
      }
      if (code === 'ELOOP') {
        throw new HookBlockError(`Symlink on final component (O_NOFOLLOW): ${absolute}`);
      }
      throw new HookBlockError(`Cannot open: ${(err as Error).message}`);
    }

    // Canonical path must remain inside workspace.
    // Re-throw HookBlockError; swallow only realpath ENOENT/EACCES (those would
    // have been caught earlier in the chain walk anyway).
    let canonical: string;
    try {
      canonical = realpathSync.native(absolute);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EACCES') {
        return;
      }
      throw err;
    }
    assertInsideWorkspace(canonical);
  }

  /**
   * Write path: more defensive. Parent must exist AND pass chain walk.
   * On Linux with openat native addon: atomic openat(parent, basename, O_CREAT|O_NOFOLLOW)
   * closes the TOCTOU window against symlink-swap (R5 SE-R5-003).
   */
  function validateWritePath(rawPath: unknown): void {
    const toolPath = validateCommonPathShape(rawPath, 'Write/Edit');
    const absolute = path.resolve(allowedRoot, toolPath);
    const parent = path.dirname(absolute);
    const basename = path.basename(absolute);

    if (
      basename.includes('/') ||
      basename.includes(path.sep) ||
      basename === '..' ||
      basename === '.'
    ) {
      throw new HookBlockError(`Invalid filename: ${basename}`);
    }
    if (!existsSync(parent)) {
      throw new HookBlockError(`Parent does not exist: ${parent}`);
    }

    // Walk every intermediate component for symlink escape (R5 SE-R5-009)
    walkParentChainNoSymlinkEscape(parent);

    const canonicalParent = realpathSync.native(parent);
    assertInsideWorkspace(canonicalParent);

    // Reject sensitive system roots (defense in depth)
    for (const root of ['/etc', '/proc', '/sys', '/root', '/var/cache/mirrors']) {
      if (
        (absolute === root || absolute.startsWith(root + path.sep)) &&
        !absolute.startsWith(allowedRoot)
      ) {
        throw new HookBlockError(`Sensitive path blocked: ${absolute}`);
      }
    }

    // R5 SE-R5-003: atomic openat check on Linux when native addon is available.
    // On platforms without the addon (macOS dev), we rely on the chain walk
    // which is time-of-check; the primary write target remains Cloud Run Linux.
    if (isOpenatAvailable()) {
      try {
        const fd = openatNoFollow(canonicalParent, basename, O_WRONLY | O_CREAT | O_NOFOLLOW);
        // Close fd; SDK will reopen. The check is for existence-as-symlink detection.
        try {
          // Use raw close via fs.closeSync on the numeric fd
          fs.closeSync(fd);
        } catch {
          // swallow
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException & { code?: string }).code;
        if (code === 'ELOOP') {
          throw new HookBlockError(`Final component is a symlink: ${absolute}`);
        }
        if (code === 'EEXIST') {
          // File exists and is a regular file (O_CREAT + not a symlink) — that's fine
          return;
        }
        if (code === 'ENOENT') {
          // Parent vanished between check and openat — block to be safe
          throw new HookBlockError(`Parent disappeared: ${parent}`);
        }
        if (code === 'EACCES' || code === 'ENOTDIR') {
          throw new HookBlockError(`openat rejected: ${(err as Error).message}`);
        }
        // Other errors: allow SDK to surface them naturally
      }
    }
  }

  function validateGlobPattern(rawPattern: unknown): void {
    const pattern = validateCommonPathShape(rawPattern, 'Glob');
    if (pattern.startsWith('/') || pattern.startsWith('~')) {
      throw new HookBlockError(`Absolute glob not allowed: ${pattern}`);
    }
    if (pattern.includes('..')) {
      throw new HookBlockError(`Parent-traversal in glob: ${pattern}`);
    }
  }

  function runValidation(call: HookCall): HookDecision {
    try {
      const input = call.tool_input ?? {};
      switch (call.tool_name) {
        case 'Read':
          validateReadPath((input.file_path ?? input.path) as unknown);
          break;
        case 'Write':
        case 'Edit':
          validateWritePath((input.file_path ?? input.path) as unknown);
          break;
        case 'Glob':
          validateGlobPattern((input.pattern ?? input.path) as unknown);
          break;
        case 'Grep':
          if (typeof input.path === 'string') validateReadPath(input.path);
          if (typeof input.glob === 'string') validateGlobPattern(input.glob);
          break;
        default:
          // Not a path-bearing tool; allow
          break;
      }
      return { permissionDecision: 'allow' };
    } catch (err) {
      const reason = (err as Error).message;
      if (logger) {
        logger.warn({
          event: 'path_traversal_blocked',
          tool: call.tool_name,
          input: call.tool_input,
          reason,
        });
      }
      return {
        permissionDecision: 'deny',
        permissionDecisionReason: `Blocked: ${reason}`,
      };
    }
  }

  return {
    PreToolUse: async (call: HookCall): Promise<HookDecision> => runValidation(call),
    // Expose raw validators for unit tests
    _test: {
      validateReadPath,
      validateWritePath,
      validateGlobPattern,
      walkParentChainNoSymlinkEscape,
    },
  };
}
