// distill-shadow-judge — blinded pairwise judging over production shadow pairs.
//
// Shadow mode records the two artifacts and the cheap structural metrics at the
// moment it runs. It deliberately does NOT judge them there: judging is a model
// call, it is slow, and doing it inline would put it on the same rate limit as
// the distillations whose latency is being measured. So it runs here, in a
// batch, over whatever has accumulated.
//
// Idempotent by construction. A judged row is stamped, and the sweep only picks
// up unjudged ones, so re-running does not re-bill work already done — which
// matters because every verdict is a large-tier call over two full agent
// configurations.
//
// Reads across tenants: the verdict distribution IS the result, and computing it
// per tenant would defeat the purpose at the volumes involved.
import { initDatabase, withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { judgePair } from '../internal-agents/distill-comparison-judge';
import type { DistillOutput } from '../internal-agents/distill-service';

interface PendingRow {
  id: string;
  tenant_id: string;
  real_output: DistillOutput;
  shadow_output: DistillOutput;
}

async function fetchUnjudged(limit: number): Promise<PendingRow[]> {
  const { rows } = await withAdminScope(
    { caller: 'distill-shadow-judge', reason: 'cross-tenant sweep of unjudged shadow comparisons; the verdict distribution is the result' },
    (client) => client.query<PendingRow>(
      `SELECT id, tenant_id, real_output, shadow_output
         FROM distill_shadow_comparisons
        WHERE judged_at IS NULL
          AND real_output IS NOT NULL
          AND shadow_output IS NOT NULL
          AND expires_at > NOW()
        ORDER BY created_at ASC
        LIMIT $1`,
      [limit],
    ),
  );
  return rows;
}

async function saveVerdict(
  id: string,
  winner: 'single' | 'waved' | 'tie',
  reasoning: string,
  shownShadowFirst: boolean,
): Promise<void> {
  await withAdminScope(
    { caller: 'distill-shadow-judge', reason: 'stamp the verdict back onto the comparison row it came from' },
    (client) => client.query(
      `UPDATE distill_shadow_comparisons
          SET judged_at = NOW(),
              judge_winner = $2,
              judge_reasoning = $3,
              judge_shown_shadow_first = $4
        WHERE id = $1`,
      [id, winner, reasoning, shownShadowFirst],
    ),
  );
}

export async function runShadowJudge(limit: number): Promise<void> {
  // The pool is opened by the service at startup; a standalone script has to do
  // it itself. Without this every query fails with "Database not initialized"
  // and the run reports two failed arms in milliseconds, which looks like a
  // result rather than a missing connection.
  await initDatabase();
  const pending = await fetchUnjudged(limit);
  log.info({ pending: pending.length }, 'shadow judge sweep starting');

  let judged = 0;
  for (const row of pending) {
    // Sequential. These are large-tier calls over two full configurations,
    // and firing them concurrently would create exactly the sharp usage increase
    // that trips acceleration limits — on the same key real distillations use.
    const verdict = await judgePair(
      row.id,
      // The role and responsibilities are not stored on the comparison row: the
      // artifacts carry enough for the judge, and duplicating the customer's
      // input text into a third place would be storage this experiment does not
      // need.
      row.real_output.summary ?? '',
      row.real_output.userInstructions ?? '',
      row.real_output,
      row.shadow_output,
      row.tenant_id,
    );
    if (!verdict) continue;
    await saveVerdict(row.id, verdict.winner, verdict.reasoning, verdict.firstWasWaved);
    judged++;
  }

  const { rows: tally } = await withAdminScope(
    { caller: 'distill-shadow-judge', reason: 'cross-tenant tally of shadow verdicts' },
    (client) => client.query<{ judge_winner: string; n: string; shown_first: string }>(
      `SELECT judge_winner,
              count(*)                                                        AS n,
              sum(CASE WHEN judge_shown_shadow_first THEN 1 ELSE 0 END)       AS shown_first
         FROM distill_shadow_comparisons
        WHERE judged_at IS NOT NULL
        GROUP BY judge_winner`,
    ),
  );

  const summary = {
    judgedThisRun: judged,
    tally: Object.fromEntries(tally.map((t) => [t.judge_winner, Number(t.n)])),
    // The blinding's own sanity check. Across enough verdicts this should sit
    // near half; a lopsided value means the shuffle is broken and every verdict
    // in the table is suspect.
    shownShadowFirst: tally.reduce((a, t) => a + Number(t.shown_first), 0),
  };
  log.info({ summary }, 'shadow judge sweep complete');
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  const limit = Number(process.argv[2] ?? '20');
  runShadowJudge(limit).then(
    () => process.exit(0),
    (err) => {
      log.error({ error: (err as Error).message }, 'shadow judge sweep failed');
      process.exit(1);
    },
  );
}
