// FITNESS FUNCTION — no process that can host agent-authored code holds a
// secret bound at exec time.
//
// A Cloud Run `--set-secrets` binding puts the value in the process environment
// at execve time, which has two consequences that are easy to miss:
//
//   1. It is in `/proc/1/environ`, readable by ANY process in the container that
//      shares the UID — including a coding agent's shell. Verified on Linux.
//   2. **No process can remove it.** `delete process.env.X` unsets the pointer
//      glibc reads, but `/proc` serves the original stack region written at
//      exec. Also verified. So no amount of in-process hygiene helps.
//
// The only way a secret leaves `/proc` is to stop being bound at exec and be
// fetched at runtime instead — which is what `loadSecretsToEnv` is for, and what
// platform-backend already does for all of its secrets, for a related reason it
// wrote down (Cloud Run bindings and Terraform clobbering each other).
//
// Two properties are asserted, and the second is the one that matters:
//
//   A. Every exec-bound secret has a manifest entry, so the binding COULD be
//      removed. A manifest entry can be wrong and never say so — ANTHROPIC_API_KEY
//      was, pointing at `anthropic-api-key-{env}` in the CONTROL project when that
//      secret lives in the TENANT project, and nothing noticed for as long as
//      --set-secrets kept the variable populated and the fetch short-circuited.
//   B. No `deploy-*` step binds anything at all. Those are the five Cloud Run
//      services, every one of which runs `src/index.ts` and hydrates the whole
//      manifest at boot before anything reads it. They are also the processes
//      that spawn coding CLIs, so they are the ones the /proc vector is about.
//
// What remains bound is the Cloud Run JOBS, and that is deliberate: the migrate
// job runs the `-migrate` image (node-pg-migrate), and the embedding-backfill and
// collab-grade jobs run `dist/workers/...` and `dist/scripts/...` entrypoints that
// never call `loadSecretsToEnv`. Removing a binding from a process that does not
// hydrate does not move the secret, it deletes it. Give one of those an
// entrypoint that hydrates and its binding can go too.

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const CLOUDBUILD = readFileSync(join(ROOT, 'cloudbuild.yaml'), 'utf8');
const SECRETS_SOURCE = readFileSync(join(ROOT, 'src', 'infrastructure', 'secrets.ts'), 'utf8');

/** Manifest entries, read from source rather than imported.
 *
 *  `src/test-utils/setup.ts` mocks the whole secrets module globally, so an
 *  import here would hand back a stub and this suite would report every secret
 *  as unhydrated — passing its own check for the wrong reason and then failing
 *  it for another. Reading the file is also what the sibling fitness tests do. */
function manifestEnvVars(): Set<string> {
  return new Set(
    [...SECRETS_SOURCE.matchAll(/envVar:\s*'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]),
  );
}

/** Every `NAME=secret:version` a chunk of build script binds.
 *
 *  Two forms, and the second is not optional. Some steps write the list into a
 *  shell variable and pass `--set-secrets "$$SECRETS"`, which a scan for the
 *  flag alone reads as a single token named `$$SECRETS` and discards — so those
 *  bindings would be invisible to this file exactly where it is load-bearing.
 *  Comment lines are stripped first: several explain the flag in prose. */
function boundSecretsIn(chunk: string): string[] {
  const code = chunk
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  const names = new Set<string>();
  const lists = [
    ...[...code.matchAll(/--set-secrets\s+"([^"]+)"/g)].map((m) => m[1]),
    ...[...code.matchAll(/\bSECRETS="([^"]+)"/g)].map((m) => m[1]),
  ];
  for (const list of lists) {
    for (const pair of list.split(',')) {
      const envVar = pair.split('=')[0].trim();
      if (/^[A-Z][A-Z0-9_]*$/.test(envVar)) names.add(envVar);
    }
  }
  return [...names].sort();
}

/** Each build step, keyed by its `id:`. */
function steps(): Map<string, string> {
  const out = new Map<string, string>();
  const marks = [...CLOUDBUILD.matchAll(/^\s*id:\s*'([^']+)'/gm)];
  marks.forEach((mark, i) => {
    const start = mark.index ?? 0;
    const end = i + 1 < marks.length ? (marks[i + 1].index ?? CLOUDBUILD.length) : CLOUDBUILD.length;
    out.set(mark[1], CLOUDBUILD.slice(start, end));
  });
  return out;
}

describe('secrets bound at exec time', () => {
  const bound = boundSecretsIn(CLOUDBUILD);

  it('finds bindings at all, so this cannot pass vacuously', () => {
    expect(bound.length).toBeGreaterThan(0);
  });

  it('each has a hydration path, so the binding can be removed', () => {
    const manifest = manifestEnvVars();
    const orphans = bound.filter((name) => !manifest.has(name));
    expect({
      orphans,
      hint:
        orphans.length === 0
          ? 'ok'
          : 'These are bound by --set-secrets and have no entry in SECRET_MANIFEST, so they are '
            + 'stuck in /proc/1/environ where any in-container child can read them and no code '
            + 'can remove them. Add a manifest entry pointing at the right project, verify it '
            + 'hydrates in dev (the boot log reports which entries were skipped as pre-set), '
            + 'then drop the binding.',
    }).toEqual({ orphans: [], hint: 'ok' });
  });

  it('is confined to the jobs — no deployed SERVICE binds a secret', () => {
    // The property, not a tally. Every `deploy-*` step runs src/index.ts, which
    // hydrates before anything reads a secret, and those are the processes that
    // spawn coding CLIs. A binding reintroduced on one of them puts a credential
    // back in /proc for the life of the revision, where nothing can take it out.
    const offenders: Record<string, string[]> = {};
    for (const [id, body] of steps()) {
      if (!id.startsWith('deploy-')) continue;
      const secrets = boundSecretsIn(body);
      if (secrets.length > 0) offenders[id] = secrets;
    }
    expect(offenders).toEqual({});
  });

  it('names what is still bound, and each name is a job that cannot hydrate', () => {
    // Exact, not `arrayContaining`: a NEW binding is as much a regression as a
    // forgotten one, and only the exact form catches it.
    //
    //   DB_PASSWORD                  — {service}-migrate, {service}-embedding-backfill,
    //                                  {service}-collab-grade
    //   TENANT_RUNTIME_SERVICE_TOKEN — {service}-collab-grade
    //   ANTHROPIC_API_KEY            — {service}-collab-grade
    //   PLATFORM_CALLBACK_TOKEN      — {service}-collab-grade
    //
    // All three entrypoints skip `loadSecretsToEnv`. Shrinking this list means
    // giving one of them a bootstrap that hydrates first, not just deleting a flag.
    expect(bound).toEqual([
      'ANTHROPIC_API_KEY',
      'DB_PASSWORD',
      'PLATFORM_CALLBACK_TOKEN',
      'TENANT_RUNTIME_SERVICE_TOKEN',
    ]);
  });
});
