// Phase 0c both-sides-green wait-for-consumers.
//
// After `consumer-fanout.yml` fires `repository_dispatch` to every
// consumer, each consumer runs its contract tests and reports back by
// creating a commit status on the proto repo's SHA via the GitHub
// Statuses API (POST /repos/{owner}/liftoff-proto/statuses/{sha}).
//
// This script polls the commit's combined status until all expected
// consumers post a success/failure, or the timeout fires.
//
// Required env:
//   GITHUB_TOKEN — a token with `statuses:read` on liftoff-proto
//                  (PROTO_GH_APP_TOKEN in CI; see docs/PROTO_GH_APP_TOKEN.md)

import { Octokit } from '@octokit/rest';

interface Args {
  consumers: string[];
  sourceSha: string;
  pollIntervalMs: number;
  timeoutMs: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    consumers: (get('--consumers') ?? '').split(',').filter(Boolean),
    sourceSha: get('--source-sha') ?? '',
    pollIntervalMs: Number(get('--poll-ms') ?? '15000'),
    timeoutMs: Number(get('--timeout-ms') ?? '1800000'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.consumers.length === 0 || !args.sourceSha) {
    console.error('usage: wait-for-consumers --consumers a,b,c --source-sha <sha>');
    process.exit(2);
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('[wait-for-consumers] GITHUB_TOKEN is required (see docs/PROTO_GH_APP_TOKEN.md)');
    process.exit(2);
  }

  const octokit = new Octokit({ auth: token });
  const owner = 'LiftoffOS';
  const repo = 'liftoff-proto';

  // Each consumer posts a commit status with context = `contract/{consumer}`.
  // We wait until all expected contexts report `success` or `failure`.
  const expectedContexts = new Set(
    args.consumers.map((c) => `contract/${c}`),
  );
  const failures: Array<{ consumer: string; reason: string }> = [];
  const startMs = Date.now();

  console.log(
    `[wait-for-consumers] waiting for ${expectedContexts.size} consumers on ${args.sourceSha.slice(0, 8)}…`,
  );

  while (expectedContexts.size > 0) {
    if (Date.now() - startMs > args.timeoutMs) {
      for (const ctx of expectedContexts) {
        failures.push({ consumer: ctx, reason: 'timed out' });
      }
      break;
    }

    // GET /repos/{owner}/{repo}/commits/{ref}/statuses
    const { data: statuses } = await octokit.repos
      .listCommitStatusesForRef({
        owner,
        repo,
        ref: args.sourceSha,
        per_page: 100,
      })
      .catch(() => ({ data: [] }));

    for (const s of statuses) {
      if (!expectedContexts.has(s.context)) continue;
      if (s.state === 'pending') continue; // still running

      expectedContexts.delete(s.context);
      const consumer = s.context.replace(/^contract\//, '');
      console.log(`[wait-for-consumers] ${consumer}: ${s.state}`);
      if (s.state !== 'success') {
        failures.push({ consumer, reason: `state=${s.state}` });
      }
    }

    if (expectedContexts.size > 0) {
      await new Promise((r) => setTimeout(r, args.pollIntervalMs));
    }
  }

  if (failures.length > 0) {
    console.error('[wait-for-consumers] FAIL:');
    for (const f of failures) {
      console.error(`  ${f.consumer}: ${f.reason}`);
    }
    process.exit(1);
  }
  console.log('[wait-for-consumers] OK — all consumers reported green');
}

void main();
