// Aggregates per-event scores into overall + per-tenant tables and
// renders to markdown.

import type { EventScore } from './metrics';

export interface CandidateAggregate {
  candidate: string;
  n: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  ndcgAt10: number;
}

export interface PerTenantAggregate extends CandidateAggregate {
  tenantId: string;
}

export function aggregate(scores: EventScore[], candidate: string): CandidateAggregate {
  if (scores.length === 0) {
    return { candidate, n: 0, recallAt5: 0, recallAt10: 0, mrr: 0, ndcgAt10: 0 };
  }
  const sum = scores.reduce(
    (acc, s) => ({
      recallAt5:  acc.recallAt5  + s.recallAt5,
      recallAt10: acc.recallAt10 + s.recallAt10,
      mrr:        acc.mrr        + s.mrr,
      ndcgAt10:   acc.ndcgAt10   + s.ndcgAt10,
    }),
    { recallAt5: 0, recallAt10: 0, mrr: 0, ndcgAt10: 0 },
  );
  return {
    candidate,
    n: scores.length,
    recallAt5:  sum.recallAt5  / scores.length,
    recallAt10: sum.recallAt10 / scores.length,
    mrr:        sum.mrr        / scores.length,
    ndcgAt10:   sum.ndcgAt10   / scores.length,
  };
}

const pct = (n: number) => (n * 100).toFixed(2);

export function renderMarkdown(
  aggregates: CandidateAggregate[],
  perTenant: PerTenantAggregate[],
): string {
  const overall = '## Overall\n\n' +
    '| Candidate | N | Recall@5 | Recall@10 | MRR | NDCG@10 |\n' +
    '|---|---:|---:|---:|---:|---:|\n' +
    aggregates.map(a =>
      `| ${a.candidate} | ${a.n} | ${pct(a.recallAt5)} | ${pct(a.recallAt10)} | ${a.mrr.toFixed(3)} | ${pct(a.ndcgAt10)} |`
    ).join('\n');

  const tenant = perTenant.length === 0
    ? '\n\n_(no tenants with enough events to qualify)_\n'
    : '\n\n## Per-tenant (only tenants above threshold)\n\n' +
      '| Tenant | Candidate | N | Recall@5 | Recall@10 | MRR | NDCG@10 |\n' +
      '|---|---|---:|---:|---:|---:|---:|\n' +
      perTenant.map(a =>
        `| ${a.tenantId.slice(0, 8)} | ${a.candidate} | ${a.n} | ${pct(a.recallAt5)} | ${pct(a.recallAt10)} | ${a.mrr.toFixed(3)} | ${pct(a.ndcgAt10)} |`
      ).join('\n');

  return `# Memory Eval Report\n\nGenerated ${new Date().toISOString()}\n\n${overall}${tenant}\n`;
}
