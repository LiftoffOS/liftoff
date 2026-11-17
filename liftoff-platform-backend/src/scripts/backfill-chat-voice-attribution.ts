// Re-attribute chat-surface voice transcriptions that were billed to nobody.
//
// A Slack or Teams voice memo was transcribed BEFORE routing decided which
// teammate it was for, and was billed there with no agent id. classifyChargeability
// will not honour a customer purpose without one, so `voice_dictation` fell
// through to platform overhead: the purpose said charge, the missing agent said
// absorb, and absorb won. Every affected memo was paid for by Liftoff.
//
// The code is fixed. This repairs the rows it already wrote.
//
// WHY THIS IS NOT AN UPDATE STATEMENT. Those rows never reached the money
// authority: `platform_overhead` skips applyOuConsumption entirely, so the
// counter on billing_controls was never incremented and no bucket was drained.
// Rewriting the ledger alone would produce rows that claim a charge nobody was
// charged for — a ledger that disagrees with billing is worse than one that is
// merely incomplete.
//
// So each row is corrected AND its Operating Units are applied, in one
// transaction, exactly as the live path would have done.
//
// PAIRING. A transcription's agent is recoverable because its spoken reply
// carries one: both source ids end in the same platform message id
//   voice-stt:slack:C01ABCD2EFG:1786097676.557019
//   voice-tts:slack:C01ABCD2EFG:1786097676.557019
// The trailing id is the join key. A memo with no spoken reply has no recoverable
// agent and is deliberately left alone — see the summary it prints.
//
//   npx tsx src/scripts/backfill-chat-voice-attribution.ts [--apply]
//
// Dry by default. Prints what it WOULD change, and counts rows actually written
// rather than calls attempted.

import { withAdminScope } from '../infrastructure/database';
import { applyOuConsumption } from '../cost-attribution/ou-bucket-service';
import { log } from '../infrastructure/logging';

interface Orphan {
  id: string;
  tenantId: string;
  costUsd: number;
  agentId: string;
  sourceId: string;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  const orphans = await withAdminScope<Orphan[]>(
    { caller: 'backfill-chat-voice-attribution', reason: 're-attribute voice transcriptions billed with no agent' },
    async (client) => {
    const { rows } = await client.query<{
      id: string; tenant_id: string;
      cost_usd: string; source_id: string; agent_id: string;
    }>(
      // The join recovers the agent from the spoken reply that answered the same
      // message. Restricted to chat surfaces: a browser dictation with no agent
      // is a platform surface and is absorbed correctly.
      `SELECT stt.id, stt.tenant_id, stt.cost_usd, stt.source_id,
              tts.agent_id
         FROM cost_attribution_events stt
         JOIN cost_attribution_events tts
           ON tts.event_type = 'voice_tts'
          AND tts.agent_id IS NOT NULL
          AND split_part(tts.source_id, ':', -1) = split_part(stt.source_id, ':', -1)
        WHERE stt.event_type   = 'voice_stt'
          AND stt.agent_id     IS NULL
          AND stt.cost_bucket  = 'platform_overhead'
          AND stt.purpose      = 'voice_dictation'
          AND stt.source_id LIKE 'voice-stt:%'
          AND (stt.source_id LIKE '%:slack:%' OR stt.source_id LIKE '%:teams:%')`,
    );
      return rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        costUsd: parseFloat(r.cost_usd),
        agentId: r.agent_id,
        sourceId: r.source_id,
      }));
    },
  );

  console.log(`found ${orphans.length} mis-attributed transcription(s)`);
  for (const o of orphans) {
    console.log(`  ${o.sourceId}  $${o.costUsd.toFixed(8)}  -> agent ${o.agentId}`);
  }
  if (!apply) {
    console.log('\ndry run — pass --apply to correct them');
    return;
  }

  let corrected = 0;
  let ouApplied = 0;

  for (const o of orphans) {
    await withAdminScope(
      { caller: 'backfill-chat-voice-attribution', reason: 'apply the OUs this row never charged' },
      async (client) => {
      await client.query('BEGIN');
      try {
        // Guard inside the transaction: a concurrent run, or a re-run of this
        // script, must not charge the same row twice.
        const { rows: still } = await client.query<{ id: string }>(
          `SELECT id FROM cost_attribution_events
            WHERE id = $1 AND agent_id IS NULL AND cost_bucket = 'platform_overhead'
            FOR UPDATE`,
          [o.id],
        );
        if (still.length === 0) {
          await client.query('ROLLBACK');
          return;
        }

        // The money authority first: it decides the split and the rated amount,
        // and holds billing_controls FOR UPDATE until this commits.
        // The ledger keys on tenant; the money authority keys on account.
        // Resolved on THIS client rather than through the repository helper,
        // which uses the request pool that a script never initialises.
        const { rows: acct } = await client.query<{ account_id: string }>(
          'SELECT account_id FROM tenants WHERE id = $1',
          [o.tenantId],
        );
        const accountId = acct[0]?.account_id ?? null;
        if (!accountId) {
          await client.query('ROLLBACK');
          log.error({ tenantId: o.tenantId }, 'no account for tenant — cannot re-attribute');
          return;
        }
        const assignments = await applyOuConsumption(client, accountId, o.costUsd);
        const customerCostUsd = assignments.reduce((sum, a) => sum + a.customerCostUsd, 0);
        const bucket = assignments[0]?.costBucket ?? 'included';
        const ou = assignments.reduce((sum, a) => sum + a.ouConsumed, 0);

        const res = await client.query(
          `UPDATE cost_attribution_events
              SET agent_id = $2, cost_bucket = $3, customer_cost_usd = $4
            WHERE id = $1`,
          [o.id, o.agentId, bucket, customerCostUsd],
        );
        await client.query('COMMIT');
        corrected += res.rowCount ?? 0;
        ouApplied += ou;
      } catch (err) {
        await client.query('ROLLBACK');
        log.error({ error: (err as Error).message, id: o.id }, 'voice re-attribution failed');
        throw err;
      }
      },
    );
  }

  // Rows written, not calls made.
  console.log(`\ncorrected ${corrected} row(s); applied ${ouApplied.toFixed(6)} Operating Units`);
}

main()
  .then(() => process.exit(0))
  .catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
