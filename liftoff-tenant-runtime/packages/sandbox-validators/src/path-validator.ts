// Sandbox Path Validator
// Enforces /workspace chroot for all file operations.
// Resolved: SE-008 — path traversal via file_read/file_write without validation.

import * as path from 'path';

const WORKSPACE_ROOT = '/workspace';

// Files that must never be staged for git commit
const SECRET_FILE_PATTERNS = [
  /\.env$/i,
  /\.env\..+$/i,
  /\.key$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^credentials/i,
  /^secrets/i,
  /\.secret$/i,
  /^\.gcloud\//,
  /^\.aws\//,
  /^\.ssh\//,
  /^\.docker\/config\.json$/,
  /^\.npmrc$/,
  /^\.pypirc$/,
];

// Branch name validation: only safe characters
const BRANCH_NAME_PATTERN = /^[a-zA-Z0-9/_.-]+$/;

// Max commit message length
const MAX_COMMIT_MESSAGE_LENGTH = 500;

/**
 * Validates and resolves a user-provided path to be under /workspace.
 * Throws on path traversal attempts.
 */
export function validateWorkspacePath(userPath: string | undefined): string {
  if (!userPath) return WORKSPACE_ROOT;

  if (userPath.includes('..')) {
    throw new PathTraversalError(userPath, 'Path must not contain ".." components');
  }

  const resolved = path.resolve(WORKSPACE_ROOT, userPath);

  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(WORKSPACE_ROOT + '/')) {
    throw new PathTraversalError(userPath, `Resolved path "${resolved}" is outside workspace`);
  }

  return resolved;
}

export function validateBranchName(branch: string): void {
  if (!branch || branch.length === 0) {
    throw new ValidationError('Branch name is required');
  }
  if (branch.length > 200) {
    throw new ValidationError('Branch name too long (max 200 characters)');
  }
  if (!BRANCH_NAME_PATTERN.test(branch)) {
    throw new ValidationError(
      `Branch name contains invalid characters. Must match: ${BRANCH_NAME_PATTERN.source}`,
    );
  }
  if (branch.startsWith('-') || branch.includes('..') || branch.includes('@{')) {
    throw new ValidationError('Branch name contains dangerous git patterns');
  }
}

export function validateCommitMessage(message: string): void {
  if (!message || message.length === 0) {
    throw new ValidationError('Commit message is required');
  }
  if (message.length > MAX_COMMIT_MESSAGE_LENGTH) {
    throw new ValidationError(`Commit message too long (max ${MAX_COMMIT_MESSAGE_LENGTH} characters)`);
  }
}

export function filterSecretFiles(files: string[]): { safe: string[]; rejected: string[] } {
  const safe: string[] = [];
  const rejected: string[] = [];

  for (const file of files) {
    const basename = path.basename(file);
    const isSecret = SECRET_FILE_PATTERNS.some(p => p.test(file) || p.test(basename));
    if (isSecret) {
      rejected.push(file);
    } else {
      safe.push(file);
    }
  }

  return { safe, rejected };
}

export class PathTraversalError extends Error {
  public readonly attemptedPath: string;

  constructor(attemptedPath: string, detail: string) {
    super(`Path traversal blocked: ${detail}`);
    this.name = 'PathTraversalError';
    this.attemptedPath = attemptedPath;
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
