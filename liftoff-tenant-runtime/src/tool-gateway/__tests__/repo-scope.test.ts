// Repository scope, enforced where the call happens.
//
// `githubFilter.repos` is presented to an operator as the definition of a
// role's connected surface, and the code-reviewer template tells the agent to
// respect it in so many words. Nothing enforced it: the filter was consulted in
// exactly one place — the event trigger, deciding whether an inbound event
// wakes the agent — and never on a dispatch path.
//
// So an agent could read, search and comment on any repository the GitHub App
// installation authorised, whatever its binding said. It was found the way
// these things are: an agent enumerated pull requests in a third party's
// repository that appeared in no binding anywhere.

import { reposNamedBy, repoScopeRefusal } from '../repo-scope';

describe('reposNamedBy', () => {
  it('reads separate owner and repo', () => {
    expect(reposNamedBy({ owner: 'acme', repo: 'webapp' }))
      .toEqual(['acme/webapp']);
  });

  it('reads a full name', () => {
    expect(reposNamedBy({ repository: 'acme/webapp' }))
      .toEqual(['acme/webapp']);
  });

  it('reads a repo: qualifier out of a search query', () => {
    // The search tools' way of saying it. Missing this shape would leave a hole
    // exactly the size of the tool that uses it — and search is how the agent
    // reached the third-party repo in the first place.
    expect(reposNamedBy({ q: 'repo:Tianyu199509/DeskBox is:open is:pr' }))
      .toEqual(['tianyu199509/deskbox']);
  });

  it('normalises a URL and a .git suffix', () => {
    expect(reposNamedBy({ repository: 'https://github.com/Acme/X.git' }))
      .toEqual(['acme/x']);
  });

  it('names nothing when the payload names nothing', () => {
    expect(reposNamedBy({ q: 'is:open is:pr' })).toEqual([]);
    expect(reposNamedBy({})).toEqual([]);
    expect(reposNamedBy(null)).toEqual([]);
  });
});

describe('repoScopeRefusal', () => {
  const allowed = ['acme/api'];

  it('refuses a call naming a repository outside the binding', () => {
    const r = repoScopeRefusal({
      payload: { owner: 'Tianyu199509', repo: 'DeskBox' },
      allowedRepos: allowed,
    });
    expect(r).not.toBeNull();
    expect(r!.outOfScope).toEqual(['tianyu199509/deskbox']);
    expect(r!.message).toContain('outside');
    // Terminal, like the tri-state refusal: an error the model reads as
    // permissions gets retried or routed around.
    expect(r!.message).toContain('not a permissions error');
  });

  it('allows a call inside the binding, case-insensitively', () => {
    expect(repoScopeRefusal({
      payload: { owner: 'ACME', repo: 'API' },
      allowedRepos: allowed,
    })).toBeNull();
  });

  it('allows everything when the binding declares no repos', () => {
    // An operator who has not scoped the role has not asked for a constraint,
    // and inventing one would break every agent that works today.
    expect(repoScopeRefusal({
      payload: { owner: 'anyone', repo: 'anything' },
      allowedRepos: [],
    })).toBeNull();
    expect(repoScopeRefusal({
      payload: { owner: 'anyone', repo: 'anything' },
      allowedRepos: undefined,
    })).toBeNull();
  });

  it('allows a call that names NO repository, and that is a stated limit', () => {
    // A search with no repo argument cannot be judged from its payload.
    // Refusing it would turn a scoping control into an outage; narrowing the
    // installation is the only complete answer, and this is the half the
    // platform can own.
    expect(repoScopeRefusal({ payload: { q: 'is:open' }, allowedRepos: allowed })).toBeNull();
  });

  it('refuses when ONE of several named repos is out of scope', () => {
    const r = repoScopeRefusal({
      payload: { q: 'repo:acme/api repo:other/thing' },
      allowedRepos: allowed,
    });
    expect(r!.outOfScope).toEqual(['other/thing']);
  });
});
