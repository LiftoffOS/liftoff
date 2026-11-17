#!/usr/bin/env ts-node
// DLQ Replay Script
// Batch-replays pending DLQ messages by delegating to DLQService.manualRetry().
// Before re-publishing, resets the event processing ledger entry so the event can be re-claimed.
//
// Usage: npx ts-node scripts/replay-dlq.ts [--tenant-id=<uuid>] [--topic=<topic>] [--dry-run]

import { pool } from '../src/infrastructure/database';
import { dlqService } from '../src/infrastructure/dlq';
// Logger available but not used in this script (console output is preferred for CLI tools)

async function main() {
  const args = process.argv.slice(2);
  const tenantId = args.find(a => a.startsWith('--tenant-id='))?.split('=')[1];
  const topic = args.find(a => a.startsWith('--topic='))?.split('=')[1];
  const dryRun = args.includes('--dry-run');

  console.log('DLQ Replay Script');
  console.log(`  Tenant: ${tenantId || 'ALL'}`);
  console.log(`  Topic: ${topic || 'ALL'}`);
  console.log(`  Dry run: ${dryRun}`);
  console.log('');

  // Fetch pending messages
  const pending = await dlqService.listPending(tenantId);
  const filtered = topic
    ? pending.filter(m => m.originalTopic === topic)
    : pending;

  console.log(`Found ${filtered.length} pending DLQ messages`);

  if (filtered.length === 0) {
    console.log('Nothing to replay.');
    process.exit(0);
  }

  if (dryRun) {
    for (const msg of filtered) {
      console.log(`  [DRY RUN] Would replay: ${msg.id} | topic=${msg.originalTopic} | tenant=${msg.tenantId}`);
    }
    process.exit(0);
  }

  let succeeded = 0;
  let failed = 0;

  for (const msg of filtered) {
    try {
      // Reset the event processing ledger entry so the event can be re-claimed
      const eventPayload = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
      if (eventPayload?.event_id && eventPayload?.tenant_id) {
        await pool.query(
          `UPDATE event_processing_ledger
           SET status = 'failed', updated_at = NOW()
           WHERE tenant_id = $1 AND event_id = $2 AND status != 'completed'`,
          [eventPayload.tenant_id, eventPayload.event_id]
        );
      }

      const result = await dlqService.manualRetry(msg.id);
      if (result.success) {
        console.log(`  [OK] Replayed: ${msg.id}`);
        succeeded++;
      } else {
        console.log(`  [FAIL] ${msg.id}: ${result.error}`);
        failed++;
      }
    } catch (error) {
      console.log(`  [ERROR] ${msg.id}: ${(error as Error).message}`);
      failed++;
    }
  }

  console.log('');
  console.log(`Replay complete: ${succeeded} succeeded, ${failed} failed out of ${filtered.length}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
