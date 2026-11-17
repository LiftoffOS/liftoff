import {
  validateWorkspacePath,
  validateBranchName,
  validateCommitMessage,
  filterSecretFiles,
  PathTraversalError,
  ValidationError,
} from '../path-validator';

describe('validateWorkspacePath', () => {
  it('returns /workspace for undefined input', () => {
    expect(validateWorkspacePath(undefined)).toBe('/workspace');
  });

  it('resolves relative paths under /workspace', () => {
    expect(validateWorkspacePath('src/index.ts')).toBe('/workspace/src/index.ts');
  });

  it('resolves /workspace itself', () => {
    expect(validateWorkspacePath('/workspace')).toBe('/workspace');
  });

  it('resolves nested paths', () => {
    expect(validateWorkspacePath('a/b/c/d.txt')).toBe('/workspace/a/b/c/d.txt');
  });

  it('rejects .. components (path traversal)', () => {
    expect(() => validateWorkspacePath('../etc/passwd')).toThrow(PathTraversalError);
    expect(() => validateWorkspacePath('src/../../etc/passwd')).toThrow(PathTraversalError);
    expect(() => validateWorkspacePath('..')).toThrow(PathTraversalError);
  });

  it('rejects absolute paths outside /workspace', () => {
    expect(() => validateWorkspacePath('/etc/passwd')).toThrow(PathTraversalError);
    expect(() => validateWorkspacePath('/tmp/data')).toThrow(PathTraversalError);
    expect(() => validateWorkspacePath('/root/.ssh/id_rsa')).toThrow(PathTraversalError);
  });

  it('allows /workspace subdirectories', () => {
    expect(validateWorkspacePath('/workspace/repo/src')).toBe('/workspace/repo/src');
  });
});

describe('validateBranchName', () => {
  it('accepts valid branch names', () => {
    expect(() => validateBranchName('feature/my-branch')).not.toThrow();
    expect(() => validateBranchName('fix-123')).not.toThrow();
    expect(() => validateBranchName('agent/code-review.v2')).not.toThrow();
    expect(() => validateBranchName('main')).not.toThrow();
  });

  it('rejects empty branch name', () => {
    expect(() => validateBranchName('')).toThrow(ValidationError);
  });

  it('rejects branch names with shell metacharacters', () => {
    expect(() => validateBranchName('; rm -rf /')).toThrow(ValidationError);
    expect(() => validateBranchName('$(whoami)')).toThrow(ValidationError);
    expect(() => validateBranchName('`whoami`')).toThrow(ValidationError);
    expect(() => validateBranchName('branch && echo pwned')).toThrow(ValidationError);
  });

  it('rejects branch names starting with -', () => {
    expect(() => validateBranchName('-branch')).toThrow(ValidationError);
  });

  it('rejects branch names with ..', () => {
    expect(() => validateBranchName('branch..name')).toThrow(ValidationError);
  });

  it('rejects branch names with @{', () => {
    expect(() => validateBranchName('branch@{1}')).toThrow(ValidationError);
  });

  it('rejects branch names exceeding 200 chars', () => {
    expect(() => validateBranchName('a'.repeat(201))).toThrow(ValidationError);
  });
});

describe('validateCommitMessage', () => {
  it('accepts valid commit messages', () => {
    expect(() => validateCommitMessage('Fix: resolve null pointer in auth')).not.toThrow();
    expect(() => validateCommitMessage('a')).not.toThrow();
  });

  it('rejects empty messages', () => {
    expect(() => validateCommitMessage('')).toThrow(ValidationError);
  });

  it('rejects messages exceeding 500 chars', () => {
    expect(() => validateCommitMessage('a'.repeat(501))).toThrow(ValidationError);
  });

  it('accepts messages at exactly 500 chars', () => {
    expect(() => validateCommitMessage('a'.repeat(500))).not.toThrow();
  });
});

describe('filterSecretFiles', () => {
  it('passes normal source files', () => {
    const { safe, rejected } = filterSecretFiles(['src/index.ts', 'README.md', 'package.json']);
    expect(safe).toEqual(['src/index.ts', 'README.md', 'package.json']);
    expect(rejected).toEqual([]);
  });

  it('rejects .env files', () => {
    const { safe, rejected } = filterSecretFiles(['src/index.ts', '.env', '.env.local']);
    expect(safe).toEqual(['src/index.ts']);
    expect(rejected).toEqual(['.env', '.env.local']);
  });

  it('rejects key/pem files', () => {
    const { safe, rejected } = filterSecretFiles(['app.ts', 'server.key', 'cert.pem']);
    expect(safe).toEqual(['app.ts']);
    expect(rejected).toEqual(['server.key', 'cert.pem']);
  });

  it('rejects credentials files', () => {
    const { safe, rejected } = filterSecretFiles(['credentials.json', 'secrets.yaml']);
    expect(safe).toEqual([]);
    expect(rejected).toEqual(['credentials.json', 'secrets.yaml']);
  });

  it('rejects .ssh and .aws directories', () => {
    const { safe, rejected } = filterSecretFiles(['.ssh/id_rsa', '.aws/credentials']);
    expect(safe).toEqual([]);
    expect(rejected).toEqual(['.ssh/id_rsa', '.aws/credentials']);
  });

  it('returns empty arrays for empty input', () => {
    const { safe, rejected } = filterSecretFiles([]);
    expect(safe).toEqual([]);
    expect(rejected).toEqual([]);
  });
});
