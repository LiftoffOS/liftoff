// Two clone tools on one platform disagreed about what `repo` means.
//
// code_session takes `owner/name` and builds `https://<host>/<repo>.git` itself.
// git_clone documented "Repository URL (HTTPS)" and handed the string to git.
// Same platform, same parameter name, opposite formats — and the LLM writing a
// distilled graph cannot see which of the two it is targeting.
//
// It picked the other one. A code-review graph passed the GitHub API's
// `full_name` field, `acme/billing`, into git_clone. Both legs of
// the tool failed on it, and neither said so:
//
//   - the credential builder does `new URL(repo)`, returns undefined when that
//     throws, and the clone therefore ran UNAUTHENTICATED against a private
//     repository — silently, because the single warn on that path only fires for
//     a resolver that throws, not a ref that will not parse
//   - `git clone acme/billing` reads a non-URL as a LOCAL PATH, so
//     git failed in well under a second with "repository does not exist"
//
// gitCheckoutPath already tolerated the bare form. That is why this outlived the
// earlier round of clone fixes: one of three consumers coped and two did not, so
// the returned checkout path looked correct while the clone meant to fill it had
// never been able to reach a repository at all. Normalising once, before any of
// the three read it, is the part that keeps them from drifting apart again.
import { normalizeRepoRef, gitCheckoutPath } from '../sandbox-executor';

describe('normalizeRepoRef', () => {
  it('turns the shape the distiller actually emits into a real remote', () => {
    // Exactly what s1 hands s3: GitHub's `full_name`.
    expect(normalizeRepoRef('acme/billing'))
      .toBe('https://github.com/acme/billing.git');
  });

  it('leaves an HTTPS URL alone', () => {
    const url = 'https://github.com/acme/billing.git';
    expect(normalizeRepoRef(url)).toBe(url);
    expect(normalizeRepoRef('https://gitlab.com/group/project.git'))
      .toBe('https://gitlab.com/group/project.git');
  });

  it('leaves a URL without the .git suffix alone', () => {
    // git accepts it and the host is already explicit; rewriting it would only
    // add a way to get it wrong.
    expect(normalizeRepoRef('https://github.com/acme/billing'))
      .toBe('https://github.com/acme/billing');
  });

  it('leaves an scp-style remote alone', () => {
    // `git@github.com:owner/name.git` contains a slash and a colon and is a
    // remote git already understands. Two segments is the whole trigger.
    expect(normalizeRepoRef('git@github.com:acme/proto.git'))
      .toBe('git@github.com:acme/proto.git');
  });

  it('does not touch anything with more or fewer than two segments', () => {
    expect(normalizeRepoRef('billing')).toBe('billing');
    expect(normalizeRepoRef('a/b/c')).toBe('a/b/c');
    expect(normalizeRepoRef('/workspace/repo')).toBe('/workspace/repo');
  });

  it('tolerates a bare slug that already carries .git', () => {
    expect(normalizeRepoRef('acme/billing.git'))
      .toBe('https://github.com/acme/billing.git');
  });

  it('trims, because a template expansion can leave whitespace', () => {
    expect(normalizeRepoRef('  acme/billing \n'))
      .toBe('https://github.com/acme/billing.git');
  });

  it('survives an empty or missing ref without inventing a remote', () => {
    expect(normalizeRepoRef('')).toBe('');
    expect(normalizeRepoRef(undefined as unknown as string)).toBe('');
  });

  it('honours an explicit non-GitHub default host', () => {
    expect(normalizeRepoRef('group/project', 'gitlab.com'))
      .toBe('https://gitlab.com/group/project.git');
  });

  // The bare form and the URL form must land in the SAME directory, or fixing
  // this would strand every checkout made under the old input and turn the
  // "fetch instead of re-clone" path back into a re-clone.
  it('resolves to the same checkout path as the URL it expands to', () => {
    expect(gitCheckoutPath(normalizeRepoRef('acme/billing')))
      .toBe(gitCheckoutPath('https://github.com/acme/billing.git'));
    expect(gitCheckoutPath(normalizeRepoRef('acme/billing')))
      .toBe('/workspace/acme-billing');
  });
});
