// Repository scope, enforced where the call happens.
//
// `githubFilter.repos` (and `gitlabFilter.projects`) is presented to an operator
// as the definition of a role's connected surface, and the code-reviewer
// template tells the agent in so many words: "the repository, branch and author
// filter on the connection defines the connected surface; do not fetch or
// review outside it".
//
// Nothing enforced it. The filter was consulted in exactly one place —
// `event-trigger.ts`, deciding whether an inbound event wakes the agent — and
// never on the dispatch path. So at run time an agent could read, search and
// (with a write tool) comment on ANY repository the GitHub App installation
// authorises, whatever its binding said. The instruction to stay in scope was
// prose, and prose is not enforcement.
//
// That gap is worse than an ordinary missing check because of who it lies to.
// An operator who narrows a role to one repository has been given a control
// that appears to work and does not, and the failure only becomes visible when
// an agent acts somewhere nobody expected — which is exactly how it was found:
// an agent enumerated pull requests in a third party's repository that appeared
// in no binding anywhere.
//
// WHAT THIS CANNOT DO, stated because a partial guard sold as a complete one is
// the same lie in a smaller font: it constrains calls that NAME a repository.
// A search with no repository argument cannot be constrained by inspecting its
// payload, and this returns "allowed" for those rather than guessing. Narrowing
// the installation itself is the only complete answer, and this is the half the
// platform can own.

/** A repository reference, normalised to `owner/name` lowercase. */
export type RepoRef = string;

function normalise(ref: string): RepoRef {
  return ref.trim().toLowerCase().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
}

/**
 * Repository references a tool payload names.
 *
 * Three shapes, because GitHub's own tools disagree about how to say it:
 * separate `owner` + `repo`, a single `repository` / `repo_full_name`, and a
 * `repo:` qualifier inside a search query string. Missing any one of them would
 * leave a hole in the exact shape of the tool that uses it.
 */
export function reposNamedBy(payload: unknown): RepoRef[] {
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as Record<string, unknown>;
  const out = new Set<RepoRef>();

  const owner = typeof p.owner === 'string' ? p.owner : null;
  const repo = typeof p.repo === 'string' ? p.repo : null;
  if (owner && repo) out.add(normalise(`${owner}/${repo}`));

  for (const key of ['repository', 'repo_full_name', 'repoFullName', 'full_name', 'nameWithOwner']) {
    const v = p[key];
    if (typeof v === 'string' && v.includes('/')) out.add(normalise(v));
  }

  // `q: "repo:owner/name is:open"` — the search tools' way of saying it.
  for (const key of ['q', 'query', 'search']) {
    const v = p[key];
    if (typeof v !== 'string') continue;
    for (const m of v.matchAll(/\brepo:([\w.-]+\/[\w.-]+)/gi)) out.add(normalise(m[1]));
  }

  return [...out];
}

export interface RepoScopeRefusal {
  refused: true;
  outOfScope: RepoRef[];
  allowed: RepoRef[];
  message: string;
}

/**
 * Whether a call reaches outside its binding's declared repositories.
 *
 * Returns null — allowed — in three cases, each deliberate:
 *   - the binding declares no repos. An operator who has not scoped the role
 *     has not asked for a constraint, and inventing one would break every
 *     agent that works today.
 *   - the payload names no repository. See the note above: a search with no
 *     repo argument cannot be judged from its payload, and refusing it would
 *     turn a scoping control into an outage.
 *   - every named repository is in scope.
 */
export function repoScopeRefusal(args: {
  payload: unknown;
  allowedRepos: readonly string[] | undefined;
}): RepoScopeRefusal | null {
  const allowed = (args.allowedRepos ?? []).map(normalise).filter((r) => r.length > 0);
  if (allowed.length === 0) return null;

  const named = reposNamedBy(args.payload);
  if (named.length === 0) return null;

  const outOfScope = named.filter((r) => !allowed.includes(r));
  if (outOfScope.length === 0) return null;

  return {
    refused: true,
    outOfScope,
    allowed,
    message:
      `This team is connected to ${allowed.join(', ')} and the call names ${outOfScope.join(', ')}, `
      + 'which is outside that. Work only within the connected repositories. '
      + 'This is not a permissions error to retry or route around: the repository is not part of '
      + 'this team\'s remit. Say what you could not do and continue with the rest of the work.',
  };
}
