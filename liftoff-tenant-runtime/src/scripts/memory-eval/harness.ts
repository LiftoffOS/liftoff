// CLI entrypoint for the offline memory-eval harness. Runs as a Cloud
// Run Job against a tenant's runtime DB.
//
// Usage:
//   node dist/scripts/memory-eval/harness.js \
//     --since 2026-05-25 --until 2026-06-08 \
//     --candidates baseline,no-recency \
//     --min-cited 1 --per-tenant-min 200 --out /workspace/eval.md

import { writeFileSync } from 'fs';
import { loadEvents } from './dataset';
import { CANDIDATES, candidateByName } from './candidates';
import { scoreEvent, type EventScore } from './metrics';
import { aggregate, renderMarkdown, type PerTenantAggregate } from './report';
import { log } from '../../infrastructure/logging';

interface CliArgs {
  since: Date;
  until: Date;
  candidates: string[];
  minCited: number;
  perTenantMin: number;
  tenantIds?: string[];
  limit?: number;
  out?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args.set(argv[i].slice(2), argv[i + 1] ?? '');
  }
  const get = (k: string): string | undefined => args.get(k);
  if (!get('since') || !get('until')) {
    throw new Error('--since and --until (ISO dates) are required');
  }
  return {
    since: new Date(get('since')!),
    until: new Date(get('until')!),
    candidates: (get('candidates') ?? 'baseline').split(',').map(s => s.trim()).filter(Boolean),
    minCited: parseInt(get('min-cited') ?? '1', 10),
    perTenantMin: parseInt(get('per-tenant-min') ?? '200', 10),
    tenantIds: get('tenants') ? get('tenants')!.split(',') : undefined,
    limit: get('limit') ? parseInt(get('limit')!, 10) : undefined,
    out: get('out'),
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  log.info(
    { since: opts.since.toISOString(), until: opts.until.toISOString(), candidates: opts.candidates },
    'memory-eval: starting',
  );

  const events = await loadEvents({
    since: opts.since,
    until: opts.until,
    minCited: opts.minCited,
    tenantIds: opts.tenantIds,
    limit: opts.limit,
  });
  log.info({ n: events.length }, 'memory-eval: events loaded');

  const selected = opts.candidates.map(candidateByName);

  // scores[candidate name] = EventScore[]
  const scores = new Map<string, EventScore[]>();
  for (const c of selected) scores.set(c.name, []);

  let processed = 0;
  for (const ev of events) {
    for (const c of selected) {
      try {
        const ranked = await c.retrieve(ev);
        const s = scoreEvent(ranked, ev.citedIds);
        scores.get(c.name)!.push({ ...s, invocationId: ev.invocationId, tenantId: ev.tenantId });
      } catch (err) {
        log.warn(
          { err: (err as Error).message, candidate: c.name, invocationId: ev.invocationId },
          'memory-eval: replay failed; skipping for this candidate',
        );
      }
    }
    processed++;
    if (processed % 100 === 0) {
      log.info({ processed, total: events.length }, 'memory-eval: progress');
    }
  }

  const aggregates = selected.map(c => aggregate(scores.get(c.name)!, c.name));

  const perTenant: PerTenantAggregate[] = [];
  const tenantsSeen = new Set(events.map(e => e.tenantId));
  for (const tenantId of tenantsSeen) {
    for (const c of selected) {
      const tenantScores = scores.get(c.name)!.filter(s => s.tenantId === tenantId);
      if (tenantScores.length < opts.perTenantMin) continue;
      perTenant.push({ ...aggregate(tenantScores, c.name), tenantId });
    }
  }

  const md = renderMarkdown(aggregates, perTenant);
  if (opts.out) {
    writeFileSync(opts.out, md);
    log.info({ out: opts.out }, 'memory-eval: report written');
  } else {
    process.stdout.write(md);
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch(err => {
    log.error({ err: (err as Error).message, stack: (err as Error).stack },
              'memory-eval: fatal');
    process.exit(1);
  });
}

export { parseArgs };
