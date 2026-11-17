// Where a clone lands, and why it is no longer one fixed slot.
//
// git_clone cloned into a hardcoded `/workspace/repo` and returned only
// stdout/stderr/exitCode, so nothing downstream could learn the checkout path.
// A code-review agent's distilled graph guessed: its `git fetch` step ran with
// `workDir: {{steps.s2.repo}}` — the bare repository NAME — against a checkout
// that was actually at /workspace/repo. The step could not have been right,
// because the tool never said where it put anything.
//
// The single slot is also unsafe now that workspaces are keyed per AGENT and
// survive between ticks: `git clone` into a non-empty directory fails, and two
// repositories through one slot is either a hard failure or a review of the
// wrong code.
import { gitCheckoutPath } from '../sandbox-executor';

describe('gitCheckoutPath', () => {
  it('gives each repository its own directory', () => {
    const a = gitCheckoutPath('https://github.com/acme/billing.git');
    const b = gitCheckoutPath('https://github.com/acme/proto.git');
    expect(a).not.toBe(b);
    expect(a).toBe('/workspace/acme-billing');
  });

  it('is stable, so a later run finds the checkout it already has', () => {
    // This is what makes "fetch instead of re-clone" possible at all, and what
    // makes a self-scheduled continuation resume rather than restart.
    const first = gitCheckoutPath('https://github.com/acme/billing.git');
    const second = gitCheckoutPath('https://github.com/acme/billing.git');
    expect(first).toBe(second);
  });

  it('separates same-named repos under different owners', () => {
    expect(gitCheckoutPath('https://github.com/acme/api.git'))
      .not.toBe(gitCheckoutPath('https://github.com/other/api.git'));
  });

  it('tolerates a missing .git suffix and a trailing slash', () => {
    expect(gitCheckoutPath('https://github.com/acme/billing/'))
      .toBe('/workspace/acme-billing');
  });

  it('handles gitlab and scp-style remotes', () => {
    expect(gitCheckoutPath('https://gitlab.com/group/project.git'))
      .toBe('/workspace/group-project');
    expect(gitCheckoutPath('git@github.com:acme/proto.git'))
      .toBe('/workspace/acme-proto');
  });

  // The owner and name are remote-controlled and are about to become a path
  // handed to git. They get sanitised to one segment.
  it('cannot escape /workspace', () => {
    const p = gitCheckoutPath('https://github.com/../../etc/passwd');
    expect(p.startsWith('/workspace/')).toBe(true);
    expect(p).not.toContain('..');
    expect(p.split('/').length).toBe(3);
  });

  it('never returns a bare /workspace when the URL is unusable', () => {
    // A directory of "" would put the checkout at the workspace root and make
    // every later repo collide with it.
    expect(gitCheckoutPath('')).toBe('/workspace/repo');
    expect(gitCheckoutPath('https://github.com/')).toBe('/workspace/repo');
  });
});
