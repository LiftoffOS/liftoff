// git_clone had no credentials, and every repository it is pointed at is private.
//
// It ran a bare `git clone <url>` from a sandbox built with `credentials: []`.
// A private repo rejects that in about a second, which is why it never looked
// like a credential problem: two attempts fit inside six seconds, far too fast
// to read as a ~60s provisioning delay, even though the agent's own error
// ("gh CLI is not authenticated ... set GH_TOKEN") named the cause.
//
// code_session has cloned WITH a token the whole time, so the platform carried
// two clone implementations and only one of them could reach a repository.
//
// What these tests hold is mostly about where the secret is NOT. The sandbox
// path records argv to sandbox_audit_log and sanitizes stdout/stderr, and git
// echoes a remote URL back in its own error text — so a token in the URL or the
// command line lands in an audit row. It goes in the environment, and the
// GIT_CONFIG_COUNT/KEY/VALUE helper reads it from a second variable so it is not
// even part of the config value.
import { SandboxExecutor, normalizeRepoRef } from '../sandbox-executor';

type ExecCall = { args: string[]; opts?: { env?: Record<string, string> } };

function executorWithProvider(exec: jest.Mock) {
  const provider = {
    exec,
    create: jest.fn(),
    destroy: jest.fn(),
    setRoutingContext: jest.fn(),
  };
  return new SandboxExecutor(
    provider as never,
    { getBySession: jest.fn() } as never,
    {} as never,
    { record: jest.fn() } as never,
    { sanitize: (o: string, e: string) => ({ stdout: o, stderr: e }) } as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

/** Reach the private helper directly: the surrounding execute() path needs a
 *  provisioned sandbox, a rate limiter and an audit repo, none of which this
 *  behaviour depends on. */
function buildEnv(executor: SandboxExecutor, repo: string) {
  return (executor as unknown as {
    buildGitCredentialEnv: (
      s: { tenantId: string; agentId: string },
      r: string,
    ) => Promise<Record<string, string> | undefined>;
  }).buildGitCredentialEnv({ tenantId: 't', agentId: 'a' }, repo);
}

describe('git_clone credentials', () => {
  it('clones unauthenticated when no resolver is wired', async () => {
    // A deployment without a resolver keeps exactly the previous behaviour.
    const executor = executorWithProvider(jest.fn());
    await expect(buildEnv(executor, 'https://github.com/o/r.git')).resolves.toBeUndefined();
  });

  it('puts the token in the environment and NOWHERE else', async () => {
    const executor = executorWithProvider(jest.fn());
    executor.setGitCredentialResolver(async () => 'ghs_SECRET_TOKEN');

    const env = await buildEnv(executor, 'https://github.com/o/r.git');

    expect(env).toBeDefined();
    expect(env!.LIFTOFF_GIT_TOKEN).toBe('ghs_SECRET_TOKEN');
    // The helper must reference the variable, not inline the secret — otherwise
    // the token is part of a git config value that git can print back.
    expect(env!.GIT_CONFIG_VALUE_0).toContain('$LIFTOFF_GIT_TOKEN');
    expect(env!.GIT_CONFIG_VALUE_0).not.toContain('ghs_SECRET_TOKEN');
  });

  it('scopes the credential to the one host being cloned', async () => {
    const executor = executorWithProvider(jest.fn());
    executor.setGitCredentialResolver(async () => 'tok');

    const env = await buildEnv(executor, 'https://github.com/o/r.git');
    // Not a bare `credential.helper`: a global helper would hand this token to
    // a clone of any other host in the same workspace.
    expect(env!.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
  });

  it('uses the provider-specific git username', async () => {
    const executor = executorWithProvider(jest.fn());
    executor.setGitCredentialResolver(async () => 'tok');

    const gh = await buildEnv(executor, 'https://github.com/o/r.git');
    const gl = await buildEnv(executor, 'https://gitlab.com/g/p.git');

    // The same pair code-session already encodes.
    expect(gh!.GIT_CONFIG_VALUE_0).toContain('username=x-access-token');
    expect(gl!.GIT_CONFIG_VALUE_0).toContain('username=oauth2');
    expect(gl!.GIT_CONFIG_KEY_0).toBe('credential.https://gitlab.com.helper');
  });

  it('never leaves git waiting on a terminal prompt', async () => {
    const executor = executorWithProvider(jest.fn());
    executor.setGitCredentialResolver(async () => 'tok');
    const env = await buildEnv(executor, 'https://github.com/o/r.git');
    // Without this a credential miss blocks until the 120s exec timeout instead
    // of failing with something the model can read.
    expect(env!.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('falls back to an unauthenticated clone when the agent has no binding', async () => {
    const executor = executorWithProvider(jest.fn());
    executor.setGitCredentialResolver(async () => undefined);
    await expect(buildEnv(executor, 'https://github.com/o/r.git')).resolves.toBeUndefined();
  });

  it('does not fail the clone when credential lookup throws', async () => {
    // A public repo still clones, and a private one gets git's own error, which
    // says more than a credential-lookup stack trace.
    const executor = executorWithProvider(jest.fn());
    executor.setGitCredentialResolver(async () => { throw new Error('connector-service down'); });
    await expect(buildEnv(executor, 'https://github.com/o/r.git')).resolves.toBeUndefined();
  });

  it('declines on a repo string that is not a URL', async () => {
    const executor = executorWithProvider(jest.fn());
    executor.setGitCredentialResolver(async () => 'tok');
    await expect(buildEnv(executor, 'not a url')).resolves.toBeUndefined();
  });

  // The regression that would make all of the above moot.
  //
  // A distilled graph can pass GitHub's `full_name` — `owner/name`, no scheme.
  // `new URL()` throws on it, so this helper would return undefined and the
  // clone would go out unauthenticated against a private repo. Every test
  // above would still pass, because every one of them hands in a URL.
  it('authenticates a bare owner/name once it has been normalized', async () => {
    const executor = executorWithProvider(jest.fn());
    executor.setGitCredentialResolver(async () => 'tok');

    const env = await buildEnv(executor, normalizeRepoRef('acme/billing'));

    expect(env).toBeDefined();
    expect(env!.LIFTOFF_GIT_TOKEN).toBe('tok');
    expect(env!.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
  });

  it('asks the resolver for the host the normalized ref names', async () => {
    // The resolver picks the agent's github vs gitlab binding off this host, so
    // an empty host is not just a missing credential — it is the wrong question.
    const seen: string[] = [];
    const executor = executorWithProvider(jest.fn());
    executor.setGitCredentialResolver(async ({ host }) => { seen.push(host); return 'tok'; });

    await buildEnv(executor, normalizeRepoRef('acme/billing'));

    expect(seen).toEqual(['github.com']);
  });
});
